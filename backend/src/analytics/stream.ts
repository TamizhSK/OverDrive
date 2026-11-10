import { createHash } from 'node:crypto';
import { FirehoseClient, PutRecordBatchCommand } from '@aws-sdk/client-firehose';

type AttributeValue = {
  S?: string;
  N?: string;
  BOOL?: boolean;
  NULL?: boolean;
  M?: Record<string, AttributeValue>;
  L?: AttributeValue[];
};
type Image = Record<string, AttributeValue>;
type EntityType = 'ticket' | 'assistant_interaction' | 'visual_session';
export interface DynamoStreamRecord {
  eventID?: string;
  eventName?: 'INSERT' | 'MODIFY' | 'REMOVE';
  eventSourceARN?: string;
  dynamodb?: {
    ApproximateCreationDateTime?: number;
    SequenceNumber?: string;
    Keys?: Image;
    NewImage?: Image;
    OldImage?: Image;
  };
}
interface AnalyticsEvent {
  schema_version: number;
  entity_type: EntityType;
  entity_id: string;
  event_id: string;
  event_type: string;
  event_time: string;
  event_date: string;
  sequence_number: string;
  opened_at: string | null;
  status_before: string | null;
  status_after: string | null;
  status: string | null;
  priority_before: string | null;
  priority_after: string | null;
  priority: string | null;
  category: string | null;
  source: string | null;
  assigned_before: boolean;
  assigned_after: boolean;
  assigned: boolean;
  advisor_id_hash_before: string | null;
  advisor_id_hash_after: string | null;
  advisor_hash: string | null;
  resolved_before: boolean | null;
  resolved_after: boolean | null;
  resolved: boolean | null;
  phase_before: string | null;
  phase_after: string | null;
  phase: string | null;
  critical: boolean | null;
  safety_concern: boolean | null;
  image_analysis_ready: boolean;
  ticket_created: boolean;
  ticket_resolved: boolean;
  advisor_assigned: boolean;
  is_deleted: boolean;
}

function value(raw?: AttributeValue): unknown {
  if (!raw) return undefined;
  if (typeof raw.S === 'string') return raw.S;
  if (typeof raw.N === 'string') return raw.N;
  if (typeof raw.BOOL === 'boolean') return raw.BOOL;
  if (raw.NULL) return null;
  if (raw.M) return image(raw.M);
  if (raw.L) return raw.L.map(value);
  return undefined;
}

function image(raw?: Image): Record<string, unknown> {
  return Object.fromEntries(Object.entries(raw ?? {}).map(([key, item]) => [key, value(item)]));
}

function text(value_: unknown): string | null {
  return typeof value_ === 'string' ? value_ : null;
}

function bool(value_: unknown): boolean | null {
  return typeof value_ === 'boolean' ? value_ : null;
}

function hash(value_: string): string {
  return createHash('sha256').update(value_).digest('hex');
}

function primaryKey(record: DynamoStreamRecord, current: Record<string, unknown>): [EntityType, string] | undefined {
  for (const [field, type] of [['ticketId', 'ticket'], ['interactionId', 'assistant_interaction'], ['sessionId', 'visual_session']] as const) {
    const id = current[field] ?? value(record.dynamodb?.Keys?.[field]);
    if (typeof id === 'string' && id.length > 0) return [type, id];
  }
  return undefined;
}

export function normalizeStreamRecord(record: DynamoStreamRecord): AnalyticsEvent | undefined {
  const before = image(record.dynamodb?.OldImage);
  const after = image(record.dynamodb?.NewImage);
  const current = record.eventName === 'REMOVE' ? before : after;
  const key = primaryKey(record, current);
  if (!key || !record.eventName) return undefined;
  const [entityType, rawId] = key;
  const sourceTable = record.eventSourceARN?.split('/')[1] ?? entityType;
  const sequence = record.dynamodb?.SequenceNumber ?? '0';
  const eventTime = new Date((record.dynamodb?.ApproximateCreationDateTime ?? Date.now() / 1000) * 1000).toISOString();
  const beforeAnalysis = before.analysis && typeof before.analysis === 'object' ? before.analysis as Record<string, unknown> : {};
  const afterAnalysis = after.analysis && typeof after.analysis === 'object' ? after.analysis as Record<string, unknown> : {};
  const advisorBefore = text(before.advisorId);
  const advisorAfter = text(after.advisorId);
  const statusBefore = text(before.status);
  const statusAfter = text(after.status);
  const priorityBefore = text(before.priority);
  const priorityAfter = text(after.priority);
  const phaseBefore = text(before.phase);
  const phaseAfter = text(after.phase);
  const resolvedBefore = bool(before.resolved);
  const resolvedAfter = bool(after.resolved);
  const safetyConcern = bool(afterAnalysis.safetyConcern) ?? (record.eventName === 'REMOVE' ? bool(beforeAnalysis.safetyConcern) : null);
  const isDeleted = record.eventName === 'REMOVE';
  const status = isDeleted ? statusBefore : statusAfter;
  const priority = isDeleted ? priorityBefore : priorityAfter;
  const phase = isDeleted ? phaseBefore : phaseAfter;
  const resolved = isDeleted ? resolvedBefore : resolvedAfter;

  return {
    schema_version: 1,
    entity_type: entityType,
    entity_id: hash(`${sourceTable}:${rawId}`),
    event_id: hash(`${sourceTable}:${record.eventID ?? sequence}`),
    event_type: record.eventName,
    event_time: eventTime,
    event_date: eventTime.slice(0, 10),
    sequence_number: sequence,
    opened_at: text(after.createdAt) ?? text(before.createdAt),
    status_before: statusBefore,
    status_after: statusAfter,
    status,
    priority_before: priorityBefore,
    priority_after: priorityAfter,
    priority,
    category: text(after.category) ?? text(before.category),
    source: text(after.source) ?? text(before.source),
    assigned_before: advisorBefore !== null,
    assigned_after: advisorAfter !== null,
    assigned: (isDeleted ? advisorBefore : advisorAfter) !== null,
    advisor_id_hash_before: advisorBefore ? hash(advisorBefore) : null,
    advisor_id_hash_after: advisorAfter ? hash(advisorAfter) : null,
    advisor_hash: (isDeleted ? advisorBefore : advisorAfter) ? hash((isDeleted ? advisorBefore : advisorAfter)!) : null,
    resolved_before: resolvedBefore,
    resolved_after: resolvedAfter,
    resolved,
    phase_before: phaseBefore,
    phase_after: phaseAfter,
    phase,
    critical: bool(after.critical) ?? bool(before.critical),
    safety_concern: safetyConcern,
    image_analysis_ready: entityType === 'visual_session' && Boolean(current.analysis) && ['ANALYSIS_READY', 'TICKET_CREATED'].includes(phase ?? ''),
    ticket_created: entityType === 'ticket' && record.eventName === 'INSERT',
    ticket_resolved: entityType === 'ticket' && statusBefore !== 'RESOLVED' && statusAfter === 'RESOLVED',
    advisor_assigned: entityType === 'ticket' && advisorBefore === null && advisorAfter !== null,
    is_deleted: isDeleted,
  };
}

function itemIdentifier(record: DynamoStreamRecord): string | undefined {
  return record.dynamodb?.SequenceNumber ?? record.eventID;
}

export async function processStreamBatch(
  records: DynamoStreamRecord[],
  deliver: (events: AnalyticsEvent[]) => Promise<number[]>,
) {
  const normalized = records.flatMap(record => {
    const event = normalizeStreamRecord(record);
    return event ? [{ record, event }] : [];
  });
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (let offset = 0; offset < normalized.length; offset += 500) {
    const chunk = normalized.slice(offset, offset + 500);
    let failedIndexes: number[];
    try {
      failedIndexes = await deliver(chunk.map(item => item.event));
    } catch (error) {
      console.error(JSON.stringify({ event: 'analytics_firehose_batch_failed', name: error instanceof Error ? error.name : 'Error', records: normalized.length - offset }));
      for (const item of normalized.slice(offset)) {
        const identifier = itemIdentifier(item.record);
        if (identifier) batchItemFailures.push({ itemIdentifier: identifier });
      }
      break;
    }

    const failed = new Set(failedIndexes);
    for (const index of failed) {
      const identifier = itemIdentifier(chunk[index]?.record);
      if (identifier) batchItemFailures.push({ itemIdentifier: identifier });
    }
  }
  return { batchItemFailures };
}

const firehose = new FirehoseClient({});

export async function handler(event: { Records: DynamoStreamRecord[] }) {
  const deliveryStreamName = process.env.ANALYTICS_FIREHOSE_STREAM;
  if (!deliveryStreamName) throw new Error('ANALYTICS_FIREHOSE_STREAM is not configured.');
  return processStreamBatch(event.Records, async events => {
    const response = await firehose.send(new PutRecordBatchCommand({
      DeliveryStreamName: deliveryStreamName,
      Records: events.map(item => ({ Data: Buffer.from(`${JSON.stringify(item)}\n`) })),
    }));
    return (response.RequestResponses ?? []).flatMap((result, index) => result.ErrorCode ? [index] : []);
  });
}