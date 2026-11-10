import { createHash } from 'node:crypto';
import { z } from 'zod';
import { priorities, statuses } from '@servicecare/contracts';

export const ticketToolSchemas = {
  create_ticket: z.object({ title: z.string().trim().min(5).max(150), description: z.string().trim().min(10).max(5000), vin: z.string().trim().min(1).max(64), knowledgeBaseAttempted: z.boolean().default(false), visualSessionId: z.string().uuid().optional() }),
  get_ticket: z.object({ ticketId: z.string().min(5).max(128) }),
  update_ticket: z.object({ ticketId: z.string().min(5).max(128), version: z.number().int().positive(), status: z.enum(statuses).optional(), priority: z.enum(priorities).optional() }),
  assign_advisor: z.object({ ticketId: z.string().min(5).max(128), version: z.number().int().positive() }),
};
export type TicketTool = keyof typeof ticketToolSchemas;
const names = new Set(Object.keys(ticketToolSchemas));
export function toolName(qualified: string): TicketTool {
  const name = qualified.split('___').at(-1)!;
  if (!names.has(name)) throw new Error('Unknown ticket tool.');
  return name as TicketTool;
}
export function approvedPayloadHash(tool: TicketTool, input: unknown) {
  return createHash('sha256').update(JSON.stringify(ticketToolSchemas[tool].parse(input))).digest('hex');
}
export function ticketToolDefinitions() {
  return Object.entries(ticketToolSchemas).map(([name, schema]) => ({
    name,
    description: name === 'assign_advisor' ? 'Assign a ticket to the authenticated advisor. Backend authorization and version checks are mandatory.' : `${name.replaceAll('_', ' ')} through the existing authorized ticket backend. Writes require confirmed, unchanged input.`,
    inputSchema: z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }),
  }));
}
type GatewayRequest = { headers?: Record<string, string>; body?: { jsonrpc?: string; id?: unknown; method?: string; params?: { name?: string; arguments?: unknown } } };
export function ticketGatewayInterceptor(verify: (token: string) => Promise<Record<string, unknown>>, writesEnabled: boolean) {
  return async (event: { mcp?: { gatewayRequest?: GatewayRequest } }) => {
    const request = event.mcp?.gatewayRequest;
    const body = request?.body;
    try {
      if (!body || !request?.headers) throw new Error('Missing authenticated gateway request.');
      const headers = Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value]));
      const authorization = headers.authorization ?? '';
      if (!/^Bearer \S+$/i.test(authorization)) throw new Error('Cognito access token required.');
      const claims = await verify(authorization.split(' ')[1]);
      if (typeof claims.sub !== 'string' || claims.token_use !== 'access') throw new Error('Cognito access token required.');
      if (body.method !== 'tools/call') {
        if (!['initialize', 'tools/list', 'notifications/initialized', 'ping'].includes(body.method ?? '')) throw new Error('Unsupported MCP method.');
        return { interceptorOutputVersion: '1.0', mcp: { transformedGatewayRequest: { body } } };
      }
      const tool = toolName(body.params?.name ?? '');
      const groups = Array.isArray(claims['cognito:groups']) ? claims['cognito:groups'].map(value => String(value).toLowerCase()) : [];
      const advisor = groups.some(group => ['admin', 'admins', 'advisors', 'serviceadvisors'].includes(group));
      const customer = groups.some(group => ['customer', 'customers'].includes(group));
      if (!advisor && !customer) throw new Error('Service role required.');
      if (tool === 'create_ticket' && (!customer || advisor)) throw new Error('Customer access required.');
      if (['update_ticket', 'assign_advisor'].includes(tool) && !advisor) throw new Error('Advisor access required.');
      if (headers['x-servicecare-operation'] !== tool) throw new Error('Operation was not approved.');
      if (headers['x-servicecare-payload-hash'] !== approvedPayloadHash(tool, body.params?.arguments)) throw new Error('Tool changed approved input.');
      const write = tool !== 'get_ticket';
      if (write && (!writesEnabled || headers['x-servicecare-confirmed'] !== 'true')) throw new Error('Ticket writes require confirmed intent and enabled policy.');
      const requestId = write ? z.string().uuid().parse(headers['x-servicecare-request-id']) : undefined;
      const args = ticketToolSchemas[tool].parse(body.params?.arguments);
      return { interceptorOutputVersion: '1.0', mcp: { transformedGatewayRequest: { body: {
        ...body, params: { ...body.params, arguments: { ...args, _authorization: authorization, _operation: tool, _requestId: requestId } },
      } } } };
    } catch {
      return { interceptorOutputVersion: '1.0', mcp: { transformedGatewayResponse: { statusCode: 403, body: {
        jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32001, message: 'Ticket tool request was not authorized.' },
      } } } };
    }
  };
}
export function ticketGatewayAdapter(request: (path: string, init: RequestInit) => Response | Promise<Response>, expectedGatewayId: string, writesEnabled: boolean) {
  return async (event: Record<string, unknown>, context: { clientContext?: { custom?: Record<string, string> } }) => {
    const metadata = context.clientContext?.custom;
    if (!expectedGatewayId || metadata?.bedrockAgentCoreGatewayId !== expectedGatewayId) throw new Error('Unapproved gateway invocation.');
    const tool = toolName(metadata.bedrockAgentCoreToolName ?? '');
    if (event._operation !== tool || typeof event._authorization !== 'string') throw new Error('Trusted caller context is missing.');
    if (tool !== 'get_ticket' && !writesEnabled) throw new Error('Ticket tools are read-only.');
    const data = ticketToolSchemas[tool].parse(event);
    let path = '/api/tickets';
    let method = 'POST';
    let payload: unknown = data;
    if (tool === 'create_ticket') {
      const creation = data as z.infer<typeof ticketToolSchemas.create_ticket>;
      if (creation.visualSessionId) {
        path = `/visual/sessions/${encodeURIComponent(creation.visualSessionId)}/confirm`;
        payload = { title: creation.title, description: creation.description, vin: creation.vin };
      } else payload = { ...data, requestId: z.string().uuid().parse(event._requestId) };
    }
    else {
      const ticket = data as { ticketId: string; version?: number; status?: string; priority?: string };
      path += `/${encodeURIComponent(ticket.ticketId)}`;
      if (tool === 'get_ticket') method = 'GET';
      else if (tool === 'assign_advisor') { path += '/assign'; payload = { version: ticket.version }; }
      else { method = 'PATCH'; payload = { version: ticket.version, status: ticket.status, priority: ticket.priority }; }
    }
    const response = await request(path, { method, headers: { Authorization: event._authorization, 'Content-Type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify(payload) }) });
    const result = await response.json();
    return response.ok ? { ok: true, ticket: result } : { ok: false, status: response.status, error: result.error ?? result.message ?? 'Ticket operation failed.' };
  };
}