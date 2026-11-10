# Overdrive | Current AWS Architecture

Companion to [overdrive-current-aws-architecture.drawio](overdrive-current-aws-architecture.drawio), a single-page diagram. It shows everything the pipelines deploy, plus the AgentCore-based automated ticket flow, which is defined in code but not activated (grey dashed lane under the AgentCore harnesses).

There are two AgentCore agents (harnesses): **Agent 1** handles text support and **Agent 2** handles visual support. The ticket-action flow reuses Agent 1; it is not a third agent.

The diagram is derived from the repository itself: `infra/cloudformation/*.yml`, `infra/analytics/*.tf`, `scripts/deploy/lib.mjs` (stack regions), `.github/workflows` and `backend/src`. Resource names, account IDs and endpoints are deliberately left out. Icons come from draw.io's current AWS library (`mxgraph.aws4`, the successor of the "AWS19" set); none come from the superseded AWS17/AWS18 sets or the retired palette. QuickSight uses the QuickSight icon. The Knowledge Base, Nova Lite, both AgentCore harnesses and the AgentCore Gateway use the Amazon Bedrock icon (AgentCore and Nova are Bedrock services), and EventBridge Scheduler uses the EventBridge icon. All of these icons have been in the library for years, so none of them renders as a plain coloured square in older draw.io versions.

## Regions

| Scope | What runs there |
| --- | --- |
| Global edge | CloudFront distribution and its optional WAF web ACL |
| `eu-north-1` (Stockholm) | Frontend bucket, Cognito user pool, Bedrock Knowledge Base, AgentCore harnesses, Nova Lite, the external customer dashboard API, the existing diagnostics Step Functions workflow |
| `us-east-1` (N. Virginia) | Ticket API, ticket data and backups, ticket events and notifications, visual support, advisor analytics, the (inactive) ticket gateway |

Photos are stored and analysed in `us-east-1`, while KB retrieval, harness calls and Nova Lite inference run in `eu-north-1`. That flow crosses the US/EU boundary and needs data-residency approval before real customer use.

## Flows

1. **Sign-in.** The browser signs in through Cognito managed login (authorization code + PKCE). Every API Gateway in the diagram validates the Cognito access token with a JWT authorizer.
2. **Web app.** CloudFront serves the React SPA from a private S3 bucket (origin access control) and forwards `/api/*` to the API Gateway HTTP API with an origin-verify header.
3. **Customer profile.** The browser reads the customer profile from the external customer dashboard API. The API Lambda calls the same API to check VIN ownership before a ticket is created.
4. **Assistant (Agent 1).** The API Lambda applies the safety rules (and the optional Bedrock triage classifier, `TriageModelArn`) first. Critical or high-priority concerns skip the KB and go straight to an urgent ticket offer. Otherwise it retrieves approved passages from the Bedrock Knowledge Base and calls the AgentCore text harness (Agent 1; model set by `AGENTCORE_MODEL_ID`, Nova Lite in the current deployment). Answers are accepted only if they cite retrieved passages. Resolved questions are saved in the interactions table. A ticket is created only when the customer submits the Create request page or reports the guidance unresolved; the model never creates one on its own in the active path.
5. **Tickets.** The API Lambda writes tickets to DynamoDB and issues presigned URLs for the private evidence bucket. It publishes nothing itself: every side effect follows from the tickets table stream (flow 10).
6. **Visual support (Agent 2).** The browser calls the separate `/visual/*` HTTP API. The visual API Lambda first gets KB-grounded guidance from the visual harness (Agent 2), then presigns an upload into the versioned quarantine bucket. GuardDuty Malware Protection scans each object and tags it.
7. **Analysis.** A DynamoDB stream on the visual sessions table triggers the analysis worker. It reads only the scanned object version, calls Rekognition (labels, text) and Nova Lite image understanding, and then gets cited guidance from the KB and the visual harness. Failed stream batches go to an encrypted SQS failure queue.
8. **Confirmation.** When the customer confirms, the visual API Lambda creates the ticket (title, description, AI summary and the full photo analysis) and updates the session in one DynamoDB transaction, and copies the verified photo versions into the evidence bucket. Because the ticket lands in the tickets table, it gets the same alerts, emails and workflow start as any other ticket (flow 10).
9. **Advisor analytics.** DynamoDB Streams from the tickets, interactions and visual sessions tables feed the analytics consumer Lambda. It redacts the records and sends them to Data Firehose, which writes Parquet to a private S3 lake. The Glue Data Catalog uses partition projection, Athena queries the lake, and QuickSight datasets back the advisor dashboard. The API Lambda issues a reader embed URL, and advisors view the dashboard embedded in the app. Failed batches go to SQS, and CloudWatch alarms watch the pipeline.
10. **Ticket events.** The tickets table stream triggers the ticket-events Lambda, which turns each change into a domain event (`TicketCreated`, `TicketAssigned`, `TicketStatusChanged`, `TicketResolved`, `TicketMessageAdded`) on the EventBridge default bus. Internal notes produce no event, and events carry IDs, status, priority and category only. Records are retried in order for 24 hours.
11. **Advisor alerts.** The alert rule (new tickets, customer replies) publishes a short message to the KMS-encrypted SNS topic, which emails the subscribed advisor inbox.
12. **Ticket actions.** The actions rule (new tickets and advisor-side changes) sends the event to an SQS queue, consumed by the ticket-actions Lambda. For a new ticket with a VIN it starts the existing diagnostics Step Functions workflow in `eu-north-1` once (execution name = ticket ID). For customer-facing changes it looks up the customer's verified email in Cognito and sends an SES email with the status and a sign-in link, never ticket content. Customer emails stay off until a verified SES sender is configured.
13. **Failures.** Stream records older than 24 hours, undeliverable rule targets and messages that fail five times land in one SQS dead-letter queue with a CloudWatch alarm.
14. **Backups.** Both ticket tables have point-in-time recovery. EventBridge Scheduler also starts a full `ExportTableToPointInTime` of the tickets and interactions tables every day at 02:00 UTC into a private, encrypted backup bucket; exports expire after 35 days.

## Agent ticket flow (grey lane, defined but not activated)

`infra/cloudformation/ticket-gateway.yml` and `backend/src/agent-tools` define an automated path where an AgentCore harness creates and handles tickets through an MCP gateway. It reuses the existing ticket logic and tables; nothing is duplicated.

1. **Sign-in.** The customer or advisor has a Cognito access token.
2. **Request.** The web app calls `POST /agent/ticket-action` on a separate HTTP API (Cognito JWT authorizer). It does so only when `VITE_AGENT_TICKET_API_URL` is set. Today the frontend uses it for `create_ticket` from the Create request and Visual support pages, without attachments; otherwise it uses `/api/tickets` and the visual confirm route.
3. **Broker.** The action broker Lambda re-verifies the token and the role per operation: creating is customer-only, updating and assigning are advisor-only. It runs the safety rules (urgent tickets count as confirmed) and requires confirmation and `EnableTicketWrites=true` for any write. It then calls `InvokeHarness` on the text harness (Agent 1) in `eu-north-1` (Nova Lite, at most two iterations, temperature 0) and allows only the one tool `ticketbackend___<operation>`.
4. **MCP call.** The harness calls the AgentCore Gateway (`us-east-1`) with the user's token and headers carrying the approved operation, the SHA-256 of the validated payload and the request ID.
5. **Interceptor.** The gateway validates the Cognito JWT (`CUSTOM_JWT`). Its REQUEST interceptor Lambda re-checks the token, role, operation, payload hash and write policy, and injects trusted context.
6. **Target.** The gateway invokes the ticket tools Lambda with its own IAM role. The target exists only when `EnableTicketTarget=true`.
7. **Ticket logic.** The tool Lambda checks the gateway ID and tool name, then runs the API's ticket handlers in-process:
   - VIN ownership through the customer dashboard API
   - an idempotent conditional write to the tickets table
   - nothing else: alerts, emails and the workflow follow from the tickets stream, exactly like `POST /api/tickets`

   Tickets from a visual session are forwarded to the visual API's `POST /visual/sessions/{id}/confirm` instead.
8. **Receipt.** The result returns through the gateway and harness. The broker accepts only a registered tool result whose ticket ID, VIN and owner match the approved input, then returns 201 or 200. Model prose never counts as a saved ticket.

Activation is gated: `EnableTicketTarget` and `EnableTicketWrites` default to `false`. All three Lambdas start as denying placeholders until `npm run build:ticket-tools -w @servicecare/api` is published to them. `VITE_AGENT_TICKET_API_URL` stays unset until live read-only and write tests pass. See [deployment.md](deployment.md#isolated-ticket-gateway-local-not-activated).

## Services

| Service | Purpose | Defined in |
| --- | --- | --- |
| CloudFront, AWS WAF (optional) | SPA delivery, `/api/*` routing, security headers; existing web ACL attached by `WebAclArn` | `frontend-hosting.yml` |
| S3 (web assets) | Private SPA bucket behind origin access control | `frontend-hosting.yml` (existing bucket) |
| Cognito | Customer and advisor identity, managed login | Existing user pool; app client in `frontend-hosting.yml` |
| API Gateway HTTP API (`/api/*`) | JWT-protected ticket and assistant API | `backend-lambda-platform.yml` |
| Lambda (API) | Hono API: tickets, assistant, attachments, QuickSight embed | `backend-lambda-platform.yml`, `backend/src` |
| DynamoDB (tickets, interactions) | Tickets and resolved self-service history, streams and point-in-time recovery enabled | `backend-lambda-platform.yml` |
| EventBridge Scheduler, S3 (backups) | Daily full exports of both ticket tables, 35-day expiry | `backend-lambda-platform.yml` |
| S3 (evidence) | Private ticket attachments and archived photos | `backend-lambda-platform.yml` |
| Lambda (ticket events) | Tickets stream to EventBridge domain events | `backend-lambda-platform.yml`, `backend/src/events/stream.ts` |
| EventBridge (default bus, 2 rules) | Alert rule to SNS; actions rule to SQS | `backend-lambda-platform.yml` |
| SNS + KMS | Advisor alerts (IDs, priority, category) | `backend-lambda-platform.yml` |
| SQS (ticket actions queue, dead-letter queue + alarm) | Buffered ticket actions; one place for every failure | `backend-lambda-platform.yml` |
| Lambda (ticket actions), SES | Diagnostics workflow start, customer status emails | `backend-lambda-platform.yml`, `backend/src/notifications/worker.ts` |
| Step Functions | Existing diagnostics workflow in `eu-north-1`, owned by another team | External (`TriageWorkflowArn`) |
| Customer dashboard API | Customer profile and vehicles | External, `eu-north-1` |
| Bedrock Knowledge Base | Approved service guidance | Existing (`KnowledgeBaseId`) |
| AgentCore harnesses | Agent 1, text support (existing), and Agent 2, visual guidance | Existing; `visual-agent.yml` |
| Amazon Nova Lite | Image understanding through Converse, harness model | Model access in `eu-north-1` |
| API Gateway HTTP API (`/visual/*`), Lambda (visual API, worker) | Visual sessions, presign, analysis, confirmation | `visual-support.yml` (container images from a pre-created ECR repository) |
| DynamoDB (visual sessions) | Session state, stream to the worker and analytics | `visual-support.yml` |
| S3 (quarantine photos), GuardDuty | Versioned uploads, malware scan tags | `visual-support.yml` |
| Rekognition | Labels and text detection | `visual-support.yml` (worker IAM) |
| SQS (stream failure queue) | Failed visual stream batches | `visual-support.yml` |
| Lambda (analytics consumer), Data Firehose, S3 lake, Glue, Athena, CloudWatch alarms, SQS | Redacted analytics pipeline | `infra/analytics` (Terraform) |
| QuickSight | Datasets and the advisor dashboard | `analytics-platform.yml` |
| AgentCore Gateway, Lambda (broker, interceptor, tools), HTTP API | Automated ticket actions, not activated | `ticket-gateway.yml`, `backend/src/agent-tools` |

Not drawn: the state bucket and lock table for the analytics Terraform (`terraform-state.yml`), log groups, IAM roles and the deploy roles.

## Design decisions

- **Safety before AI.** Safety rules run before retrieval, and critical concerns never reach a model or the photo flow.
- **Grounded or nothing.** Text and visual guidance must cite retrieved KB passages. Otherwise the customer is offered advisor review.
- **Scan before analysis.** Only a GuardDuty-tagged clean object version is passed to Rekognition or Nova Lite.
- **One ticket path, one event source.** Every `/api/*` route targets the API Lambda, and the agent tools run the same handlers. All side effects come from the tickets stream, so API, visual and agent tickets behave the same, and a failed alert or email is retried instead of lost.
- **The model never decides.** In the agent flow the backend approves the operation and payload before the model runs, every hop re-checks them, and only a backend receipt counts as success.
- **Minimal data in events, emails and analytics.** Events and alerts carry IDs, status, priority and category. Customer emails carry the status and a sign-in link. Analytics stores hashed IDs and operational fields, never customer text.
- **Inactive by default.** The ticket gateway's target and writes stay disabled until live identity, ownership and receipt checks pass.
