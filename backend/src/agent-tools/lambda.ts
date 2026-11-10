import { createApp, verifyVehicleOwnership } from '../app.ts';
import { cognitoVerifier } from '../auth/cognito.ts';
import { dynamoRepository } from '../tickets/repository.ts';
import { ticketGatewayAdapter, ticketGatewayInterceptor } from './gateway.ts';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { handle } from 'hono/aws-lambda';
import { z, ZodError } from 'zod';
import { BedrockAgentCoreClient, InvokeHarnessCommand } from '@aws-sdk/client-bedrock-agentcore';
import { runTicketAgent } from './agent.ts';
import { classifyIssue } from '../triage/rules.ts';

const verify = cognitoVerifier();
const writesEnabled = process.env.AGENT_TICKET_WRITES_ENABLED === 'true';
const app = createApp(dynamoRepository(), false, verify);
export const interceptorHandler = ticketGatewayInterceptor(verify, writesEnabled);
export const toolHandler = ticketGatewayAdapter(async (path, init) => {
	if (!path.startsWith('/visual/')) return app.request(path, init);
	const data = JSON.parse(String(init.body));
	await verifyVehicleOwnership(data.vin, (init.headers as Record<string, string>).Authorization);
	if (!process.env.VISUAL_API_URL) throw new Error('Visual service is not configured.');
	return fetch(`${process.env.VISUAL_API_URL}${path}`, { ...init, signal: AbortSignal.timeout(20000) });
}, process.env.EXPECTED_GATEWAY_ID ?? '', writesEnabled);

const broker = new Hono();
broker.use('/agent/*', cors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173', allowHeaders: ['Content-Type', 'Authorization'] }));
broker.post('/agent/ticket-action', async context => {
	if (!process.env.TICKET_GATEWAY_URL || !process.env.AGENTCORE_HARNESS_ARN) return context.json({ error: 'Agent ticket tools are not configured.' }, 503);
	const authorization = context.req.header('Authorization') ?? '';
	if (!/^Bearer \S+$/i.test(authorization)) return context.json({ error: 'Cognito access token required.' }, 401);
	let claims: Record<string, unknown>;
	try { claims = await verify(authorization.split(' ')[1]); }
	catch { return context.json({ error: 'A valid Cognito access token is required.' }, 401); }
	const groups = Array.isArray(claims['cognito:groups']) ? claims['cognito:groups'].map(value => String(value).toLowerCase()) : [];
	const advisor = groups.some(group => ['admin', 'admins', 'advisors', 'serviceadvisors'].includes(group));
	const customer = groups.some(group => ['customer', 'customers'].includes(group));
	const input = z.object({ operation: z.enum(['create_ticket', 'get_ticket', 'update_ticket', 'assign_advisor']), data: z.record(z.string(), z.unknown()), requestId: z.string().uuid(), confirmed: z.boolean().default(false) }).parse(await context.req.json());
	if ((!customer && !advisor) || (input.operation === 'create_ticket' && (!customer || advisor)) || (['update_ticket', 'assign_advisor'].includes(input.operation) && !advisor)) return context.json({ error: 'This operation is not permitted for your role.' }, 403);
	const classification = classifyIssue(`${input.data.title ?? ''}\n${input.data.description ?? ''}`);
	const urgent = input.operation === 'create_ticket' && (classification.critical || ['HIGH', 'CRITICAL'].includes(classification.priority));
	const confirmed = input.confirmed || urgent;
	if (input.operation !== 'get_ticket' && (!writesEnabled || !confirmed)) return context.json({ error: 'Confirmed intent and enabled write policy are required.' }, 403);
	const client = new BedrockAgentCoreClient({ region: 'eu-north-1', maxAttempts: 1 });
	const ticket = await runTicketAgent({ harnessArn: process.env.AGENTCORE_HARNESS_ARN, gatewayUrl: process.env.TICKET_GATEWAY_URL, authorization, actorId: String(claims.sub), operation: input.operation, data: input.data, requestId: input.requestId, confirmed, advisor }, async request => {
		const result = await client.send(new InvokeHarnessCommand(request), { abortSignal: AbortSignal.timeout(25000) });
		if (!result.stream) throw new Error('No agent result.');
		return result.stream;
	});
	return context.json({ ticket }, input.operation === 'create_ticket' ? 201 : 200);
});
broker.onError((error, context) => {
	if (error instanceof ZodError) return context.json({ error: 'Required ticket details are missing or invalid.' }, 400);
	console.error(JSON.stringify({ event: 'agent_ticket_failed', name: error.name }));
	return context.json({ error: 'The agent did not confirm a saved ticket action. Check your requests before retrying.' }, 503);
});
export const httpHandler = handle(broker);