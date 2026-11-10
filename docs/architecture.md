# ServiceCare Architecture

## Pain Points


| Pain point                                     | Product behavior                                         | Code boundary                           |
| ------------------------------------------------ | ---------------------------------------------------------- | ----------------------------------------- |
| Routine questions consume advisor time         | Grounded self-service, references, resolved feedback     | `knowledge/`, customer assistant        |
| Unresolved support loses context               | Original question carried into the created ticket        | Feedback endpoint, shared ticket schema |
| Safety concerns cannot wait for FAQ completion | Safety rule gate before retrieval; HIGH/CRITICAL ticket  | `triage/`, assistant escalation         |
| Customers lack request visibility              | Own-ticket history, details, messages and status history | Customer UI, ownership checks           |
| Advisors lack a single queue                   | Filter, assign, reply, internal notes, lifecycle updates | Advisor workspace and API               |
| Evidence is fragmented or publicly accessible  | Optional private objects and authorized signed downloads | `attachments/`, S3                      |
| Frontend/backend contracts drift               | Runtime Zod validation and shared TS models              | `packages/contracts`                    |

## Runtime

The current AWS architecture is drawn in [overdrive-current-aws-architecture.drawio](overdrive-current-aws-architecture.drawio) (open it in draw.io) and explained step by step in [overdrive-current-aws-architecture.md](overdrive-current-aws-architecture.md). Both are derived from the CloudFormation templates in `infra/cloudformation`, the Terraform in `infra/analytics` and the backend code.

One API Lambda deploys the logical feature modules for the MVP; two small Lambdas turn tickets table stream records into events and act on them (workflow start, customer email). Splitting them into individual deployments is not necessary at this size. Shared contracts and the API entry point require coordinated changes.

## Routing Rules

1. Evaluate safety before allowing retrieval or self-resolution. The rule gate cannot be overridden by a model response.
2. Bedrock classification, if configured, is parsed with Zod; failures disable self-service and fall back to advisor review.
3. Every non-safety concern searches the approved KB first, whether it was typed or chosen from Common Issues. In AWS mode, missing credentials/configuration, missing references, or retrieval failure never produce a fabricated grounded answer. If AI classification is configured but fails, self-service is disabled and the customer is sent to a request.
4. The customer can resolve a referenced non-critical answer without creating a ticket. The resolved question is saved in the interactions table in AWS mode and listed under Resolved self-service on My Requests (`GET /api/assistant/history`, customer-scoped through the `customer-created` index).
5. A concern the guidance does not resolve opens the Create a service request page with the question already entered; the ticket exists only once the customer submits that page. A direct ticket never requires a prior knowledge search or an image.
6. Safety tickets cannot be downgraded below HIGH by the patch endpoint. Advisors validate the recommendation and control resolution.

The UI stops troubleshooting after a safety classification and displays emergency/roadside guidance immediately. A customer must submit the Create a service request page before a ticket is created. If creation fails it shows an error; it never claims that an advisor was notified or assistance dispatched. Notification and workflow side effects are driven by the tickets stream with retries, so a saved ticket is never left without them.

## Data and Authorization

- Cognito `sub` owns a customer ticket. Client-supplied customer IDs are not accepted.
- Customers can only list/read their own tickets and cannot update status, assign, or create internal notes.
- `ServiceAdvisors` and `Admins` can manage the queue. Groups are assigned by an administrator, not by the browser.
- AWS identity comes only from API Gateway's validated JWT claims. `X-Demo-Role` is recognized only by the local entry point.
- Only access tokens are accepted; ID tokens are rejected by the application.
- The customer view removes all internal messages on every read and message response.
- Updates require a `version`, checked both by the application and DynamoDB conditional writes. Stale edits return 409.
- GSIs support customer and advisor queues, with pagination. GSI reads are eventually consistent; fetch-by-ID reads are consistent.
- Ticket IDs are UUID-backed; the UI displays a short reference, not a sequential global counter.
- Attachments are limited to five, 10 MB per object, and validated for customer prefix, existence, size and recorded MIME type. Content bytes are not yet scanned.
- Downloads require ticket access and expire after two minutes. Upload forms expire after five minutes and enforce size and MIME metadata.

## Deliberate MVP Limits

- Advisor alerts (SNS) carry ticket IDs, priority and category only. Customer emails (SES, off until a verified sender is configured) carry the status and a sign-in link, never ticket content. In-app views update on refresh; there is no push channel.
- Advisor assignment is self-assignment. Detailed availability and dealer-specific routing are not implemented.
- There is no VIN, booking engine, dealer directory, CRM integration, fabricated appointment confirmation or native push notification.
- All advisor queue items share one GSI partition; conversations/history are embedded. Split these before production scale.
- Ordinary ticket attachments are not analysed. Explicit visual support analyses malware-scanned photos with Rekognition and Nova Lite; the result is evidence for advisor review and must not be presented as an AI diagnosis.
- Every new ticket with a VIN starts the existing diagnostics Step Functions workflow (owned by another team) exactly once, named after the ticket. Its result is not written back to the ticket yet.
- The Knowledge Base and its vector store are existing resources, not created by these templates. They require model/region, document-access and cost decisions first.
