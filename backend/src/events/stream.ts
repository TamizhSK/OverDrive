import { EventBridgeClient, PutEventsCommand, type PutEventsRequestEntry } from '@aws-sdk/client-eventbridge';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import type { Ticket } from '@servicecare/contracts';

/**
 * Ticket domain events, derived from the tickets table stream. Every writer (API, visual confirmation, agent tools)
 * produces them without publishing anything itself, and a failed publish is retried from the stream.
 * The EventBridge rules in infra/cloudformation/backend-lambda-platform.yml match these names.
 */
export const ticketEventTypes = ['TicketCreated', 'TicketAssigned', 'TicketStatusChanged', 'TicketResolved', 'TicketMessageAdded'] as const;
export type TicketEventType = (typeof ticketEventTypes)[number];
export const TICKET_EVENT_SOURCE = 'servicecare.ticket';

/** IDs and workflow fields only: no descriptions, messages, VINs or contact details leave the table. */
export interface TicketEventDetail {
  ticketId: string;
  customerId: string;
  status: Ticket['status'];
  previousStatus?: Ticket['status'];
  priority: Ticket['priority'];
  category: Ticket['category'];
  authorRole?: 'customer' | 'advisor';
}
export interface TicketEvent { type: TicketEventType; detail: TicketEventDetail }

type Image = Record<string, AttributeValue>;
export interface TicketStreamRecord {
  eventID?: string;
  eventName?: 'INSERT' | 'MODIFY' | 'REMOVE';
  dynamodb?: { NewImage?: Image; OldImage?: Image; SequenceNumber?: string };
}

function base(ticket: Ticket): TicketEventDetail {
  return { ticketId: ticket.ticketId, customerId: ticket.customerId, status: ticket.status, priority: ticket.priority, category: ticket.category };
}

/** Turns one stream record into zero or more domain events. Internal advisor notes never produce an event. */
export function deriveTicketEvents(record: TicketStreamRecord): TicketEvent[] {
  const next = record.dynamodb?.NewImage ? unmarshall(record.dynamodb.NewImage) as Ticket : undefined;
  if (!next?.ticketId) return [];
  if (record.eventName === 'INSERT') return [{ type: 'TicketCreated', detail: base(next) }];
  if (record.eventName !== 'MODIFY' || !record.dynamodb?.OldImage) return [];
  const previous = unmarshall(record.dynamodb.OldImage) as Ticket;
  const events: TicketEvent[] = [];
  if (!previous.advisorId && next.advisorId) events.push({ type: 'TicketAssigned', detail: { ...base(next), previousStatus: previous.status } });
  else if (next.status !== previous.status) {
    events.push({ type: next.status === 'RESOLVED' ? 'TicketResolved' : 'TicketStatusChanged', detail: { ...base(next), previousStatus: previous.status } });
  }
  const added = (next.messages ?? []).slice((previous.messages ?? []).length).filter(message => !message.internal);
  for (const message of added) events.push({ type: 'TicketMessageAdded', detail: { ...base(next), authorRole: message.role } });
  return events;
}

export function toEntry(event: TicketEvent, busName: string): PutEventsRequestEntry {
  return { EventBusName: busName, Source: TICKET_EVENT_SOURCE, DetailType: event.type, Detail: JSON.stringify(event.detail) };
}

type Send = (entries: PutEventsRequestEntry[]) => Promise<{ FailedEntryCount?: number; Entries?: { ErrorCode?: string }[] }>;

/**
 * Publishes records in stream order and reports the first record that could not be published. The event source
 * mapping then retries from that record, so nothing is skipped; repeated failures go to the on-failure queue.
 */
export async function publishStreamRecords(records: TicketStreamRecord[], send: Send, busName: string) {
  for (const record of records) {
    const entries = deriveTicketEvents(record).map(event => toEntry(event, busName));
    if (!entries.length) continue;
    try {
      const result = await send(entries);
      if (result.FailedEntryCount) throw new Error(result.Entries?.find(entry => entry.ErrorCode)?.ErrorCode ?? 'PutEventsFailed');
    } catch (error) {
      console.error(JSON.stringify({ event: 'ticket_event_publish_failed', name: (error as Error).name, reason: (error as Error).message.slice(0, 200) }));
      return { batchItemFailures: [{ itemIdentifier: record.dynamodb?.SequenceNumber ?? record.eventID ?? '' }] };
    }
  }
  return { batchItemFailures: [] };
}

const client = new EventBridgeClient({});
export async function handler(event: { Records: TicketStreamRecord[] }) {
  return publishStreamRecords(event.Records, entries => client.send(new PutEventsCommand({ Entries: entries })), process.env.EVENT_BUS_NAME ?? 'default');
}
