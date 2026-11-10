import { createHash } from 'node:crypto';

interface FirehoseRecord {
  recordId: string;
  data: string;
}

interface DynamoRecord {
  eventName?: string;
  dynamodb?: {
    ApproximateCreationDateTime?: number;
    SequenceNumber?: string;
    NewImage?: Record<string, unknown>;
    OldImage?: Record<string, unknown>;
  };
}

function decodeValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const attribute = value as Record<string, unknown>;
  if (typeof attribute.S === 'string') return attribute.S;
  if (typeof attribute.N === 'string') return attribute.N;
  if (typeof attribute.BOOL === 'boolean') return attribute.BOOL;
  if (attribute.NULL === true) return null;
  if (attribute.M && typeof attribute.M === 'object') {
    return decodeImage(attribute.M as Record<string, unknown>);
  }
  if (Array.isArray(attribute.L)) return attribute.L.map(decodeValue);
  return undefined;
}

function decodeImage(image: Record<string, unknown> | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(image ?? {}).map(([key, value]) => [key, decodeValue(value)]));
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sanitizedEvent(raw: DynamoRecord): Record<string, unknown> | undefined {
  const image = decodeImage(raw.dynamodb?.NewImage ?? raw.dynamodb?.OldImage);
  const ticketId = typeof image.ticketId === 'string' ? image.ticketId : undefined;
  const interactionId = typeof image.interactionId === 'string' ? image.interactionId : undefined;
  const sessionId = typeof image.sessionId === 'string' ? image.sessionId : undefined;
  if (!ticketId && !interactionId && !sessionId) return undefined;

  const eventTime = raw.dynamodb?.ApproximateCreationDateTime
    ? new Date(raw.dynamodb.ApproximateCreationDateTime * 1000).toISOString()
    : new Date().toISOString();
  const recordId = ticketId ?? interactionId ?? sessionId!;
  const entityType = ticketId ? 'ticket' : interactionId ? 'assistant_interaction' : 'visual_session';
  const sequenceNumber = raw.dynamodb?.SequenceNumber ?? '0';
  const oldImage = decodeImage(raw.dynamodb?.OldImage as Record<string, unknown> | undefined);
  const analysis = image.analysis && typeof image.analysis === 'object' ? image.analysis as Record<string, unknown> : undefined;
  const phase = typeof image.phase === 'string' ? image.phase : null;
  const statusChangedToResolved = entityType === 'ticket'
    && image.status === 'RESOLVED'
    && oldImage.status !== 'RESOLVED';

  return {
    record_id: digest(`${entityType}:${recordId}`),
    event_id: digest(`${entityType}:${recordId}:${sequenceNumber}:${eventTime}`),
    entity_type: entityType,
    event_action: raw.eventName ?? 'MODIFY',
    event_time: eventTime,
    event_date: eventTime.slice(0, 10),
    sequence_number: sequenceNumber,
    opened_at: typeof image.createdAt === 'string' ? image.createdAt : eventTime,
    status: typeof image.status === 'string' ? image.status : null,
    priority: typeof image.priority === 'string' ? image.priority : null,
    category: typeof image.category === 'string' ? image.category : null,
    source: typeof image.source === 'string' ? image.source : null,
    resolved: typeof image.resolved === 'boolean' ? image.resolved : phase === 'RESOLVED' ? true : null,
    ticket_created: entityType === 'ticket' && raw.eventName === 'INSERT',
    ticket_resolved: statusChangedToResolved,
    phase,
    critical: typeof image.critical === 'boolean' ? image.critical : null,
    safety_concern: typeof analysis?.safetyConcern === 'boolean' ? analysis.safetyConcern : null,
    image_analysis_ready: entityType === 'visual_session' && ['ANALYSIS_READY', 'TICKET_CREATED'].includes(phase ?? '') && Boolean(analysis),
  };
}

export async function handler(event: { records: FirehoseRecord[] }) {
  return {
    records: event.records.map(record => {
      try {
        const raw = JSON.parse(Buffer.from(record.data, 'base64').toString('utf8')) as DynamoRecord;
        const sanitized = sanitizedEvent(raw);
        if (!sanitized) return { recordId: record.recordId, result: 'Dropped' as const, data: record.data };
        return {
          recordId: record.recordId,
          result: 'Ok' as const,
          data: Buffer.from(`${JSON.stringify(sanitized)}\n`).toString('base64'),
        };
      } catch {
        return { recordId: record.recordId, result: 'Dropped' as const, data: record.data };
      }
    }),
  };
}
