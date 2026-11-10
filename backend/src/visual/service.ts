import { randomUUID } from 'node:crypto';
import { createTicketSchema, type Attachment, type Ticket } from '@servicecare/contracts';
import { visualUploadSchema, visualSessionSchema, type VisualSession, type VisualAnalysis, type VisualGuidance } from '@servicecare/contracts/visual';
import { classifyIssue } from '../triage/rules.ts';

export type VisualImage = Attachment & { versionId?: string };
export type VisualRecord = VisualSession & {
  ownerId: string; expiresAt: number; revision: number; uploads: VisualImage[];
  selected: VisualImage[]; leaseUntil?: number;
};
export interface VisualStore {
  get(id: string): Promise<VisualRecord | undefined>;
  listForAdvisor(cursor?: string): Promise<{ items: VisualRecord[]; nextCursor?: string }>;
  save(record: VisualRecord, revision?: number): Promise<void>;
  commit(record: VisualRecord, ticket: Ticket): Promise<void>;
  ticket(id: string): Promise<Ticket | undefined>;
}
export interface VisualDependencies {
  store: VisualStore;
  guidance(question: string, ownerId: string): Promise<VisualGuidance>;
  upload(key: string, contentType: string): Promise<{ url: string; fields: Record<string, string> }>;
  pin(image: VisualImage): Promise<VisualImage>;
  analyze(record: VisualRecord): Promise<VisualAnalysis>;
  archive(image: VisualImage, ownerId: string, sessionId: string): Promise<Attachment>;
}
export class VisualError extends Error {
  constructor(public readonly status: 400 | 404 | 409 | 503, message: string) { super(message); }
}
export class VisualRetry extends Error {}
export function publicVisual(record: VisualRecord): VisualSession {
  return visualSessionSchema.parse(record);
}
export function visualService(deps: VisualDependencies) {
  async function load(id: string, ownerId?: string) {
    const record = await deps.store.get(id);
    if (!record || (ownerId !== undefined && record.ownerId !== ownerId) || record.expiresAt <= Date.now() / 1000) {
      throw new VisualError(404, 'Visual session not found or expired.');
    }
    return record;
  }
  async function transition(record: VisualRecord, phase: VisualRecord['phase']) {
    const next = { ...record, phase, revision: record.revision + 1 };
    await deps.store.save(next, record.revision);
    return next;
  }
  return {
    async start(ownerId: string, question: string) {
      const issue = classifyIssue(question);
      const knowledge = issue.critical
        ? { answer: issue.recommendedAction, citations: [], grounded: false }
        : await deps.guidance(question, ownerId);
      const record: VisualRecord = {
        sessionId: randomUUID(), ownerId, question, phase: 'KNOWLEDGE_READY', knowledge,
        critical: issue.critical, uploads: [], selected: [], revision: 1,
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
      };
      await deps.store.save(record);
      return publicVisual(record);
    },
    async get(id: string, ownerId?: string) { return publicVisual(await load(id, ownerId)); },
    async unresolved(id: string, ownerId: string) {
      const record = await load(id, ownerId);
      if (record.critical) throw new VisualError(409, 'Critical concerns require immediate advisor review, not image analysis.');
      if (record.phase !== 'KNOWLEDGE_READY') throw new VisualError(409, 'This session has already moved past knowledge guidance.');
      return publicVisual(await transition(record, 'UPLOAD_ALLOWED'));
    },
    async upload(id: string, ownerId: string, input: unknown) {
      const record = await load(id, ownerId);
      if (record.critical) throw new VisualError(409, 'Critical concerns cannot use image analysis.');
      if (record.phase !== 'UPLOAD_ALLOWED') throw new VisualError(409, 'Confirm the concern is unresolved before uploading photos.');
      if (record.uploads.length >= 5) throw new VisualError(400, 'A session supports at most five photos.');
      const data = visualUploadSchema.parse(input);
      const image: VisualImage = { ...data, key: `${ownerId}/${id}/${randomUUID()}` };
      const form = await deps.upload(image.key, image.contentType);
      await deps.store.save({ ...record, uploads: [...record.uploads, image], revision: record.revision + 1 }, record.revision);
      return { ...form, key: image.key };
    },
    async submit(id: string, ownerId: string, keys: string[]) {
      const record = await load(id, ownerId);
      if (record.critical) throw new VisualError(409, 'Critical concerns cannot use image analysis.');
      if (record.phase !== 'UPLOAD_ALLOWED') throw new VisualError(409, 'Photos cannot be analyzed in this session state.');
      if (!keys.length || keys.length > 5 || new Set(keys).size !== keys.length) throw new VisualError(400, 'Choose one to five distinct photos.');
      const selected = keys.map(key => {
        const image = record.uploads.find(upload => upload.key === key);
        if (!image) throw new VisualError(400, 'Photo does not belong to this visual session.');
        return image;
      });
      const pinned = await Promise.all(selected.map(image => deps.pin(image)));
      const next: VisualRecord = { ...record, selected: pinned, phase: 'ANALYSIS_PENDING', revision: record.revision + 1 };
      await deps.store.save(next, record.revision);
      return publicVisual(next);
    },
    async work(id: string) {
      const record = await load(id);
      if (!['ANALYSIS_PENDING', 'PROCESSING'].includes(record.phase)) return;
      if (record.critical) {
        await transition(record, 'FAILED');
        return;
      }
      if (record.phase === 'PROCESSING' && (record.leaseUntil ?? 0) > Date.now() / 1000) throw new VisualRetry('Analysis is already in progress.');
      const claimed: VisualRecord = { ...record, phase: 'PROCESSING', leaseUntil: Math.floor(Date.now() / 1000) + 180, revision: record.revision + 1 };
      await deps.store.save(claimed, record.revision);
      try {
        const analysis = await deps.analyze(claimed);
        await deps.store.save({ ...claimed, phase: 'ANALYSIS_READY', analysis, revision: claimed.revision + 1 }, claimed.revision);
      } catch (error) {
        if (error instanceof VisualRetry) {
          await deps.store.save({ ...claimed, leaseUntil: 0, revision: claimed.revision + 1 }, claimed.revision);
          throw error;
        }
        await deps.store.save({ ...claimed, phase: 'FAILED', error: 'Photo analysis is unavailable. Your regular service request can still be submitted.', revision: claimed.revision + 1 }, claimed.revision);
      }
    },
    async resolve(id: string, ownerId: string) {
      const record = await load(id, ownerId);
      const grounded = record.phase === 'KNOWLEDGE_READY' ? record.knowledge.grounded : record.phase === 'ANALYSIS_READY' && record.analysis?.guidance.grounded;
      if (!grounded || record.critical || record.analysis?.safetyConcern) throw new VisualError(409, 'This concern requires advisor review.');
      return publicVisual(await transition(record, 'RESOLVED'));
    },
    async confirm(id: string, ownerId: string, input: unknown) {
      const record = await load(id, ownerId);
      const data = createTicketSchema.parse(input);
      if (record.phase === 'TICKET_CREATED' && record.ticketId) {
        const existing = await deps.store.ticket(record.ticketId);
        if (!existing) throw new VisualError(409, 'Ticket is temporarily unavailable.');
        if (existing.title !== data.title || existing.description !== data.description || existing.vin !== data.vin) throw new VisualError(409, 'This visual session was already confirmed with different ticket details.');
        return { ...existing, messages: existing.messages.filter(message => !message.internal) };
      }
      if (record.phase !== 'ANALYSIS_READY' || !record.analysis) throw new VisualError(409, 'Review the photo analysis before confirming a ticket.');
      if (data.attachments.length) throw new VisualError(400, 'Ticket photos are selected from the verified session, not client-supplied attachments.');
      const attachments = await Promise.all(record.selected.map(image => deps.archive(image, ownerId, id)));
      const issue = classifyIssue(`${record.question}\n${data.title}\n${data.description}`);
      const safety = record.critical || issue.critical || record.analysis.safetyConcern;
      const now = new Date().toISOString();
      const ticket: Ticket = {
        ...data, attachments, ticketId: `TKT-${randomUUID()}`, customerId: ownerId,
        category: safety ? 'SAFETY' : issue.category, priority: safety ? 'HIGH' : issue.priority,
        status: 'OPEN', source: 'KNOWLEDGE_BASE', advisorId: null,
        aiSummary: record.analysis.summary, visualAnalysis: record.analysis,
        knowledgeBaseAttempted: !record.critical, knowledgeBaseResolved: false,
        messages: [], history: [{ status: 'OPEN', at: now, actor: ownerId }],
        createdAt: now, updatedAt: now, version: 1,
      };
      await deps.store.commit({ ...record, phase: 'TICKET_CREATED', ticketId: ticket.ticketId, revision: record.revision + 1 }, ticket);
      return ticket;
    },
  };
}