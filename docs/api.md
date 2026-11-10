# API Contract

All routes start with `/api`. JSON in/out. AWS calls require `Authorization: Bearer <Cognito access token>`. Only local demo mode accepts `X-Demo-Role: customer|advisor`; identities are fixed demo accounts, not caller-provided IDs.

The executable source of truth is `packages/contracts/src/index.ts`. Status includes `WAITING_FOR_CUSTOMER`; categories include `CLIMATE_CONTROL`. The API assigns priority/category; users cannot spoof AI classification on creation.

| Method | Path | Access | Result |
| --- | --- | --- | --- |
| GET | `/health` | Local public; gateway still requires JWT in AWS | `{status, mode}` |
| GET | `/tickets?cursor=...` | Customer: own; advisor: queue | `{items: Ticket[], nextCursor?: string}` |
| POST | `/tickets` | Customer | Ticket, 201 |
| GET | `/tickets/{ticketId}` | Owner or advisor | Ticket |
| PATCH | `/tickets/{ticketId}` | Advisor | Updated Ticket |
| POST | `/tickets/{ticketId}/assign` | Advisor | Self-assigned Ticket |
| POST | `/tickets/{ticketId}/messages` | Owner or advisor | Updated Ticket |
| POST | `/assistant/ask` | Authenticated | AssistantAnswer |
| POST | `/assistant/feedback` | Customer | `{resolved:true}` or `{ticket:Ticket}`, 201 |
| GET | `/assistant/history` | Customer | `{items: ResolvedSession[]}`, newest first, own sessions only; advisors receive 403 |
| POST | `/attachments/upload` | Customer; AWS only | `{url,fields,key}` presigned POST |
| GET | `/tickets/{ticketId}/attachments/{index}` | Owner or advisor | `{url}` signed download |

The proposed `/customers/{id}/tickets` and `/advisor/tickets` use one role-aware list endpoint instead. Resolve/close use PATCH rather than duplicating lifecycle logic in a `/resolve` endpoint.

## Requests

Create:

```json
{
  "title": "Infotainment display restarting",
  "description": "The display restarted twice on my last journey.",
  "knowledgeBaseAttempted": false,
  "attachments": []
}
```

Patch and assign:

```json
{"status":"IN_PROGRESS","version":1}
```

```json
{"version":1}
```

Message (internal is advisor-only):

```json
{"text":"We are reviewing your issue.","internal":false,"version":2}
```

Assistant and feedback:

```json
{"question":"How can I reconnect my phone?"}
```

```json
{"question":"How can I reconnect my phone?","resolved":false}
```

The feedback escalation stores the original question, not a model-invented conversation transcript. Multi-turn conversation persistence is a later enhancement.

## Lifecycle

```text
OPEN -> ASSIGNED | IN_PROGRESS | WAITING_FOR_CUSTOMER | RESOLVED
ASSIGNED -> IN_PROGRESS | WAITING_FOR_CUSTOMER | RESOLVED
IN_PROGRESS -> WAITING_FOR_CUSTOMER | RESOLVED
WAITING_FOR_CUSTOMER -> IN_PROGRESS | RESOLVED
RESOLVED -> CLOSED | IN_PROGRESS
CLOSED -> terminal
```

Invalid transitions return 400; role failures 403; missing or inaccessible ticket 404; stale versions 409. Errors use `{"error":"human-readable message"}`. The UI shows server validation errors and offers refresh after conflicts.

## Attachments

Request `{"contentType":"image/jpeg"}` at `/attachments/upload`. Send a browser `FormData` POST to the returned S3 `url`, adding every returned `fields` value before the `file`. Only after S3 succeeds include `{key,name,contentType}` in ticket creation. The upload is separate from ticket creation; cleanup of abandoned objects is not implemented. Signed downloads force attachment disposition rather than executing uploaded content inline.