import { z } from 'zod';

export const visualObservationSchema = z.object({
  summary: z.string().min(1).max(1500),
  observations: z.array(z.string().max(500)).max(15),
  uncertainties: z.array(z.string().max(500)).max(10),
  safetyConcern: z.boolean(),
});
export const visualGuidanceSchema = z.object({
  answer: z.string().max(6000),
  citations: z.array(z.object({ title: z.string(), reference: z.string() })).max(20),
  grounded: z.boolean(),
});
export const visualAnalysisSchema = visualObservationSchema.extend({
  guidance: visualGuidanceSchema,
  labels: z.array(z.object({ name: z.string(), confidence: z.number().min(0).max(100) })).max(40),
  detectedText: z.array(z.string().max(500)).max(100),
  modelId: z.string(),
  analyzedAt: z.string(),
});
export const visualUploadSchema = z.object({
  name: z.string().trim().min(1).max(200),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
});
export const visualSessionSchema = z.object({
  sessionId: z.string().uuid(),
  question: z.string().trim().min(5).max(5000),
  phase: z.enum(['KNOWLEDGE_READY', 'UPLOAD_ALLOWED', 'ANALYSIS_PENDING', 'PROCESSING', 'ANALYSIS_READY', 'FAILED', 'RESOLVED', 'TICKET_CREATED']),
  knowledge: visualGuidanceSchema,
  critical: z.boolean(),
  analysis: visualAnalysisSchema.optional(),
  ticketId: z.string().optional(),
  error: z.string().optional(),
});
export type VisualAnalysis = z.infer<typeof visualAnalysisSchema>;
export type VisualGuidance = z.infer<typeof visualGuidanceSchema>;
export type VisualSession = z.infer<typeof visualSessionSchema>;