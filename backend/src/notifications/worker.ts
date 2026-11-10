import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { CognitoIdentityProviderClient, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { Ticket } from '@servicecare/contracts';
import type { TicketEventDetail, TicketEventType } from '../events/stream.ts';

/**
 * Consumes ticket events that EventBridge delivers to the ticket-actions SQS queue:
 * - TicketCreated starts the diagnostics Step Functions workflow once per ticket (execution name = ticket ID).
 * - Every customer-facing change (created, assigned, status, resolved, advisor reply) emails the customer,
 *   when a verified sender is configured. Emails carry no ticket content; the customer signs in to read it.
 * Failed messages are retried by SQS and moved to the dead-letter queue after repeated failures.
 */
export interface TicketActionDependencies {
  getTicket(ticketId: string): Promise<Ticket | undefined>;
  startWorkflow?(name: string, input: { vin: string; ownerId: string; customerIssue: string }): Promise<void>;
  customerEmail?(customerId: string): Promise<string | undefined>;
  sendEmail?(to: string, subject: string, body: string): Promise<void>;
  webOrigin: string;
}
type EventBridgeEnvelope = { 'detail-type': TicketEventType; detail: TicketEventDetail };
export interface SqsRecord { messageId: string; body: string }

const statusText: Record<Ticket['status'], string> = {
  OPEN: 'received', ASSIGNED: 'assigned to a service advisor', IN_PROGRESS: 'in progress',
  WAITING_FOR_CUSTOMER: 'waiting for your reply', RESOLVED: 'resolved', CLOSED: 'closed',
};

export function customerMessage(type: TicketEventType, detail: TicketEventDetail, webOrigin: string) {
  if (type === 'TicketMessageAdded' && detail.authorRole !== 'advisor') return undefined;
  // Same short reference the web app shows (frontend/src/lib/api.ts shortId).
  const reference = detail.ticketId.length > 12 ? `${detail.ticketId.slice(0, 6)}...${detail.ticketId.slice(-4)}` : detail.ticketId;
  const subject = type === 'TicketMessageAdded'
    ? `Your service advisor replied (request ${reference})`
    : `Your service request ${reference} is ${statusText[detail.status]}`;
  const body = [
    type === 'TicketMessageAdded' ? 'Your service advisor has replied to your request.' : `Your service request is now ${statusText[detail.status]}.`,
    `Sign in to view the details: ${webOrigin}`,
    'This message was sent automatically. Please reply in the app, not to this email.',
  ].join('\n\n');
  return { subject, body };
}

export async function handleTicketAction(envelope: EventBridgeEnvelope, deps: TicketActionDependencies) {
  const type = envelope['detail-type'];
  const detail = envelope.detail;
  if (type === 'TicketCreated' && deps.startWorkflow) {
    const ticket = await deps.getTicket(detail.ticketId);
    if (ticket?.vin) {
      await deps.startWorkflow(detail.ticketId, { vin: ticket.vin, ownerId: ticket.customerId, customerIssue: `${ticket.title}\n${ticket.description}` });
    }
  }
  const message = customerMessage(type, detail, deps.webOrigin);
  if (message && deps.customerEmail && deps.sendEmail) {
    const to = await deps.customerEmail(detail.customerId);
    if (to) await deps.sendEmail(to, message.subject, message.body);
  }
}

export async function processBatch(records: SqsRecord[], deps: TicketActionDependencies) {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of records) {
    try {
      await handleTicketAction(JSON.parse(record.body) as EventBridgeEnvelope, deps);
    } catch (error) {
      console.error(JSON.stringify({ event: 'ticket_action_failed', messageId: record.messageId, name: (error as Error).name }));
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}

export function awsTicketActionDependencies(env = process.env): TicketActionDependencies {
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const deps: TicketActionDependencies = {
    webOrigin: env.WEB_ORIGIN ?? '',
    async getTicket(ticketId) {
      const result = await db.send(new GetCommand({ TableName: env.TICKETS_TABLE, Key: { ticketId }, ConsistentRead: true }));
      return result.Item as Ticket | undefined;
    },
  };
  const workflowArn = env.TRIAGE_WORKFLOW_ARN;
  if (workflowArn) {
    const sfn = new SFNClient({ region: workflowArn.split(':')[3] });
    deps.startWorkflow = async (name, input) => {
      try {
        await sfn.send(new StartExecutionCommand({ stateMachineArn: workflowArn, name, input: JSON.stringify(input) }));
      } catch (error) {
        // A redelivered event finds the execution already started; that is success, not a duplicate.
        if ((error as Error).name !== 'ExecutionAlreadyExists') throw error;
      }
    };
  }
  const sender = env.CUSTOMER_EMAIL_SENDER;
  const poolId = env.COGNITO_USER_POOL_ID;
  if (sender && poolId) {
    const cognito = new CognitoIdentityProviderClient({ region: poolId.split('_')[0] });
    const ses = new SESv2Client({});
    deps.customerEmail = async customerId => {
      if (!/^[0-9a-f-]{36}$/i.test(customerId)) return undefined;
      const result = await cognito.send(new ListUsersCommand({ UserPoolId: poolId, Filter: `sub = "${customerId}"`, Limit: 1 }));
      const attributes = new Map((result.Users?.[0]?.Attributes ?? []).map(attribute => [attribute.Name, attribute.Value]));
      return attributes.get('email_verified') === 'true' ? attributes.get('email') : undefined;
    };
    deps.sendEmail = async (to, subject, body) => {
      await ses.send(new SendEmailCommand({
        FromEmailAddress: sender,
        Destination: { ToAddresses: [to] },
        Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: body } } } },
      }));
    };
  }
  return deps;
}

let cached: TicketActionDependencies | undefined;
export async function handler(event: { Records: SqsRecord[] }) {
  cached ??= awsTicketActionDependencies();
  return processBatch(event.Records, cached);
}
