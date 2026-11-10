import { visualSessionSchema } from '@servicecare/contracts/visual';
import type { Ticket } from '@servicecare/contracts';
import { authHeaders, demoMode } from './auth';

export interface AdvisorVisualSession {
  sessionId: string;
  question: string;
  phase: string;
  critical: boolean;
  ticketId?: string;
  error?: string;
  analysis?: {
    summary: string;
    observations: string[];
    uncertainties: string[];
    safetyConcern: boolean;
    analyzedAt: string;
    guidance: { answer: string; grounded: boolean; citations: { title: string }[] };
  };
}

const base = import.meta.env.VITE_VISUAL_API_URL?.replace(/\/$/, '');
export const visualEnabled = Boolean(base && !demoMode);
async function request<Result>(path: string, method = 'GET', body?: unknown): Promise<Result> {
  if (!visualEnabled) throw new Error('Visual support is not configured.');
  const response = await fetch(`${base}/visual${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...await authHeaders() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Visual support is temporarily unavailable.');
  return result as Result;
}
const session = async (path: string, method = 'GET', body?: unknown) => visualSessionSchema.parse(await request(path, method, body));
export const visualApi = {
  advisorSessions(cursor?: string) {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return request<{ items: AdvisorVisualSession[]; nextCursor?: string }>(`/advisor/sessions${query}`);
  },
  start: (question: string) => session('/sessions', 'POST', { question }),
  get: (id: string) => session(`/sessions/${id}`),
  unresolved: (id: string) => session(`/sessions/${id}/unresolved`, 'POST'),
  analyze: (id: string, keys: string[]) => session(`/sessions/${id}/analyze`, 'POST', { keys }),
  resolve: (id: string) => session(`/sessions/${id}/resolve`, 'POST'),
  confirm: (id: string, title: string, description: string, vin: string) => request<Ticket>(`/sessions/${id}/confirm`, 'POST', { title, description, vin }),
  async upload(id: string, file: File) {
    const form = await request<{ key: string; url: string; fields: Record<string, string> }>(`/sessions/${id}/uploads`, 'POST', { name: file.name, contentType: file.type });
    const data = new FormData();
    Object.entries(form.fields).forEach(([key, value]) => data.append(key, value));
    data.append('file', file);
    const response = await fetch(form.url, { method: 'POST', body: data, signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error('Photo upload failed.');
    return form.key;
  },
};