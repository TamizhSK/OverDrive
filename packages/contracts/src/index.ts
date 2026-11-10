import { z } from 'zod';
import type { VisualAnalysis } from './visual.ts';

export const categories = ['GENERAL_SERVICE', 'APPOINTMENT', 'INFOTAINMENT', 'CONNECTIVITY', 'CLIMATE_CONTROL', 'MAINTENANCE', 'MECHANICAL', 'ELECTRICAL', 'CHARGING', 'BODY_DAMAGE', 'SAFETY', 'WARRANTY', 'OTHER'] as const;
export const priorities = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export const statuses = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED'] as const;
export const statusTransitions: Record<(typeof statuses)[number], readonly (typeof statuses)[number][]> = {
  OPEN: ['ASSIGNED', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED'],
  ASSIGNED: ['IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED'],
  IN_PROGRESS: ['WAITING_FOR_CUSTOMER', 'RESOLVED'],
  WAITING_FOR_CUSTOMER: ['IN_PROGRESS', 'RESOLVED'],
  RESOLVED: ['CLOSED', 'IN_PROGRESS'],
  CLOSED: [],
};
export const triageSchema = z.object({
  category: z.enum(categories), priority: z.enum(priorities), critical: z.boolean(),
  knowledgeBaseEligible: z.boolean(), summary: z.string().min(1).max(1000),
  recommendedAction: z.string().min(1).max(1000),
});
export type Triage = z.infer<typeof triageSchema>;
export type Status = typeof statuses[number];
export type Role = 'customer' | 'advisor';
export const chatContextSchema = z.object({
  issue: z.string().trim().min(5).max(5000),
  previousAnswers: z.array(z.string().min(1).max(6000)).max(2),
  unresolved: z.boolean(),
});
export type ChatContext = z.infer<typeof chatContextSchema>;
export const attachmentSchema = z.object({
  key: z.string().min(1).max(512), name: z.string().min(1).max(200),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
});
export type Attachment = z.infer<typeof attachmentSchema>;
export const createTicketSchema = z.object({
  requestId: z.string().uuid().optional(),
  title: z.string().trim().min(5).max(150), description: z.string().trim().min(10).max(5000),
  vin: z.string().trim().min(1).max(64).optional(),
  attachments: z.array(attachmentSchema).max(5).default([]),
  knowledgeBaseAttempted: z.boolean().default(false),
});
export type CreateTicket = z.input<typeof createTicketSchema>;
export interface Message { id: string; author: string; role: Role; text: string; internal: boolean; createdAt: string }
export interface HistoryEntry { status: Status; at: string; actor: string }
export interface CustomerProfileSnapshot {
  ownerName?: string; ownerEmail?: string; ownerPhone?: string; preferredContact?: string;
  vehicle: { vin: string; make?: string; model?: string; variant?: string; modelYear?: number; registration?: string; colour?: string; bodyStyle?: string; powertrain?: string; servicePlan?: string; homeDealer?: string; lastServiceDate?: string; nextServiceDueDate?: string; region?: string };
  diagnosticEvents: { dtcCode?: string; status?: string; severity?: string; safetyCritical?: boolean; title?: string; plainLanguage?: string; recommendedAction?: string; eventAt?: string }[];
  telemetryReadings: { signalName: string; readingAt: string; value?: number | string; unit?: string; quality?: string; source?: string }[];
}
export interface Ticket {
  creationRequestHash?: string;
  ticketId: string; customerId: string; title: string; description: string; vin?: string;
  customerProfile?: CustomerProfileSnapshot;
  category: Triage['category']; priority: Triage['priority']; status: Status;
  source: 'CUSTOMER_PORTAL' | 'KNOWLEDGE_BASE'; advisorId: string | null;
  aiSummary: string; knowledgeBaseAttempted: boolean; knowledgeBaseResolved: boolean;
  attachments: Attachment[]; messages: Message[]; history: HistoryEntry[];
  visualAnalysis?: VisualAnalysis;
  createdAt: string; updatedAt: string; version: number;
}
export interface AssistantAnswer {
  question: string; answer: string; citations: { title: string; reference: string }[];
  triage: Triage; source: 'local-faq' | 'bedrock' | 'agentcore' | 'safety-rule' | 'unavailable';
  interactionId?: string; createdAt?: string;
  nextAction?: 'guidance' | 'offer-ticket' | 'urgent-ticket';
  reason?: 'out-of-scope' | 'no-alternative' | 'service-unavailable';
  contextApplied?: boolean;
}
export interface ResolvedSession {
  interactionId: string; customerId: string; question: string; answer?: string;
  citations?: AssistantAnswer['citations']; source?: AssistantAnswer['source'];
  resolved: boolean; createdAt: string;
}