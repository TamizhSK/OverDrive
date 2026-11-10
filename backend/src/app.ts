import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { z, ZodError } from 'zod';
import { createTicketSchema, attachmentSchema, chatContextSchema, priorities, statuses, type CustomerProfileSnapshot, type Ticket, type Role } from '@servicecare/contracts';
import { ConflictError, type Repository } from './tickets/repository.ts';
import { triage } from './triage/service.ts';
import { answerQuestion } from './knowledge/assistant.ts';
import { advisorDashboardEmbedUrl } from './analytics/quicksight.ts';
import { uploadForm, validateAttachment, downloadUrl } from './attachments/storage.ts';

type Identity = { id: string; role: Role };
type Bindings = { event?: { requestContext?: { authorizer?: { jwt?: { claims?: Record<string, unknown> } } } } };
/** Verifies a Cognito access token and returns its claims; throws when the token is not valid. */
export type TokenVerifier = (token: string) => Promise<Record<string, unknown>>;
const questionSchema = z.object({ question: z.string().trim().min(5).max(5000), vin: z.string().trim().min(1).max(32).optional() });
const messageSchema = z.object({ text: z.string().trim().min(1).max(2000), internal: z.boolean().default(false), version: z.number().int().positive() });
const patchSchema = z.object({ status: z.enum(statuses).optional(), priority: z.enum(priorities).optional(), version: z.number().int().positive() });
const transitions: Record<Ticket['status'], Ticket['status'][]> = {
  OPEN: ['ASSIGNED', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED'],
  ASSIGNED: ['IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED'],
  IN_PROGRESS: ['WAITING_FOR_CUSTOMER', 'RESOLVED'],
  WAITING_FOR_CUSTOMER: ['IN_PROGRESS', 'RESOLVED'], RESOLVED: ['CLOSED', 'IN_PROGRESS'], CLOSED: [],
};

function groupsFromClaim(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((group): group is string => typeof group === 'string');
  if (typeof raw !== 'string') return [];
  return raw.replaceAll('[', '').replaceAll(']', '').replaceAll('"', '').split(',').map(group => group.trim());
}

// Group names are compared case-insensitively so the ServiceCare groups and the pool's CUSTOMER/ADMIN groups both work.
const advisorGroups = new Set(['serviceadvisors', 'advisors', 'admins', 'admin']);
const customerGroups = new Set(['customers', 'customer']);

type CustomerDashboardPayload = {
  customer?: { owner_name?: string; owner_email?: string; owner_phone?: string; preferred_contact?: string };
  vehicles?: {
    vehicle?: { vin?: string; make?: string; model?: string; variant?: string; model_year?: number; registration?: string; colour?: string; body_style?: string; powertrain?: string; service_plan?: string; home_dealer?: string; last_service_date?: string; next_service_due_date?: string; region?: string };
    telemetry?: { signal_name?: string; reading_ts?: string; value_num?: number; value_text?: string; unit?: string; quality?: string; source?: string }[];
    diagnostic_events?: { dtc_code?: string; status?: string; severity?: string; safety_critical?: boolean; event_ts?: string; description?: { title?: string; plain_language?: string; recommended_action?: string } }[];
  }[];
};

function definedFields<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}

function dashboardProfile(dashboard: CustomerDashboardPayload, vin: string): CustomerProfileSnapshot | undefined {
  const selected = dashboard.vehicles?.find(item => item.vehicle?.vin === vin);
  if (!selected?.vehicle) return undefined;
  const vehicle = selected.vehicle;
  return {
    ...definedFields({ ownerName: dashboard.customer?.owner_name, ownerEmail: dashboard.customer?.owner_email, ownerPhone: dashboard.customer?.owner_phone, preferredContact: dashboard.customer?.preferred_contact }),
    vehicle: definedFields({ vin, make: vehicle.make, model: vehicle.model, variant: vehicle.variant, modelYear: vehicle.model_year, registration: vehicle.registration, colour: vehicle.colour, bodyStyle: vehicle.body_style, powertrain: vehicle.powertrain, servicePlan: vehicle.service_plan, homeDealer: vehicle.home_dealer, lastServiceDate: vehicle.last_service_date, nextServiceDueDate: vehicle.next_service_due_date, region: vehicle.region }),
    diagnosticEvents: (selected.diagnostic_events ?? []).map(event => definedFields({
      dtcCode: event.dtc_code, status: event.status, severity: event.severity, safetyCritical: event.safety_critical,
      title: event.description?.title, plainLanguage: event.description?.plain_language,
      recommendedAction: event.description?.recommended_action, eventAt: event.event_ts,
    })),
    telemetryReadings: (selected.telemetry ?? []).flatMap(reading => {
      if (!reading.signal_name || !reading.reading_ts) return [];
      return [definedFields({ signalName: reading.signal_name, readingAt: reading.reading_ts, value: reading.value_num ?? reading.value_text, unit: reading.unit, quality: reading.quality, source: reading.source })];
    }),
  };
}

async function fetchCustomerDashboard(url: string, authorization: string | undefined): Promise<CustomerDashboardPayload> {
  if (!authorization?.toLowerCase().startsWith('bearer ')) throw new HTTPException(401, { message: 'A valid customer session is required to select a vehicle.' });
  let response: Response;
  try {
    response = await fetch(url, { headers: { Authorization: authorization }, signal: AbortSignal.timeout(8000) });
  } catch {
    throw new HTTPException(503, { message: 'Vehicle verification is temporarily unavailable.' });
  }
  if (response.status === 401 || response.status === 403) throw new HTTPException(403, { message: 'This vehicle is not available to your account.' });
  if (!response.ok) throw new HTTPException(503, { message: 'Vehicle verification is temporarily unavailable.' });
  try {
    const dashboard = await response.json() as CustomerDashboardPayload;
    if (!Array.isArray(dashboard.vehicles)) throw new Error('Invalid dashboard response.');
    return dashboard;
  } catch {
    throw new HTTPException(503, { message: 'Vehicle verification returned an invalid response.' });
  }
}

async function customerProfileForVehicle(vin: string, authorization: string | undefined): Promise<CustomerProfileSnapshot> {
  const dashboardUrl = process.env.CUSTOMER_DASHBOARD_URL;
  if (!dashboardUrl) throw new HTTPException(503, { message: 'Vehicle verification is not configured.' });
  const profile = dashboardProfile(await fetchCustomerDashboard(dashboardUrl, authorization), vin);
  if (!profile) throw new HTTPException(403, { message: 'Select a vehicle linked to your account.' });
  return profile;
}

/** Compact, non-personal vehicle facts for the signed-in customer only; best effort so chat never fails because vehicle data is unavailable. */
export async function chatVehicleData(vin: string | undefined, authorization: string | undefined, question = '') {
  const dashboardUrl = process.env.CUSTOMER_DASHBOARD_URL;
  if (!dashboardUrl) return undefined;
  try {
    const dashboard = await fetchCustomerDashboard(dashboardUrl, authorization);
    const vehicles = dashboard.vehicles ?? [];
    const owned = vehicles.flatMap(item => item.vehicle?.vin ? [item.vehicle.vin] : []);
    const selectedVin = vin ?? owned.find(candidate => question.toUpperCase().includes(candidate.toUpperCase())) ?? owned[0];
    const profile = selectedVin ? dashboardProfile(dashboard, selectedVin) : undefined;
    if (!profile) { console.warn(JSON.stringify({ event: 'vehicle_data_none', vehicles: owned.length, requested: Boolean(vin) })); return undefined; }
    const { vehicle } = profile;
    const latest = new Map<string, (typeof profile.telemetryReadings)[number]>();
    for (const reading of profile.telemetryReadings) {
      const current = latest.get(reading.signalName);
      if (!current || reading.readingAt > current.readingAt) latest.set(reading.signalName, reading);
    }
    return {
      vehicle: definedFields({ vin: vehicle.vin, model: vehicle.model, variant: vehicle.variant, modelYear: vehicle.modelYear, powertrain: vehicle.powertrain, lastServiceDate: vehicle.lastServiceDate, nextServiceDueDate: vehicle.nextServiceDueDate }),
      faults: profile.diagnosticEvents.slice(0, 20),
      recordedReadings: [...latest.values()].slice(0, 40),
      otherVehiclesOnAccount: vehicles.flatMap(item => item.vehicle?.vin && item.vehicle.vin !== selectedVin ? [definedFields({ vin: item.vehicle.vin, model: item.vehicle.model })] : []),
    };
  } catch (error) {
    console.warn(JSON.stringify({ event: 'vehicle_data_unavailable', reason: (error as Error).message.slice(0, 200) }));
    return undefined;
  }
}

export async function verifyVehicleOwnership(vin: string, authorization: string | undefined): Promise<void> {
  await customerProfileForVehicle(vin, authorization);
}

async function verifiedClaims(authorization: string | undefined, verify: TokenVerifier) {
  const [scheme, token] = authorization?.split(' ') ?? [];
  const denied = new HTTPException(401, { message: 'A valid Cognito access token is required.' });
  if (scheme?.toLowerCase() !== 'bearer' || !token) throw denied;
  try { return await verify(token); } catch { throw denied; }
}

/**
 * `verifyToken` is for runtimes without an API Gateway authorizer (the agent ticket tools behind the AgentCore Gateway). When it is set it is the only
 * trusted source of identity; without it, only claims validated by the API Gateway JWT authorizer are accepted.
 */
export function createApp(repository: Repository, local = false, verifyToken?: TokenVerifier, originToken?: string) {
  const app = new Hono<{ Bindings: Bindings; Variables: { identity: Identity } }>();
  if (originToken) {
    const expected = createHash('sha256').update(originToken).digest();
    app.use('/api/*', async (context, next) => {
      const presented = createHash('sha256').update(context.req.header('x-origin-verify') ?? '').digest();
      if (!timingSafeEqual(expected, presented)) throw new HTTPException(403, { message: 'Requests must come through the ServiceCare edge.' });
      await next();
    });
  }
  app.use('/api/*', cors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173', allowHeaders: ['Content-Type', 'Authorization', ...(local ? ['X-Demo-Role'] : [])] }));
  app.get('/api/health', context => context.json({ status: 'ok', mode: local ? 'demo' : 'aws' }));
  app.use('/api/*', async (context, next) => {
    if (local && !(verifyToken && context.req.header('Authorization'))) {
      const role = context.req.header('X-Demo-Role') === 'advisor' ? 'advisor' : 'customer';
      context.set('identity', { id: role === 'advisor' ? 'advisor-demo' : 'customer-demo', role });
    } else {
      const claims = verifyToken ? await verifiedClaims(context.req.header('Authorization'), verifyToken) : context.env?.event?.requestContext?.authorizer?.jwt?.claims;
      if (!claims || typeof claims.sub !== 'string' || claims.token_use !== 'access') throw new HTTPException(401, { message: 'A valid Cognito access token is required.' });
      const groups = groupsFromClaim(claims['cognito:groups']).map(group => group.toLowerCase());
      const advisor = groups.some(group => advisorGroups.has(group));
      if (!advisor && !groups.some(group => customerGroups.has(group))) throw new HTTPException(403, { message: 'A ServiceCare role is required.' });
      context.set('identity', { id: claims.sub, role: advisor ? 'advisor' : 'customer' });
    }
    await next();
  });

  async function getTicket(id: string, identity: Identity) {
    const ticket = await repository.get(id);
    if (!ticket || (identity.role === 'customer' && ticket.customerId !== identity.id)) throw new HTTPException(404, { message: 'Ticket not found.' });
    return ticket;
  }
  function publicTicket(ticket: Ticket, identity: Identity) {
    return { ...ticket, messages: ticket.messages.filter(message => identity.role === 'advisor' || !message.internal) };
  }
  async function createTicket(input: unknown, identity: Identity, authorization?: string, requireVehicle = true) {
    if (identity.role !== 'customer') throw new HTTPException(403, { message: 'Use a customer account to create a ticket.' });
    const data = createTicketSchema.parse(input);
    const ticketId = data.requestId ? `TKT-${createHash('sha256').update(`${identity.id}:${data.requestId}`).digest('hex')}` : `TKT-${randomUUID()}`;
    const creationRequestHash = data.requestId ? createHash('sha256').update(JSON.stringify(data)).digest('hex') : undefined;
    if (data.requestId) {
      const existing = await repository.get(ticketId);
      if (existing) {
        if (existing.customerId !== identity.id || existing.creationRequestHash !== creationRequestHash) throw new ConflictError('This request ID was already used with different ticket details.');
        return publicTicket(existing, identity);
      }
    }
    let customerProfile: CustomerProfileSnapshot | undefined;
    if (!local && requireVehicle) {
      if (!data.vin) throw new HTTPException(400, { message: 'Select which vehicle this ticket is about.' });
      customerProfile = await customerProfileForVehicle(data.vin, authorization);
    }
    if (data.attachments.some(attachment => !attachment.key.startsWith(`${identity.id}/`) || local)) throw new HTTPException(400, { message: 'Attachment is missing, invalid, or not owned by you.' });
    const validAttachments = await Promise.all(data.attachments.map(attachment => validateAttachment(attachment)));
    if (validAttachments.some(valid => !valid)) throw new HTTPException(400, { message: 'Attachment is missing or invalid.' });
    const classification = await triage(`${data.title}\n${data.description}`, local);
    const now = new Date().toISOString();
    const ticket: Ticket = {
      ...data, ticketId, customerId: identity.id, ...(creationRequestHash ? { creationRequestHash } : {}), ...(customerProfile ? { customerProfile } : {}),
      category: classification.category, priority: classification.priority, aiSummary: classification.summary,
      status: 'OPEN', source: data.knowledgeBaseAttempted ? 'KNOWLEDGE_BASE' : 'CUSTOMER_PORTAL',
      advisorId: null, knowledgeBaseResolved: false, messages: [], history: [{ status: 'OPEN', at: now, actor: identity.id }], createdAt: now, updatedAt: now, version: 1,
    };
    try { await repository.save(ticket); }
    catch (error) {
      if (!(error instanceof ConflictError) || !data.requestId) throw error;
      const existing = await repository.get(ticketId);
      if (!existing || existing.customerId !== identity.id || existing.creationRequestHash !== creationRequestHash) throw error;
      return publicTicket(existing, identity);
    }
    // Advisor alerts, customer emails and the diagnostics workflow follow from the tickets table stream (events/stream.ts).
    return ticket;
  }

  app.get('/api/tickets', async context => {
    const identity = context.get('identity');
    const cursor = z.string().max(2048).optional().parse(context.req.query('cursor'));
    const page = await repository.list(identity.role === 'customer' ? identity.id : undefined, cursor);
    return context.json({ ...page, items: page.items.map(ticket => publicTicket(ticket, identity)) });
  });
  app.get('/api/advisor/overview', async context => {
    if (context.get('identity').role !== 'advisor') throw new HTTPException(403, { message: 'Advisor access required.' });
    return context.json(await repository.ticketOverview());
  });
  app.get('/api/customer/overview', async context => {
    const identity = context.get('identity');
    if (identity.role !== 'customer') throw new HTTPException(403, { message: 'Customer access required.' });
    return context.json(await repository.ticketOverview(identity.id));
  });
  app.post('/api/tickets', async context => context.json(await createTicket(await context.req.json(), context.get('identity'), context.req.header('Authorization')), 201));
  app.get('/api/tickets/:ticketId', async context => {
    const identity = context.get('identity');
    return context.json(publicTicket(await getTicket(context.req.param('ticketId'), identity), identity));
  });
  app.patch('/api/tickets/:ticketId', async context => {
    const identity = context.get('identity');
    if (identity.role !== 'advisor') throw new HTTPException(403, { message: 'Advisor access required.' });
    const data = patchSchema.parse(await context.req.json());
    const ticket = await getTicket(context.req.param('ticketId'), identity);
    if (data.version !== ticket.version) throw new ConflictError('Ticket changed. Refresh and retry.');
    if (data.status && data.status !== ticket.status && !transitions[ticket.status].includes(data.status)) throw new HTTPException(400, { message: 'This status transition is not allowed.' });
    if (ticket.category === 'SAFETY' && data.priority && !['HIGH', 'CRITICAL'].includes(data.priority)) throw new HTTPException(400, { message: 'Safety tickets must remain HIGH or CRITICAL.' });
    const now = new Date().toISOString();
    const updated = { ...ticket, status: data.status ?? ticket.status, priority: data.priority ?? ticket.priority, updatedAt: now, version: ticket.version + 1 };
    if (updated.status !== ticket.status) updated.history = [...ticket.history, { status: updated.status, at: now, actor: identity.id }];
    await repository.save(updated, ticket.version);
    return context.json(updated);
  });
  app.post('/api/tickets/:ticketId/assign', async context => {
    const identity = context.get('identity');
    if (identity.role !== 'advisor') throw new HTTPException(403, { message: 'Advisor access required.' });
    const { version } = z.object({ version: z.number().int().positive() }).parse(await context.req.json());
    const ticket = await getTicket(context.req.param('ticketId'), identity);
    if (version !== ticket.version) throw new ConflictError('Ticket changed. Refresh and retry.');
    if (ticket.status === 'CLOSED' || ticket.status === 'RESOLVED') throw new HTTPException(400, { message: 'Reopen this ticket before assigning it.' });
    const now = new Date().toISOString();
    const updated: Ticket = { ...ticket, advisorId: identity.id, status: ticket.status === 'OPEN' ? 'ASSIGNED' : ticket.status, updatedAt: now, version: ticket.version + 1, history: ticket.status === 'OPEN' ? [...ticket.history, { status: 'ASSIGNED', at: now, actor: identity.id }] : ticket.history };
    await repository.save(updated, ticket.version);
    return context.json(updated);
  });
  app.post('/api/tickets/:ticketId/messages', async context => {
    const identity = context.get('identity');
    const data = messageSchema.parse(await context.req.json());
    if (identity.role !== 'advisor' && data.internal) throw new HTTPException(403, { message: 'Internal notes are advisor-only.' });
    const ticket = await getTicket(context.req.param('ticketId'), identity);
    if (data.version !== ticket.version) throw new ConflictError('Ticket changed. Refresh and retry.');
    if (ticket.status === 'CLOSED') throw new HTTPException(400, { message: 'Closed tickets cannot receive messages.' });
    if (ticket.messages.length >= 100) throw new HTTPException(400, { message: 'Conversation limit reached. Please open a follow-up ticket.' });
    const now = new Date().toISOString();
    const updated = { ...ticket, version: ticket.version + 1, updatedAt: now, messages: [...ticket.messages, { id: randomUUID(), author: identity.id, role: identity.role, text: data.text, internal: data.internal, createdAt: now }] };
    await repository.save(updated, ticket.version);
    return context.json(publicTicket(updated, identity));
  });
  app.post('/api/assistant/ask', async context => {
    const { question, vin, context: followUp } = questionSchema.extend({ context: chatContextSchema.optional() }).parse(await context.req.json());
    const classification = await triage(followUp ? `${followUp.issue}\n${question}` : question, local);
    const vehicleData = !local && context.get('identity').role === 'customer' && process.env.AGENTCORE_HARNESS_ARN?.trim() && !classification.critical ? await chatVehicleData(vin, context.req.header('Authorization'), question) : undefined;
    const answer = await answerQuestion(question, classification, local, context.get('identity').id, followUp, vehicleData);
    const interaction = await repository.recordInteraction(context.get('identity').id, answer);
    return context.json({ ...answer, interactionId: interaction.interactionId, createdAt: interaction.createdAt });
  });
  app.get('/api/advisor/dashboard/embed', async context => {
    if (context.get('identity').role !== 'advisor') throw new HTTPException(403, { message: 'Advisor access required.' });
    if (!process.env.QUICKSIGHT_DASHBOARD_ID) throw new HTTPException(503, { message: 'Advisor analytics is not configured.' });
    try {
      return context.json({ embedUrl: await advisorDashboardEmbedUrl() });
    } catch (error) {
      if (error instanceof Error && error.name === 'UnsupportedPricingPlanException') {
        throw new HTTPException(503, { message: 'QuickSight embedded session capacity must be enabled.' });
      }
      if (error instanceof Error && error.name === 'ResourceNotFoundException') {
        throw new HTTPException(503, { message: 'The advisor analytics dashboard is not provisioned in this AWS account yet.' });
      }
      if (error instanceof Error && error.name === 'AccessDeniedException') {
        throw new HTTPException(503, { message: 'QuickSight dashboard permissions are not configured for the advisor service.' });
      }
      throw error;
    }
  });
  app.post('/api/assistant/feedback', async context => {
    const { question, resolved, interactionId } = questionSchema.extend({ resolved: z.boolean(), interactionId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i).optional() }).parse(await context.req.json());
    const identity = context.get('identity');
    if (identity.role !== 'customer') throw new HTTPException(403, { message: 'Customer access required.' });
    if (resolved) {
      if ((await triage(question, local)).critical) throw new HTTPException(400, { message: 'Safety concerns require advisor review.' });
      if (interactionId) await repository.resolveInteraction(identity.id, interactionId);
      else await repository.feedback(identity.id, question);
      return context.json({ resolved: true });
    }
    return context.json({ ticket: await createTicket({ title: question.slice(0, 150), description: `Unresolved service question: ${question}`, knowledgeBaseAttempted: true }, identity, undefined, false) }, 201);
  });
  app.get('/api/assistant/history', async context => {
    const identity = context.get('identity');
    if (identity.role !== 'customer') throw new HTTPException(403, { message: 'Customer access required.' });
    const cursor = z.string().max(2048).optional().parse(context.req.query('cursor'));
    return context.json(await repository.resolvedSessions(identity.id, cursor));
  });
  app.get('/api/advisor/interactions', async context => {
    if (context.get('identity').role !== 'advisor') throw new HTTPException(403, { message: 'Advisor access required.' });
    const cursor = z.string().max(2048).optional().parse(context.req.query('cursor'));
    const page = await repository.advisorInteractions(cursor);
    return context.json({
      items: page.items.map(({ interactionId, question, answer, source, resolved, createdAt }) => ({ interactionId, question, answer, source, resolved, createdAt })),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    });
  });
  app.post('/api/attachments/upload', async context => {
    if (local) throw new HTTPException(503, { message: 'Uploads require the AWS S3 integration. No file has been uploaded.' });
    const identity = context.get('identity');
    if (identity.role !== 'customer') throw new HTTPException(403, { message: 'Customer access required.' });
    const { contentType } = z.object({ contentType: attachmentSchema.shape.contentType }).parse(await context.req.json());
    return context.json(await uploadForm(identity.id, contentType));
  });
  app.get('/api/tickets/:ticketId/attachments/:index', async context => {
    const ticket = await getTicket(context.req.param('ticketId'), context.get('identity'));
    const index = z.coerce.number().int().nonnegative().parse(context.req.param('index'));
    if (!ticket.attachments[index]) throw new HTTPException(404);
    return context.json({ url: await downloadUrl(ticket.attachments[index].key) });
  });
  app.onError((error, context) => {
    if (error instanceof HTTPException) return context.json({ error: error.message }, error.status);
    if (error instanceof ZodError) return context.json({ error: error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') }, 400);
    if (error instanceof SyntaxError) return context.json({ error: 'Invalid JSON payload or pagination cursor.' }, 400);
    if (error instanceof ConflictError) return context.json({ error: error.message }, 409);
    console.error(JSON.stringify({ event: 'request_failed', name: error.name }));
    return context.json({ error: 'Service unavailable. Please try again.' }, 500);
  });
  return app;
}