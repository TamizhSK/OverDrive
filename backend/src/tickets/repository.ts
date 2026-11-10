import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { AssistantAnswer, ResolvedSession, Ticket } from '@servicecare/contracts';

export class ConflictError extends Error {}
export interface TicketPage { items: Ticket[]; nextCursor?: string }
export interface TicketOverview { open: number; unassigned: number; urgent: number; waiting: number }
export interface Repository {
  get(id: string): Promise<Ticket | undefined>;
  list(customerId?: string, cursor?: string): Promise<TicketPage>;
  ticketOverview(customerId?: string): Promise<TicketOverview>;
  save(ticket: Ticket, expectedVersion?: number): Promise<void>;
  recordInteraction(customerId: string, answer: AssistantAnswer): Promise<ResolvedSession>;
  resolveInteraction(customerId: string, interactionId: string): Promise<void>;
  feedback(customerId: string, question: string): Promise<void>;
  advisorInteractions(cursor?: string): Promise<InteractionPage>;
  resolvedSessions(customerId: string, cursor?: string): Promise<InteractionPage>;
}
export interface InteractionPage { items: ResolvedSession[]; nextCursor?: string }
const PAGE_SIZE = 50;
const encodeCursor = (key: Record<string, unknown>) => Buffer.from(JSON.stringify(key)).toString('base64url');
const decodeCursor = (cursor?: string) => cursor ? JSON.parse(Buffer.from(cursor, 'base64url').toString()) as Record<string, unknown> : undefined;
export function memoryRepository(): Repository {
  const tickets = new Map<string, Ticket>();
  const sessions: ResolvedSession[] = [];
  return {
    async get(id) { return structuredClone(tickets.get(id)); },
    async list(customerId) { return { items: structuredClone([...tickets.values()].filter(ticket => !customerId || ticket.customerId === customerId).sort((first, second) => second.updatedAt.localeCompare(first.updatedAt))) }; },
    async ticketOverview(customerId) {
      const active = [...tickets.values()].filter(ticket => (!customerId || ticket.customerId === customerId) && !['RESOLVED', 'CLOSED'].includes(ticket.status));
      return {
        open: active.length,
        unassigned: active.filter(ticket => !ticket.advisorId).length,
        urgent: active.filter(ticket => ['HIGH', 'CRITICAL'].includes(ticket.priority)).length,
        waiting: active.filter(ticket => ticket.status === 'WAITING_FOR_CUSTOMER').length,
      };
    },
    async save(ticket, expectedVersion) {
      const current = tickets.get(ticket.ticketId);
      if (expectedVersion === undefined ? current : current?.version !== expectedVersion) throw new ConflictError('Ticket changed. Refresh and retry.');
      tickets.set(ticket.ticketId, structuredClone(ticket));
    },
    recordInteraction(customerId, answer) {
      const interaction: ResolvedSession = {
        interactionId: randomUUID(), customerId, question: answer.question,
        answer: answer.answer, citations: answer.citations, source: answer.source,
        resolved: false, createdAt: new Date().toISOString(),
      };
      sessions.push(interaction);
      return Promise.resolve(structuredClone(interaction));
    },
    resolveInteraction(customerId, interactionId) {
      const session = sessions.find(item => item.customerId === customerId && item.interactionId === interactionId);
      if (!session) return Promise.reject(new ConflictError('Conversation not found or no longer accessible.'));
      session.resolved = true;
      return Promise.resolve();
    },
    async feedback(customerId, question) {
      sessions.push({ interactionId: randomUUID(), customerId, question, resolved: true, createdAt: new Date().toISOString() });
    },
    async advisorInteractions(cursor) {
      const start = cursor ? Number(Buffer.from(cursor, 'base64url').toString()) : 0;
      const items = sessions.sort((first, second) => second.createdAt.localeCompare(first.createdAt)).slice(start, start + PAGE_SIZE);
      return { items: structuredClone(items), ...(start + PAGE_SIZE < sessions.length ? { nextCursor: Buffer.from(String(start + PAGE_SIZE)).toString('base64url') } : {}) };
    },
    async resolvedSessions(customerId, cursor) {
      const start = cursor ? Number(Buffer.from(cursor, 'base64url').toString()) : 0;
      const owned = sessions.filter(session => session.customerId === customerId).sort((first, second) => second.createdAt.localeCompare(first.createdAt));
      return { items: structuredClone(owned.slice(start, start + PAGE_SIZE)), ...(start + PAGE_SIZE < owned.length ? { nextCursor: Buffer.from(String(start + PAGE_SIZE)).toString('base64url') } : {}) };
    },
  };
}
export function dynamoRepository(): Repository {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const TableName = process.env.TICKETS_TABLE!;
  return {
    async get(ticketId) {
      const result = await client.send(new GetCommand({ TableName, Key: { ticketId }, ConsistentRead: true }));
      return result.Item as Ticket | undefined;
    },
    async list(customerId, cursor) {
      const result = await client.send(new QueryCommand({
        TableName, IndexName: customerId ? 'customer-updated' : 'queue-updated',
        KeyConditionExpression: '#key = :value', ExpressionAttributeNames: { '#key': customerId ? 'customerId' : 'queueKey' },
        ExpressionAttributeValues: { ':value': customerId ?? 'ALL' }, ScanIndexForward: false, Limit: 50,
        ExclusiveStartKey: cursor ? JSON.parse(Buffer.from(cursor, 'base64url').toString()) : undefined,
      }));
      return { items: (result.Items ?? []) as Ticket[], nextCursor: result.LastEvaluatedKey ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64url') : undefined };
    },
    async ticketOverview(customerId) {
      const overview: TicketOverview = { open: 0, unassigned: 0, urgent: 0, waiting: 0 };
      let lastKey: Record<string, unknown> | undefined;
      do {
        const result = await client.send(new QueryCommand({
          TableName, IndexName: customerId ? 'customer-updated' : 'queue-updated',
          KeyConditionExpression: '#key = :value',
          ExpressionAttributeNames: { '#key': customerId ? 'customerId' : 'queueKey', '#status': 'status', '#priority': 'priority', '#advisorId': 'advisorId' },
          ExpressionAttributeValues: { ':value': customerId ?? 'ALL' },
          ProjectionExpression: '#status, #priority, #advisorId',
          Limit: 1000, ExclusiveStartKey: lastKey,
        }));
        for (const ticket of (result.Items ?? []) as Pick<Ticket, 'status' | 'priority' | 'advisorId'>[]) {
          if (['RESOLVED', 'CLOSED'].includes(ticket.status)) continue;
          overview.open += 1;
          if (!ticket.advisorId) overview.unassigned += 1;
          if (['HIGH', 'CRITICAL'].includes(ticket.priority)) overview.urgent += 1;
          if (ticket.status === 'WAITING_FOR_CUSTOMER') overview.waiting += 1;
        }
        lastKey = result.LastEvaluatedKey;
      } while (lastKey);
      return overview;
    },
    async save(ticket, expectedVersion) {
      try {
        await client.send(new PutCommand({
          TableName, Item: { ...ticket, queueKey: 'ALL' },
          ConditionExpression: expectedVersion === undefined ? 'attribute_not_exists(ticketId)' : '#version = :expected',
          ...(expectedVersion === undefined ? {} : { ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':expected': expectedVersion } }),
        }));
      } catch (error) {
        if (error instanceof Error && error.name === 'ConditionalCheckFailedException') throw new ConflictError('Ticket changed. Refresh and retry.');
        throw error;
      }
    },
    async recordInteraction(customerId, answer) {
      const interaction: ResolvedSession = {
        interactionId: randomUUID(), customerId, question: answer.question,
        answer: answer.answer, citations: answer.citations, source: answer.source,
        resolved: false, createdAt: new Date().toISOString(),
      };
      await client.send(new PutCommand({ TableName: process.env.INTERACTIONS_TABLE!, Item: interaction }));
      return interaction;
    },
    async resolveInteraction(customerId, interactionId) {
      try {
        await client.send(new UpdateCommand({
          TableName: process.env.INTERACTIONS_TABLE!,
          Key: { interactionId },
          UpdateExpression: 'SET #resolved = :resolved',
          ConditionExpression: 'customerId = :customerId',
          ExpressionAttributeNames: { '#resolved': 'resolved' },
          ExpressionAttributeValues: { ':resolved': true, ':customerId': customerId },
        }));
      } catch (error) {
        if (error instanceof Error && error.name === 'ConditionalCheckFailedException') throw new ConflictError('Conversation not found or no longer accessible.');
        throw error;
      }
    },
    async feedback(customerId, question) {
      await client.send(new PutCommand({ TableName: process.env.INTERACTIONS_TABLE!, Item: { interactionId: randomUUID(), customerId, question, resolved: true, createdAt: new Date().toISOString() } }));
    },
    async advisorInteractions(cursor) {
      const result = await client.send(new ScanCommand({
        TableName: process.env.INTERACTIONS_TABLE!, Limit: PAGE_SIZE, ExclusiveStartKey: decodeCursor(cursor),
        ProjectionExpression: '#id, #customerId, #question, #answer, #source, #resolved, #createdAt',
        ExpressionAttributeNames: { '#id': 'interactionId', '#customerId': 'customerId', '#question': 'question', '#answer': 'answer', '#source': 'source', '#resolved': 'resolved', '#createdAt': 'createdAt' },
        FilterExpression: 'attribute_exists(customerId)',
      }));
      return { items: (result.Items ?? []) as ResolvedSession[], ...(result.LastEvaluatedKey ? { nextCursor: encodeCursor(result.LastEvaluatedKey) } : {}) };
    },
    async resolvedSessions(customerId, cursor) {
      const result = await client.send(new QueryCommand({
        TableName: process.env.INTERACTIONS_TABLE!, IndexName: 'customer-created',
        KeyConditionExpression: 'customerId = :customerId',
        ExpressionAttributeValues: { ':customerId': customerId },
        ScanIndexForward: false, Limit: PAGE_SIZE, ExclusiveStartKey: decodeCursor(cursor),
      }));
      return { items: (result.Items ?? []) as ResolvedSession[], ...(result.LastEvaluatedKey ? { nextCursor: encodeCursor(result.LastEvaluatedKey) } : {}) };
    },
  };
}