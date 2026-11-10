# AWS Deployment Runbook

## Overview

The web app is served by CloudFront from a private S3 bucket in `eu-north-1`; `/api/*` goes to an API Gateway HTTP API and a Node.js 22 Lambda in `us-east-1`. Ticket side effects follow from the tickets table stream (see [Ticket events, notifications and backups](#ticket-events-notifications-and-backups)): advisor alerts, customer emails and an optional diagnostics workflow (Step Functions). The customer profile reads vehicles from a separate JWT-protected customer dashboard API (`CustomerDashboardUrl` / `VITE_CUSTOMER_DASHBOARD_URL`); its CORS allowlist must include the site origin and `http://localhost:5173`.

If the hosting stack is pointed at an existing bucket that already has a policy, import that policy into the stack first; creating it directly fails with "The bucket policy already exists". The app client also has `AWS::Cognito::ManagedLoginBranding` with default values; without it, the managed-login pages report "Login pages unavailable".

## Agent Tools and Advisor Analytics

### Agent Ticket Gateway (Inactive by Default)

The ticket gateway is separate from the knowledge gateway and the harness defaults. [ticket-gateway.yml](../infra/cloudformation/ticket-gateway.yml)
defines its own Cognito-JWT gateway, request interceptor, Lambda ticket adapter and HTTP
action broker. No ticket database is duplicated: operations reuse the existing ticket
repository and backend authorization/state-transition logic. The tool function only writes
the ticket; advisor alerts, customer emails and the diagnostics workflow follow from the
tickets table stream, exactly as for `POST /api/tickets`. Visual-session tickets are
forwarded to the visual API's confirm route.

The tools are `create_ticket`, `get_ticket`, `update_ticket` and `assign_advisor`. Create
requires a customer-owned VIN; get is owner/advisor scoped; status/priority changes and
assignment are advisor-only and version checked. Assignment is to the authenticated
advisor, not an identity selected by the model. The interceptor binds a verified access
token to a confirmed operation and hash of validated input. The adapter verifies the
token again. Ticket creation retries use an owner-scoped request ID; changing the
approved payload with that ID produces a conflict rather than another ticket.

The action runner supplies only the permitted remote MCP tool for that invocation; it
does not change the deployed harness's default tool list. It accepts only a successful
registered tool result with a backend receipt, not model prose. Retrieved/updated ticket
IDs and created-ticket VINs must match the approved input, and customer receipts must
belong to that customer. Error-marked results cannot count as success. Local regression
tests cover forged context, changed intent, customer mutation attempts, duplicate writes,
private notes, wrong-ticket receipts and model-only ticket claims.

`EnableTicketTarget=false` and `EnableTicketWrites=false` are the template defaults.
Deploying the stack alone exposes no ticket target; all three Lambda bodies start as
denying placeholders until validated code is published. After separate deployment
approval, build `npm run build:ticket-tools -w @servicecare/api`, publish the resulting
bundle to the interceptor/tool/broker functions, and set `ExpectedGatewayId` and
`TicketGatewayUrl` from the stack outputs. Only then enable the target for read-only
authenticated tests, while keeping writes false. Verify actual Cognito identity propagation,
MCP event/receipt shapes, owner isolation and denied mutation attempts before enabling
confirmed writes. These live gateway checks are not proven by local mocks.

`VITE_AGENT_TICKET_API_URL` opts the frontend into the broker. Leave it unset until those
tests pass; existing request creation then remains unchanged. Normal service requests still require customer confirmation; critical concerns
may trigger deterministic urgent escalation but never bypass ownership or write policy.

Image paths remain distinct. A chat attachment starts as a local preview, not an S3 upload.
Ordinary ticket attachment submission uploads to the private evidence bucket and does not
automatically invoke the vision model. Explicit visual support uploads to the quarantine
bucket, waits for the pinned version's malware scan, obtains Rekognition/Nova Lite evidence,
and sends text observations to the KB harness. Confirmation archives verified photos and
stores the analysis/references with the ticket. The new local visual confirmation code
requires an owned VIN and rejects altered confirmation retries; it must be released before
those safeguards apply to the deployed visual API. The prior live synthetic test confirmed
an advisor could retrieve the stored JPEG/analysis and an unrelated customer was denied;
real-customer image and gateway write journeys remain manual/live-test gates.

Verified Gateway usage pricing is $0.000005 per invocation: 1,000 invocations cost $0.005
for Gateway only. Lambda, model tokens, runtime/memory, storage, notifications, logs and
transfer are additional. The $5/month light-test allowance is a planning budget, not a cap
or an approval to activate writes. See the local/deployed sections before release.

Advisor analytics uses DynamoDB Streams (tickets, interactions, visual sessions) → Lambda `servicecare-analytics-consumer` (redaction) → Firehose → private S3 Parquet → Glue `overdrive.ticket_events` (partition projection) → Athena → QuickSight datasets/dashboard. All of this except the QuickSight datasets/dashboard is Terraform (`infra/analytics`). Firehose buffers up to five minutes. Analytics excludes customer IDs, titles, descriptions, assistant questions/answers and advisor identifiers; it stores hashed record IDs, operational categories/statuses, timestamps and resolution flags only. Streams capture only new changes; existing rows were backfilled once by replaying a table scan as synthetic INSERT records into the consumer Lambda. The QuickSight service role needs read access to the analytics bucket (inline policy `ServiceCareAnalyticsRead`).

The embed API is advisor-only. It returns a short-lived URL; no AWS credentials reach the browser. The API Lambda role is registered as QuickSight READER `servicecare-advisor-embed` (IAM identity) and `QUICKSIGHT_EMBED_USER_ARN` selects registered-user embedding, which needs no session-capacity plan (reader sessions are billed per QuickSight pricing). Without that variable the API falls back to anonymous embedding, which requires capacity pricing.

The embed API is advisor-only. It returns a short-lived URL for the configured dashboard and hosted domain; no AWS credentials or QuickSight session tags reach the browser. The initial dashboard is aggregate-only, so all authorized advisors see the same metrics. The QuickSight account currently has no dashboard and reports `ACCOUNT_CREATED`; anonymous embedding requires session capacity, currently priced from $250/month for 500 sessions. AgentCore chat was enabled by the separately approved scoped update described below; analytics changes were not part of that update.

The customer panel does not embed this shared aggregate dashboard: it uses the Cognito-scoped ticket, conversation and overview APIs so one customer's records cannot be exposed to another customer.

### Conversation-Aware Troubleshooting

The chat now renders a sent message immediately and an accessible three-dot typing state
while a request is in flight. Initial routine guidance offers Resolved/Still unresolved,
not a ticket CTA. A follow-up retains the original concern and up to two previously tried
answers. The harness is asked for distinct steps supported by the retrieved passages;
near-identical returned text is rejected. One initial answer and one alternative are allowed;
another unresolved confirmation offers advisor review without another KB retrieval.
No approved guidance and service unavailability are distinct outcomes, not invented answers.

Text answers originate from Bedrock Knowledge Base Retrieve (or the composite
RetrieveAndGenerate path), followed by harness generation. An `s3://` citation is the
indexed source document's location, not a direct S3 GetObject request by the chat. The UI
labels KB provenance and does not display raw bucket paths. The photo-analysis pipeline
has separate S3 reads; it is now an explicit option after unresolved troubleshooting and
is not restarted by the standard ticket CTA.

Matching query responses are cached within the chat component for five minutes. KB passages
are cached for five minutes in a warm backend process with owner/config/KB-scoped keys and
a 100-entry bound; this is not a durable cache across Lambda cold starts. Failed requests
are not cached. A different selected topic resets issue context. Critical/HIGH/CRITICAL
messages bypass KB troubleshooting and open the urgent request form with the latest details.
Actual ticket submission still requires a customer-owned VIN and confirmation; no VIN or
roadside dispatch is invented. Non-critical tickets are offered only after unresolved or
unsupported guidance, with tried guidance included in the draft.

### Advisor Analytics

The analytics consumer (`servicecare-analytics-consumer`, Terraform in `infra/analytics`) reads the tickets and interactions streams. Streams do not backfill: replay existing rows once into the consumer Lambda before dashboards show lifetime totals.

Safe deployment order (review every change set):

1. `npm run deploy:infra -- backend --plan-only --advisor-email <approved-team-inbox>`, review, then run the same command without `--plan-only`. This adds the interactions index/update permissions, the QuickSight dashboard setting and the optional confirmed SNS subscription to the existing stack. Omit `--advisor-email` until an approved recipient is chosen.
2. Push backend source. The Backend workflow publishes the API, ticket-events and ticket-actions Lambdas; it does not touch the analytics consumer.
3. Run `npm run build:analytics -w @servicecare/api`, then plan, review and apply the Terraform in `infra/analytics` (stream mappings, consumer Lambda `servicecare-analytics-consumer`, Firehose, S3 lake, Glue, Athena, failed-batch queue and alarms). Terraform packages the consumer from `backend/dist/analytics/index.cjs`. Replay existing rows once, as described above.
4. `npm run deploy:infra -- analytics --plan-only`, review, then `npm run deploy:infra -- analytics`. This CloudFormation stack (`servicecare-analytics`) holds only the QuickSight datasets and dashboard `servicecare-advisor-analytics`, reading the existing Athena data source (`QuickSightDataSourceId`). Optional `QuickSightOwnerArn` grants an author access. The dashboard embed also needs QuickSight session capacity.
5. Register the QuickSight reader user for the API role (`aws quicksight register-user --identity-type IAM --iam-arn <ApiFunctionRole> --session-name servicecare-advisor-embed --user-role READER --email <email>`).
6. Only for anonymous embedding, an administrator must enable QuickSight anonymous session capacity. To receive advisor alerts, set `AdvisorNotificationEmail` to an approved team inbox; the recipient must confirm the SNS subscription.

Estimated added monthly cost at low volume is dominated by QuickSight reader sessions; Firehose, S3, Athena and Lambda are a few dollars at low volume. Anonymous capacity (/month) is not required. These are usage assumptions, not a billing cap.

## Pipelines and Releases

```text
frontend/**  ──► Frontend pipeline ──► S3 (private) ──► CloudFront (+ WAF) ──► browser
                                                          │  /api/*
backend/**   ──► Backend pipeline  ──► Lambda: API, ticket-events, ticket-actions ◄── API Gateway HTTP API
```

| Pipeline | Starts when a push to `main` or a pull request changes | Result |
| --- | --- | --- |
| Frontend (`.github/workflows/frontend.yml`) | `frontend/**`, `packages/contracts/**`, root `package.json`, `package-lock.json`, `tsconfig.base.json`, its own workflow | Typecheck, tests, build; on `main`: sync to S3, invalidate CloudFront, smoke test |
| Backend (`.github/workflows/backend.yml`) | `backend/**`, `scripts/deploy/**`, the same shared files, its own workflow | Typecheck, tests, every backend bundle; on `main`: `node scripts/deploy.mjs backend` |

Markdown files never start a pipeline, so a documentation change does not redeploy anything. Shared files (the root lockfile, `tsconfig.base.json` and `packages/contracts`) start both. Verification (typecheck, tests, builds) runs on GitHub-hosted runners for every push and pull request. The deploy job runs only for `main`, and only when the repository variable `AWS_DEPLOY_ENABLED` is `true`, so a fork or a fresh clone never tries to reach AWS.

**Credentials.** The deploy job exchanges GitHub's OIDC token (issuer `token.actions.githubusercontent.com`) for the stack's deploy role, which trusts only this repository's `main` branch (`GitHubRepository` parameter). No AWS keys are stored in GitHub. The account needs the GitHub OIDC identity provider, and the repository needs the variables `AWS_DEPLOY_ENABLED=true` and `AWS_ACCOUNT_ID`.

### Releasing and checking

The pipelines and anyone releasing by hand run the same code, `scripts/deploy.mjs`, so a developer's rehearsal is what CI does. Hand-run commands need Node 22+, the AWS CLI, git and credentials for the target account.

| Command | What it does |
| --- | --- |
| `npm run deploy:status` | Read-only report: the code size and update state of each backend Lambda (a placeholder is flagged), the tickets stream mapping, live `/api/health` and `/api/tickets` (401), and each stack's status |
| `npm run deploy:infra -- <backend\|frontend\|state\|analytics>` | Validates the template, creates a CloudFormation change set, prints it, asks for confirmation, then executes that same change set. `--plan-only` previews and deletes it; `--yes` skips the question. Backend only: `--advisor-email`, `--customer-email-sender` |
| `npm run deploy:backend -- --check` | Runs every preflight check, lists all failures and changes nothing |
| `npm run deploy:backend` | Preflight, build, zip and publish the API, ticket-events and ticket-actions Lambdas, wait for each update and verify its code hash, then check `/api/health` (200) and `/api/tickets` without a token (401) |
| `npm run deploy:frontend` | Preflight, build with the stack's Cognito settings, publish to S3 (`index.html` last), invalidate CloudFront, smoke test |

Checks run first, and a failure stops the release before anything changes:

- **Identity.** The account must be `AWS_ACCOUNT_ID` (the placeholder in `scripts/deploy/lib.mjs` is AWS's example ID). In the pipeline the identity must be the stack's deploy role, so a failed token exchange can never fall back to developer credentials stored on the runner.
- **Source (hand-run only).** The working tree is clean and `HEAD` is `origin/main`. Type checks and tests run too.
- **Platform stack.** The stack is `CREATE_COMPLETE` or `UPDATE_COMPLETE` and has every function output the release needs (`ApiFunctionName`, `TicketEventsFunctionName`, `TicketActionsFunctionName`). Apply the stack before releasing code that needs it.

Lambda updates are serialized by Lambda itself (`update-function-code` is refused while an update is in progress), and the pipeline runs one backend job at a time (`concurrency: backend-deploy`), so no release lock is needed.

### Stacks

| Template | Stack | Region | Creates |
| --- | --- | --- | --- |
| `frontend-hosting.yml` | `servicecare-frontend` | `eu-north-1` | CloudFront distribution with a private S3 origin (OAC), SPA routing function, security headers, optional WAF web ACL, the `/api/*` route to the backend HTTP API, a Cognito app client on the existing pool, the frontend deploy role |
| `backend-lambda-platform.yml` | `servicecare-backend` | `us-east-1` | HTTP API with Cognito JWT authorizer, API Lambda, tickets and interactions tables (streams, PITR), evidence bucket, ticket event pipeline (stream Lambda, EventBridge rules, KMS-encrypted SNS advisor topic, ticket actions queue and Lambda, dead-letter queue and alarm), backup bucket with EventBridge Scheduler exports, the backend deploy role |
| `analytics-platform.yml` | `servicecare-analytics` | `us-east-1` | QuickSight datasets and the advisor dashboard (the pipeline itself is Terraform in `infra/analytics`) |
| `terraform-state.yml` | `servicecare-terraform-state` | `eu-north-1` | State bucket and lock table for the analytics Terraform (`infra/environments/analytics-backend.hcl`) |
| `visual-agent.yml`, `visual-support.yml` | separate | `eu-north-1`, `us-east-1` | Visual harness; visual API, worker, quarantine bucket and sessions table (see [Visual Support](#visual-support)) |
| `ticket-gateway.yml` | separate | `us-east-1` | Inactive agent ticket gateway (see above) |

Data resources (tables, buckets) are retained on stack deletion. Review every change set: `npm run deploy:infra -- <stack> --plan-only`.

### First-time creation

`deploy:infra` updates existing stacks only. To create them in a new account (this creates billable resources), with credentials for that account and an existing Cognito user pool:

```bash
token=$(openssl rand -hex 24)
pool=eu-north-1_XXXXXXXXX        # your user pool ID
domain=your-hosted-ui-prefix     # its Cognito domain prefix
aws cloudformation deploy --region eu-north-1 --stack-name servicecare-frontend \
  --template-file infra/cloudformation/frontend-hosting.yml --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides UserPoolId=$pool UserPoolDomainPrefix=$domain GitHubRepository=<owner>/<repo>
out() { aws cloudformation describe-stacks --region "$1" --stack-name "$2" --query "Stacks[0].Outputs[?OutputKey=='$3'].OutputValue" --output text; }
web=$(out eu-north-1 servicecare-frontend WebUrl); client=$(out eu-north-1 servicecare-frontend CognitoClientId)
aws cloudformation deploy --region us-east-1 --stack-name servicecare-backend \
  --template-file infra/cloudformation/backend-lambda-platform.yml --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides OriginVerifyToken=$token WebOrigin=$web CognitoUserPoolId=$pool CognitoClientIds=$client \
    CustomerDashboardUrl=https://<dashboard-api>/customer/dashboard GitHubRepository=<owner>/<repo>
api=$(out us-east-1 servicecare-backend ApiGatewayDomainName)
aws cloudformation deploy --region eu-north-1 --stack-name servicecare-frontend \
  --template-file infra/cloudformation/frontend-hosting.yml --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides ApiOriginDomainName=$api OriginVerifyToken=$token
AWS_ACCOUNT_ID=<account> npm run deploy:backend
AWS_ACCOUNT_ID=<account> npm run deploy:frontend
```

The three backend functions start as placeholders. The ticket-events and ticket-actions placeholders fail on purpose, so stream records and queued actions wait (up to 24 hours and 4 days) for the first `deploy:backend` instead of being dropped.

### Users, roles and sign-in

The frontend authenticates existing users directly on the Overdrive login page using
Cognito SRP through Amplify Auth and the hosting stack's app client **servicecare-frontend-web**
(`CognitoClientId` output). The managed-login branding remains available for OAuth
callbacks, but the form does not redirect to it. Email/password sign-in, invited-user
temporary-password activation, MFA/confirmation codes and password recovery remain in the
same page. Successful access/ID tokens are handed to the existing session manager, so API
authorization and page reloads use the same session. Account-type buttons never assign a
role: it comes from Cognito token groups. The shared pool remains **invite-only**; Activate
invited account does not create a new public account.

The API accepts Cognito **access tokens** and checks them itself (signature, expiry, issuer, token use and app client). Group `CUSTOMER` (or `Customers`) is a customer; `ADMIN`, `Admins`, `ServiceAdvisors` or `Advisors` is an advisor. Add users to those groups in Cognito. The pool is invite-only. The new app client allows sign-in from the new URL, the older URL and `http://localhost:5173`, with sign-out to `/login`. To sign in locally against the real pool, put `VITE_DEMO_MODE=false`, `VITE_COGNITO_AUTHORITY`, `VITE_COGNITO_DOMAIN` and `VITE_COGNITO_CLIENT_ID` (the `Cognito*` stack outputs) in an ignored `frontend/.env`.

### Verifying the triggers

1. Edit a file in `frontend/src` and push to `main`: only **Frontend** runs.
2. Edit a file in `backend/src`: only **Backend** runs.
3. Edit `README.md` or `docs/`: neither runs.
4. Edit `package-lock.json` or `packages/contracts`: both run.

### Operating it

- **See what is deployed:** `npm run deploy:status`.
- **Roll back the API:** revert the commit and let the pipeline release it, or run `npm run deploy:backend` from a checkout of the earlier commit (hand-run releases require it to be `origin/main`, so revert first).
- **Configuration changes** (environment variables, memory, parameters) go through the stack with `deploy:infra`; code is untouched.
- **A ticket alert or email did not arrive:** check the DLQ alarm, then the ticket-events and ticket-actions log groups (`/aws/lambda/servicecare-backend-ticket-events`, `-ticket-actions`).
- **Cost drivers:** Lambda, API Gateway, DynamoDB on demand, PITR and daily exports, S3 storage and log storage; SES and SNS are cents at this volume. Budget alarms are not included.

### Limits to know about

- Tickets and attachments are stored in `us-east-1` while Cognito and the site are in Stockholm. Moving the backend means deploying `backend-lambda-platform.yml` in `eu-north-1` and changing its region in `scripts/deploy/lib.mjs` and `.github/workflows/backend.yml`.
- Bedrock Knowledge Base and model parameters only work for resources in the backend's own region, except the AgentCore and KB calls the API makes to Stockholm explicitly.
- CloudFront access logs are not enabled; Lambda logs go to CloudWatch with `LogRetentionDays`.
- The older distribution shares the bucket, so it serves the new build too, and sign-in is allowed from it. It has no `/api/*` route and no deep-link routing, so the app is only fully usable at the new URL. Retire the older distribution once everyone has moved, then redeploy the hosting stack with `LegacyDistributionId=` and `LegacyOrigin=` (empty values).

## Ticket Events, Notifications and Backups

```text
API / visual confirm / agent tools ──► tickets table ──stream──► ticket-events Lambda ──► EventBridge (default bus, source servicecare.ticket)
   AdvisorAlertRule  (TicketCreated, customer TicketMessageAdded) ──► SNS (KMS) ──► advisor email
   TicketActionsRule (TicketCreated, Assigned, StatusChanged, Resolved, advisor TicketMessageAdded) ──► SQS ──► ticket-actions Lambda
        ├─ TicketCreated with a VIN ──► diagnostics Step Functions workflow (eu-north-1), execution name = ticket ID
        └─ customer-facing change   ──► Cognito (verified email) ──► SES email "sign in to view"
Failures (stream after 24 h, rule targets, 5 queue receives) ──► ticket events DLQ ──► CloudWatch alarm
EventBridge Scheduler (daily 02:00 UTC) ──► DynamoDB ExportTableToPointInTime ──► backup bucket (tickets/, interactions/)
```

- **One source of events.** No writer publishes anything. Every ticket write, whichever path made it, lands in the tickets table, and the stream turns it into `TicketCreated`, `TicketAssigned`, `TicketStatusChanged`, `TicketResolved` or `TicketMessageAdded` (`backend/src/events/stream.ts`). Internal advisor notes produce no event. Events carry IDs, status, priority and category only, never descriptions, messages, VINs or contact details.
- **Retries, not losses.** The stream mapping retries a failed record in order until it is 24 hours old, then records it in the DLQ. Rule targets retry for 24 hours. The ticket actions queue retries five times. Starting the workflow is idempotent (execution name = ticket ID; `ExecutionAlreadyExists` counts as done).
- **Advisor alerts.** Subscribe an approved team inbox with `npm run deploy:infra -- backend --advisor-email <address>` and confirm the subscription email. The alert text is "ServiceCare TicketCreated: ticket …, priority …, category …".
- **Customer emails.** Off until a sender is set. Verify a sender address or domain in Amazon SES in `us-east-1`, then `npm run deploy:infra -- backend --customer-email-sender <address>`. While the SES account is in the sandbox, each recipient must be verified too; request production access before real customers. Emails go only to a Cognito-verified address and contain the status and a sign-in link, nothing from the ticket.
- **Diagnostics workflow.** `TriageWorkflowArn` (empty disables it) receives `{vin, ownerId, customerIssue}` for each new ticket with a VIN.
- **Dead letters.** `TicketEventsDeadLetterQueueUrl` is the one place to look. Stream failures there are metadata (shard and sequence range), so replay them by re-saving the ticket; rule-target and queue failures are the full event. Ticket-action failures (message attribute `RULE_ARN` is the ticket actions rule, or absent after five queue receives) can be redriven to the ticket actions queue with **Start DLQ redrive** in the SQS console; advisor-alert failures are a record of an alert that was not sent.
- **Backups.** Point-in-time recovery covers 35 days of restore points inside DynamoDB. In addition, two schedules export both tables in full (DynamoDB JSON) to the backup bucket every day (`BackupSchedule`, default `cron(0 2 * * ? *)` UTC); exports expire after `BackupRetentionDays` (default 35). Exports read from PITR and do not consume table capacity. Restore with **DynamoDB → Imports from S3** into a new table. Check the first run under **DynamoDB → Exports to S3**.
- **Two stream readers.** The tickets stream has two consumers, the analytics consumer and ticket-events, which is DynamoDB's recommended maximum per shard. Add a third through EventBridge, not another stream mapping.

## Visual Support

Photo-assisted troubleshooting is an optional, separately deployed feature (`servicecare-visual-agent` in `eu-north-1`, `servicecare-visual-support` in the tickets table's region). Its API allows the CloudFront site and `http://localhost:5173`. For local testing, put the `Cognito*` outputs, `VITE_DEMO_MODE=false`, `VITE_VISUAL_API_URL` and `VITE_API_PROXY_TARGET=<site URL>` in an ignored `frontend/.env.development.local`; use `localhost`, not `127.0.0.1`, because that is the registered callback and CORS origin. No AWS credentials belong in the frontend.

Ask a non-critical question, review KB guidance, choose the unresolved option, upload a
synthetic photo, review the evidence and uncertainties, then explicitly confirm a ticket.
Use synthetic photos only until a privacy review approves real customer images.

The guidance harness has its own AgentCore memory. It is scoped to this
new harness role and each guidance call supplies the server-verified owner as actor/user ID.
Review memory retention before real customer use. API and S3 access logs are enabled;
application logs omit prompts, credentials and images. Checkov passed with 13 documented
dev exceptions for AWS-managed encryption, synchronous API DLQ handling, public AWS
endpoints and the required ECR Public pull token. The stream has an encrypted failure queue.

The new visual feature uses its own routes, Lambda handlers, session table and quarantine
bucket. The ticket-events Lambdas, Step Functions and the text harness are not deployment targets. The existing API and text-assistant builds do not import the new AWS adapter.

The flow is: retrieve approved KB passages, call the separate guidance harness, accept only
citations referencing retrieved passages, then ask whether the concern is unresolved. Only
after that confirmation can photos be uploaded. The worker checks the exact S3 version's
GuardDuty malware tag, normalizes JPEG/PNG/WebP images, calls Rekognition labels/text and
Amazon Nova Lite image understanding, then obtains cited KB guidance for the observations. Missing or
unsafe scan results never reach either image-analysis service. Customer confirmation creates
one ticket with server-stored analysis and archived, version-pinned photos. Safety concerns
cannot upload or invoke image analysis and cannot self-resolve; analysis is evidence, not a diagnosis.

### Regional Nova Lite Configuration

The image LLM is **Amazon Nova Lite**, using `amazon.nova-lite-v1:0` directly
through Bedrock Converse in Stockholm. No alternate image model is invoked on failure. Normalized JPEGs are
limited to five per request and 3,750,000 bytes each. The model must finish normally and
return schema-valid observations; truncated, blocked or malformed results fail closed.
Critical concerns bypass image inference. Knowledge-first guidance, Rekognition,
version-pinned malware checks and confirmed-ticket analysis are retained.

Nova Lite supports IMAGE input and ON_DEMAND invocation in Stockholm, so this direct model invocation needs no cross-region inference. The worker needs only `bedrock:InvokeModel` on Stockholm's Nova Lite foundation-model ARN, supplied by the template. Test data should be **synthetic photos only**. Generated observations are not guaranteed diagnoses: show visible
evidence, explicit uncertainties and cited KB guidance; otherwise request advisor review.

### Separate Deployment

- [visual-agent.yml](../infra/cloudformation/visual-agent.yml): new `BMWVisualService`
  harness and execution role in `eu-north-1`; no tools, bounded tokens and iterations.
- [visual-support.yml](../infra/cloudformation/visual-support.yml): API Gateway JWT API,
  customer API Lambda, worker Lambda, separate roles, session stream, encrypted failure queue,
  private versioned photos and GuardDuty malware protection. Deploy in the **tickets table's
  region**, currently `us-east-1`, so ticket/session writes use one DynamoDB transaction.
  KB retrieval, text-guidance harness calls and Nova Lite inference target Stockholm
  directly. Photos are stored with the worker in `us-east-1`, so image processing
  crosses the US/EU boundary. Obtain data-residency approval before real customer use.
- [visual.Dockerfile](../backend/visual.Dockerfile): separate Linux Lambda image including
  native `sharp`. The API Lambda bundle is unchanged.

`GuidanceModelId` now defaults to regional `amazon.nova-lite-v1:0`, confirmed available for
ON_DEMAND invocation in Stockholm. It receives only the question, retrieved passages and
text observations, never uploaded photos. `ModelResourceArns` on the **harness** template
defaults to its exact regional model ARN. The worker has only the regional Nova Lite
foundation-model permission for image inference. `VisionModelId` is restricted to
`amazon.nova-lite-v1:0`. If guidance
is changed to an `eu.` inference profile, review every destination region it can route to against your data-residency policy.

After model, privacy and cost approval, deploy the harness template and obtain
`VisualHarnessArn` and `VisualRuntimeArn`. Build the visual image with
`docker build --provenance=false -f backend/visual.Dockerfile -t servicecare-visual .`,
then publish it to a dedicated approved ECR repository in `us-east-1`. Supply its immutable
digest as `ImageUri` to the visual stack, along with the live backend's tickets/attachments
outputs, Cognito client IDs, harness outputs and model parameters. These templates do not
create that prerequisite ECR repository. Review change sets before executing either stack;
the visual stack remains a separate deployment and is not created by the frontend pipeline.

`EnableVisualSupport` defaults to `false`.
The explicit OPTIONS route is unauthenticated for browser preflight; application requests
remain JWT-protected. After stack validation, the frontend release reads `VisualApiUrl` from
`servicecare-visual-support` and builds it into `VITE_VISUAL_API_URL`; without that stack
output the photo flow stays disabled. The corrected template allows both the CloudFront
origin and `http://localhost:5173`. Existing ticket details render stored analysis when
present. Rolling back means removing the frontend URL and disabling the stack flag; preserve
ticket evidence and review outstanding worker failures before deletion.

### Costs And Verification

AWS Pricing API rates retrieved on 2026-11-03 for regional
Stockholm Nova Lite ON_DEMAND are $0.000065 per 1,000 input tokens and $0.00026 per 1,000
output tokens. Illustrative 100 sessions x 3 calls x (4,000 input tokens x $0.000065/1,000
+ 1,500 output tokens x $0.00026/1,000) = **$0.195 in model tokens**. Actual image tokens,
response length, retries and memory summaries vary. The unit tests make no paid calls.

GuardDuty S3 prices retrieved from the same API in `us-east-1` are $0.09/GB scanned above
the first 1 GB and $0.000215 per request above the first 1,000 monthly requests. Without
assuming unused free allowances, 100 photos x 2 MB / 1,000 x $0.09 plus 100 x $0.000215
= about **$0.0395 in scanning**, excluding retries. Neither this nor model pricing is a
total: Lambda, Rekognition, API Gateway, DynamoDB/PITR, S3, ECR, logs, runtime/memory, data
transfer and tax add charges.

Pricing methods attempted: AWS pricing service/attribute discovery and AWS Pricing API
queries, followed by a generated partial report. Stockholm AgentCore runtime CPU was quoted
at $0.1276/vCPU-hour ON DEMAND: 1,000 invocations x 10 CPU-active seconds x 1 vCPU / 3,600
x $0.1276 = approximately **$0.35 CPU-only**. This is not a monthly total. Model tokens,
image tokenization, runtime memory/session retention, Rekognition image APIs, GuardDuty,
Lambda, S3, ECR, DynamoDB, API Gateway, logs, transfer and taxes are excluded. The Rekognition
query returned video rates, which were not applied to photos. Model and S3 scan rates were
resolved separately above. The existing KB is reused; no new vector store is created.
Establish a complete production workload estimate and enforced budget controls before
real customer use.

Local gates: `node --import tsx --test backend/tests/visual.test.ts`, workspace typecheck,
existing regression tests, visual bundle build, Linux image build/native-decoder smoke test
and CloudFormation validation. Live gates still required: Cognito customer/advisor ownership,
CORS, cited/unanswerable KB questions, safety escalation, pending/infected scans, oversized
or malformed photos, stream retries/failure queue, confirmed-ticket idempotency, analysis in
ticket details and unchanged regular requests. A dropped stream record goes to the encrypted
failure queue; alarm and replay handling are operational requirements, not automatically
resolved by the UI.

## Invite and Authorize Users

In the existing Cognito user pool (`CognitoUserPoolId`), create/invite test users, and add each to `CUSTOMER` or an advisor group (see above). `Admins` is reserved for administrators. Users are invite-only; there is no public signup or browser-assigned role. Test the first-login password change through the hosted UI. No sample passwords or accounts are provisioned by the templates.

The existing OAuth callback remains `<website origin>/auth/callback` for legacy managed-login sessions. The embedded form uses SRP with no client secret instead of redirecting to hosted login. Its **Forgot password?** control opens an in-page email/code/new-password flow. Sign-out clears the local Amplify and app sessions, then returns to `/login`. A custom deployed origin must use HTTPS; localhost is for development only.

The frontend stores OIDC session data in session storage. Refresh/automatic silent renewal is not implemented; after expiry the customer signs in again. Establish MFA and token-handling policy before production use.

## Connect Approved Knowledge and AI

The stacks intentionally do not create an OpenSearch collection, vector index, Bedrock Knowledge Base or ingestion job. Those require an approved corpus, a region-supported embedding model, a compatible vector store and explicit cost approval. OpenSearch Serverless can dominate a small project's baseline costs. A different supported vector backend is an architecture decision, not a frontend change.

1. Obtain approved, market/model-appropriate FAQs and manuals. Do not treat `knowledge/demo` as official manufacturer material.
2. Upload approved documents to the Knowledge Base's S3 data source.
3. In Bedrock, choose a supported embedding model and vector backend, create the KB and S3 data source, and grant its service role narrowly scoped document/vector access.
4. Run ingestion and verify retrieval on a small test set. Re-ingest after source changes.
5. Enable access to the selected generation/Converse models in the same AWS region. This starter expects directly invocable regional foundation-model ARNs. Cross-region inference profiles require additional destination-model IAM configuration and are not preconfigured.
6. Set `KnowledgeBaseId`, the model parameters and, optionally, `TriageModelArn` on the backend stack with `deploy:infra`; review the change set.
7. Test a referenced answer, an unsupported question, a model failure, a safety concern, and unresolved escalation against the deployed API.

Missing KB configuration returns an explicit advisor-review fallback, not demo FAQs. Without a triage model, conservative rules remain active. Model errors are logged without prompts; the API falls back to ticket creation rather than treating an unverified answer as a resolution.

`bedrock:RetrieveAndGenerate` uses a wildcard resource because the composite API does not expose a resource-scoped IAM target; `Retrieve` is restricted to the configured KB and `InvokeModel` to the supplied model ARNs. Review this against organizational IAM policy before enabling RAG.

## Evidence and Notifications

Verify a customer can upload a JPEG/PNG/WebP/PDF of at most 10 MB, create a ticket with its object reference, and download it only through an authorized ticket read. Try a second customer's object key, an oversized upload, and an unsupported type. S3 enforces the presigned POST policy; Lambda validates metadata and object existence. MIME metadata is not malware detection: add quarantine/scanning before accepting production documents. Abandoned uploads and version retention need a defined lifecycle policy.

Advisor alerts carry ticket IDs, priority and category only; subscribe only an approved advisor inbox and never customers to the shared advisor topic. Customers get individual SES emails instead. Delivery is driven by the tickets stream with retries and a DLQ (see [Ticket events, notifications and backups](#ticket-events-notifications-and-backups)); a failed notification never rolls back a saved ticket.

## Gates Before a Real Demo

- Customer and advisor login using real groups; missing role and ID-token requests rejected.
- Customer A cannot enumerate/read Customer B tickets or attachments.
- Advisor notes are omitted from customer responses.
- Safety concerns cannot self-resolve or be downgraded to LOW/MEDIUM.
- Two browser tabs editing the same ticket produce a 409 rather than lost updates.
- KB citations come from approved documents; absent grounding goes to advisor review.
- Ticket evidence remains private; CloudWatch logs do not contain descriptions, tokens or file contents.
- A new ticket produces one advisor alert, one diagnostics workflow execution and (with SES configured) one customer email; the DLQ stays empty.
- The first scheduled export of both tables appears in the backup bucket.
- Verify model latency within the API/Lambda timeout budget, regional quotas, CORS and email subscription confirmation.

Template linting and local tests cannot prove these AWS runtime gates. Run them after deployment with approved test data.
