import type {
  Attachment,
  AssistantAnswer,
  CreateTicket,
  ChatContext,
  ResolvedSession,
  Ticket,
} from "@servicecare/contracts";

import { authHeaders } from "./auth";
import { rememberDashboard } from "./dashboard-memory";

/* =========================================================
   Minimal customer dashboard response types
========================================================= */

export interface Customer {
  cognito_sub?: string;
  owner_id: string;
  owner_name?: string;
  owner_email?: string;
  owner_phone?: string;
  preferred_contact?: string;
}

export interface VehicleInfo {
  vin: string;
  make?: string;
  model?: string;
  variant?: string;
  model_year?: number;
  registration?: string;
  colour?: string;
  body_style?: string;
  powertrain?: string;
  service_plan?: string;
  home_dealer?: string;
  last_service_date?: string;
  next_service_due_date?: string;
  region?: string;
}

export interface TelemetryReading {
  reading_key: string;
  vin: string;
  signal_name: string;
  reading_ts: string;
  source?: string;
  quality?: string;
  unit?: string;
  value_num?: number;
  value_text?: string;
}

export interface DiagnosticEventDescription {
  title?: string;
  plain_language?: string;
  recommended_action?: string;
  system?: string;
  severity?: string;
  dtc_code?: string;
  safety_critical?: boolean;
  kb_article_id?: string;
}

export interface DiagnosticEvent {
  event_key: string;
  vin: string;
  dtc_code?: string;
  ecu?: string;
  status?: string;
  severity?: string;
  safety_critical?: boolean;
  occurrence_count?: number;
  odometer_km?: number;
  first_seen_ts?: string;
  event_ts?: string;
  description?: DiagnosticEventDescription;
}

export interface CustomerVehicle {
  vehicle: VehicleInfo;
  telemetry?: TelemetryReading[];
  diagnostic_events?: DiagnosticEvent[];
}

export interface DashboardSummary {
  total_vehicles?: number;
  total_diagnostic_events?: number;
  safety_critical_events?: number;
  active_events?: number;
}

export interface CustomerDashboard {
  status: string;
  customer: Customer;
  vehicles: CustomerVehicle[];
  summary?: DashboardSummary;
}

/* =========================================================
   Customer dashboard API
========================================================= */

const DASHBOARD_URL = import.meta.env.VITE_CUSTOMER_DASHBOARD_URL ?? "";

export async function getCustomerDashboard(): Promise<CustomerDashboard> {
  if (!DASHBOARD_URL) throw new Error("The customer dashboard API is not configured (VITE_CUSTOMER_DASHBOARD_URL).");
  const headers = await authHeaders();

  const response = await fetch(DASHBOARD_URL, {
    method: "GET",
    cache: "no-store",
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(30000),
  });

  const responseText = await response.text();

  if (!response.ok) {
    let errorMessage = `Dashboard request failed: ${response.status}`;

    try {
      const errorData = JSON.parse(responseText) as {
        message?: string;
        error?: string;
      };
      errorMessage = errorData.message ?? errorData.error ?? errorMessage;
    } catch {
      if (responseText.trim()) {
        errorMessage = responseText;
      }
    }

    throw new Error(errorMessage);
  }

  if (!responseText.trim()) {
    throw new Error("Dashboard API returned an empty response.");
  }

  const result = JSON.parse(responseText) as CustomerDashboard;

  if (!result.customer || !Array.isArray(result.vehicles)) {
    throw new Error("Dashboard API returned an unexpected response format.");
  }

  rememberDashboard(result);
  return result;
}

/* =========================================================
   General API request helper
========================================================= */

const API_BASE_URL = import.meta.env.VITE_API_URL ?? "";
const AGENT_TICKET_API_URL = import.meta.env.VITE_AGENT_TICKET_API_URL?.replace(/\/$/, '');
export const agentTicketsEnabled = Boolean(AGENT_TICKET_API_URL);

export async function request<Result>(
    path: string,
    method = "GET",
    body?: unknown,
): Promise<Result> {
  const response = await fetch(`${API_BASE_URL}/api${path}`, {
    method,
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  });

  const responseText = await response.text();
  let result: Record<string, unknown> = {};

  if (responseText.trim()) {
    try {
      result = JSON.parse(responseText) as Record<string, unknown>;
    } catch {
      if (!response.ok) {
        throw new Error(responseText || "The request could not be completed.");
      }
      throw new Error("The server returned an invalid response.");
    }
  }

  if (!response.ok) {
    throw new Error(
        String(
            result.error ??
            result.message ??
            "The request could not be completed.",
        ),
    );
  }

  return result as Result;
}

/* =========================================================
   Ticket API types
========================================================= */

export interface TicketPage {
  items: Ticket[];
  nextCursor?: string;
}

export interface InteractionPage {
  items: ResolvedSession[];
  nextCursor?: string;
}

export interface TicketOverview {
  open: number;
  unassigned: number;
  urgent: number;
  waiting: number;
}

export type AdvisorInteraction = Pick<ResolvedSession, 'interactionId' | 'question' | 'answer' | 'source' | 'resolved' | 'createdAt'>;

/* =========================================================
   Existing application API methods
========================================================= */

export const api = {
  async agentCreate(input: CreateTicket & { visualSessionId?: string }): Promise<Ticket> {
    if (!AGENT_TICKET_API_URL) throw new Error('Agent ticket tools are not configured.');
    const response = await fetch(`${AGENT_TICKET_API_URL}/agent/ticket-action`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...await authHeaders() }, body: JSON.stringify({ operation: 'create_ticket', requestId: input.requestId, confirmed: true, data: input }), signal: AbortSignal.timeout(30000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'The agent did not confirm a saved ticket.');
    return result.ticket as Ticket;
  },
  advisorDashboardEmbed: () => request<{ embedUrl: string }>('/advisor/dashboard/embed'),
  advisorOverview: () => request<TicketOverview>('/advisor/overview'),
  customerOverview: () => request<TicketOverview>('/customer/overview'),
  advisorInteractions: (cursor?: string) => request<{ items: AdvisorInteraction[]; nextCursor?: string }>(`/advisor/interactions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
  resolvedSessions: (cursor?: string) => request<InteractionPage>(`/assistant/history${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
  ask: (question: string, context?: ChatContext) => request<AssistantAnswer>('/assistant/ask', 'POST', { question, ...(context ? { context } : {}) }),
  feedback: (question: string, resolved: boolean, interactionId?: string) => request<{ resolved?: boolean; ticket?: Ticket }>('/assistant/feedback', 'POST', { question, resolved, interactionId }),
  async upload(file: File): Promise<Attachment> {
    if (file.size > 10 * 1024 * 1024) throw new Error('Each attachment must be 10 MB or smaller.');
    if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.type)) throw new Error('Choose a JPEG, PNG, WebP image or PDF.');
    const form = await request<{ url: string; fields: Record<string, string>; key: string }>('/attachments/upload', 'POST', { contentType: file.type });
    const data = new FormData();
    Object.entries(form.fields).forEach(([key, value]) => data.append(key, value));
    data.append('file', file);
    const response = await fetch(form.url, { method: 'POST', body: data, signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error('The attachment upload failed. Please try again.');
    return { key: form.key, name: file.name, contentType: file.type as Attachment['contentType'] };
  },
  async tickets(cursor?: string): Promise<TicketPage> {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    return request<TicketPage>(`/tickets${query}`);
  },

  ticket(id: string): Promise<Ticket> {
    return request<Ticket>(`/tickets/${encodeURIComponent(id)}`);
  },

  create(input: CreateTicket): Promise<Ticket> {
    return request<Ticket>("/tickets", "POST", input);
  },

};

/* =========================================================
   Utility functions
========================================================= */

export function label(value?: string | null): string {
  if (!value) return "—";

  return value
      .replace(/[_-]/g, " ")
      .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function shortId(value?: string | null): string {
  if (!value) return "—";

  return value.length > 12
      ? `${value.slice(0, 6)}...${value.slice(-4)}`
      : value;
}

export function date(value?: string | null): string {
  if (!value) return "—";

  const parsed = new Date(value.replace(" ", "T"));

  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}
