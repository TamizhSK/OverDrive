import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z, ZodError } from 'zod';
import type { VisualAnalysis, VisualSession } from '@servicecare/contracts/visual';
import { visualService, VisualError, type VisualDependencies } from './service.ts';
import { HTTPException } from 'hono/http-exception';
import { createTicketSchema } from '@servicecare/contracts';
import { verifyVehicleOwnership } from '../app.ts';

type Bindings = { event?: { requestContext?: { authorizer?: { jwt?: { claims?: Record<string, unknown> } } } } };
function advisorVisualView(session: VisualSession) {
  const { analysis } = session;
  return {
    sessionId: session.sessionId, question: session.question, phase: session.phase,
    critical: session.critical, ticketId: session.ticketId, error: session.error,
    ...(analysis ? { analysis: {
      summary: analysis.summary,
      observations: analysis.observations,
      uncertainties: analysis.uncertainties,
      safetyConcern: analysis.safetyConcern,
      analyzedAt: analysis.analyzedAt,
      guidance: { answer: analysis.guidance.answer, grounded: analysis.guidance.grounded, citations: analysis.guidance.citations.map(({ title }) => ({ title })) },
    } satisfies Pick<VisualAnalysis, 'summary' | 'observations' | 'uncertainties' | 'safetyConcern' | 'analyzedAt'> & { guidance: { answer: string; grounded: boolean; citations: { title: string }[] } } } : {}),
  };
}
export function createVisualApp(deps: VisualDependencies, verifyVehicle = verifyVehicleOwnership) {
  const service = visualService(deps);
  const app = new Hono<{ Bindings: Bindings; Variables: { ownerId: string; advisor: boolean } }>();
  const allowedOrigins = new Set((process.env.WEB_ORIGINS ?? process.env.WEB_ORIGIN ?? 'http://localhost:5173').split(',').map(origin => origin.trim()).filter(Boolean));
  app.use('/visual/*', cors({ origin: origin => allowedOrigins.has(origin) ? origin : undefined, allowHeaders: ['Content-Type', 'Authorization'] }));
  app.use('/visual/*', async (context, next) => {
    const claims = context.env?.event?.requestContext?.authorizer?.jwt?.claims;
    if (!claims || typeof claims.sub !== 'string' || claims.token_use !== 'access') return context.json({ error: 'Cognito access token required.' }, 401);
    const groups = Array.isArray(claims['cognito:groups']) ? claims['cognito:groups'] : String(claims['cognito:groups'] ?? '').replace(/[\[\]"]/g, '').split(',');
    const names = groups.map(group => String(group).trim().toLowerCase());
    const advisor = names.some(group => ['admin', 'admins', 'advisors', 'serviceadvisors'].includes(group));
    if (!advisor && !names.some(group => ['customer', 'customers'].includes(group))) return context.json({ error: 'Service role required.' }, 403);
    if (advisor && context.req.method !== 'GET') return context.json({ error: 'Use a customer account for visual support.' }, 403);
    context.set('ownerId', claims.sub);
    context.set('advisor', advisor);
    await next();
  });
  app.post('/visual/sessions', async context => {
    const { question } = z.object({ question: z.string().trim().min(5).max(5000) }).parse(await context.req.json());
    return context.json(await service.start(context.get('ownerId'), question), 201);
  });
  app.get('/visual/advisor/sessions', async context => {
    if (!context.get('advisor')) return context.json({ error: 'Advisor access required.' }, 403);
    const cursor = z.string().max(2048).optional().parse(context.req.query('cursor'));
    const page = await deps.store.listForAdvisor(cursor);
    return context.json({
      items: page.items.map(advisorVisualView),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    });
  });
  app.get('/visual/sessions/:id', async context => {
    const session = await service.get(z.string().uuid().parse(context.req.param('id')), context.get('advisor') ? undefined : context.get('ownerId'));
    return context.json(context.get('advisor') ? advisorVisualView(session) : session);
  });
  app.post('/visual/sessions/:id/unresolved', async context => context.json(await service.unresolved(context.req.param('id'), context.get('ownerId'))));
  app.post('/visual/sessions/:id/uploads', async context => context.json(await service.upload(context.req.param('id'), context.get('ownerId'), await context.req.json())));
  app.post('/visual/sessions/:id/analyze', async context => {
    const { keys } = z.object({ keys: z.array(z.string().max(512)).min(1).max(5) }).parse(await context.req.json());
    return context.json(await service.submit(context.req.param('id'), context.get('ownerId'), keys), 202);
  });
  app.post('/visual/sessions/:id/resolve', async context => context.json(await service.resolve(context.req.param('id'), context.get('ownerId'))));
  app.post('/visual/sessions/:id/confirm', async context => {
    const input = createTicketSchema.extend({ vin: z.string().trim().min(1).max(64) }).parse(await context.req.json());
    await verifyVehicle(input.vin, context.req.header('Authorization'));
    return context.json(await service.confirm(context.req.param('id'), context.get('ownerId'), input), 201);
  });
  app.get('/visual/tickets/:id/analysis', async context => {
    const ticket = await deps.store.ticket(context.req.param('id'));
    if (!ticket || (!context.get('advisor') && ticket.customerId !== context.get('ownerId'))) return context.json({ error: 'Ticket not found.' }, 404);
    return context.json({ analysis: ticket.visualAnalysis ?? null });
  });
  app.onError((error, context) => {
    if (error instanceof HTTPException) return context.json({ error: error.message }, error.status);
    if (error instanceof VisualError) return context.json({ error: error.message }, error.status);
    if (error instanceof ZodError || error instanceof SyntaxError) return context.json({ error: 'Invalid visual-support request.' }, 400);
    console.error(JSON.stringify({ event: 'visual_request_failed', name: error.name }));
    return context.json({ error: 'Visual support is unavailable. Regular service requests remain available.' }, 503);
  });
  return app;
}