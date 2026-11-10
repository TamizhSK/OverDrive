import { approvedPayloadHash, ticketGatewayAdapter, ticketGatewayInterceptor } from '../src/agent-tools/gateway.ts';
import { runTicketAgent } from '../src/agent-tools/agent.ts';

test('agent ticket success requires a registered tool receipt, not model prose', async () => {
  const input = { harnessArn: 'arn:aws:bedrock-agentcore:eu-north-1:123456789012:harness/Test-AbCdEfGhIj', gatewayUrl: 'https://test-abcdefghij.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp', authorization: 'Bearer synthetic-token', actorId: 'owner', operation: 'get_ticket' as const, data: { ticketId: 'TKT-test' }, requestId: 'd58f1220-6d77-4a99-9b25-8f88bd7a65e2', confirmed: false, advisor: false };
  const prose = async function* () { yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'I created TKT-fake.' } } }; };
  await assert.rejects(runTicketAgent(input, async () => prose()), /No confirmed backend/);
  const tool = async function* () {
    yield { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'call-1', name: 'ticketbackend___get_ticket' } } } };
    yield { contentBlockStart: { contentBlockIndex: 1, start: { toolResult: { toolUseId: 'call-1', status: 'success' as const } } } };
    yield { contentBlockDelta: { contentBlockIndex: 1, delta: { toolResult: [{ json: { ok: true, ticket: { ticketId: 'TKT-test', customerId: 'owner', status: 'OPEN', version: 1 } } }] } } };
  };
  assert.equal((await runTicketAgent(input, async request => {
    assert.deepEqual(request.allowedTools, ['@servicecare_tickets/ticketbackend___get_ticket']);
    assert.equal(request.messages?.[0].content?.[0].text?.includes('synthetic-token'), false);
    return tool();
  })).ticketId, 'TKT-test');
  const wrongTicket = async function* () {
    yield { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'call-1', name: 'ticketbackend___get_ticket' } } } };
    yield { contentBlockStart: { contentBlockIndex: 1, start: { toolResult: { toolUseId: 'call-1', status: 'success' as const } } } };
    yield { contentBlockDelta: { contentBlockIndex: 1, delta: { toolResult: [{ json: { ok: true, ticket: { ticketId: 'TKT-other', customerId: 'owner', status: 'OPEN', version: 1 } } }] } } };
  };
  await assert.rejects(runTicketAgent(input, async () => wrongTicket()), /approved ticket/);
  const errorResult = async function* () {
    yield { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'call-1', name: 'ticketbackend___get_ticket' } } } };
    yield { contentBlockStart: { contentBlockIndex: 1, start: { toolResult: { toolUseId: 'call-1', status: 'error' as const } } } };
    yield { contentBlockDelta: { contentBlockIndex: 1, delta: { toolResult: [{ json: { ok: true, ticket: { ticketId: 'TKT-test', customerId: 'owner', status: 'OPEN', version: 1 } } }] } } };
  };
  await assert.rejects(runTicketAgent(input, async () => errorResult()), /No confirmed backend/);
});

test('gateway binds the verified caller and rejects changed intent or customer mutation tools', async () => {
  const data = { title: 'Phone pairing concern', description: 'Pairing remains unavailable after approved troubleshooting.', vin: 'test-vin' };
  const interceptor = ticketGatewayInterceptor(async () => ({ sub: 'owner', token_use: 'access', 'cognito:groups': ['CUSTOMER'] }), true);
  const event = { mcp: { gatewayRequest: { headers: { Authorization: 'Bearer synthetic-token', 'x-servicecare-operation': 'create_ticket', 'x-servicecare-payload-hash': approvedPayloadHash('create_ticket', data), 'x-servicecare-confirmed': 'true', 'x-servicecare-request-id': 'd58f1220-6d77-4a99-9b25-8f88bd7a65e2' }, body: { method: 'tools/call', params: { name: 'ticketbackend___create_ticket', arguments: { ...data, customerId: 'forged', _authorization: 'forged' } } } } } };
  const result = await interceptor(event);
  assert.equal((result.mcp.transformedGatewayRequest?.body.params?.arguments as Record<string, unknown>)._authorization, 'Bearer synthetic-token');
  event.mcp.gatewayRequest.body.params.arguments.description = 'Changed input must be rejected before invoking the target.';
  assert.equal((await interceptor(event)).mcp.transformedGatewayResponse?.statusCode, 403);
  event.mcp.gatewayRequest.body.params.name = 'ticketbackend___update_ticket';
  assert.equal((await interceptor(event)).mcp.transformedGatewayResponse?.statusCode, 403);
});
test('gateway adapter uses backend authorization and refuses unapproved invocation contexts', async () => {
  let calls = 0;
  const adapter = ticketGatewayAdapter(async (path, init) => {
    calls++; assert.equal(path, '/api/tickets/TKT-test');
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer synthetic-token');
    return Response.json({ ticketId: 'TKT-test', status: 'OPEN' });
  }, 'approved-gateway', false);
  const args = { ticketId: 'TKT-test', _authorization: 'Bearer synthetic-token', _operation: 'get_ticket' };
  await assert.rejects(adapter(args, { clientContext: { custom: { bedrockAgentCoreGatewayId: 'other' } } }));
  assert.equal(calls, 0);
  const result = await adapter(args, { clientContext: { custom: { bedrockAgentCoreGatewayId: 'approved-gateway', bedrockAgentCoreToolName: 'ticketbackend___get_ticket' } } });
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
});
test('ticket request IDs are owner-scoped and protect duplicate creation', async () => {
  const repository = memoryRepository();
  const app = createApp(repository, true);
  const payload = { requestId: 'd58f1220-6d77-4a99-9b25-8f88bd7a65e2', title: 'Bluetooth pairing concern', description: 'Phone pairing remains unavailable after the approved steps.' };
  const create = (body = payload) => app.request('/api/tickets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const first = await create();
  const second = await create();
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal((await first.json()).ticketId, (await second.json()).ticketId);
  assert.equal((await repository.list('customer-demo')).items.length, 1);
  const stored = (await repository.list('customer-demo')).items[0];
  await app.request(`/api/tickets/${stored.ticketId}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Demo-Role': 'advisor' }, body: JSON.stringify({ version: 1, text: 'Advisor internal note', internal: true }) });
  assert.equal((await (await create()).json()).messages.length, 0);
  assert.equal((await create({ ...payload, description: 'Different details must not reuse the request ID.' })).status, 409);
});
test('chat offers one alternative then escalation, and checks new critical details', async () => {
  const app = createApp(memoryRepository(), true);
  const ask = async (question: string, context?: unknown) => (await (await app.request('/api/assistant/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, context }) })).json());
  const first = await ask('My Bluetooth will not connect');
  const context = { issue: first.question, previousAnswers: [first.answer], unresolved: true };
  const second = await ask('It is still not connecting', context);
  assert.equal(second.nextAction, 'guidance');
  assert.notEqual(first.answer, second.answer);
  const third = await ask('It is still not resolved', { ...context, previousAnswers: [first.answer, second.answer] });
  assert.equal(third.nextAction, 'offer-ticket');
  assert.equal(third.reason, 'no-alternative');
  const safety = await ask('There is smoke coming from the vehicle now', context);
  assert.equal(safety.nextAction, 'urgent-ticket');
  assert.equal(safety.source, 'safety-rule');
});
test('unresolved harness follow-ups request distinct steps and reject repeated guidance', async () => {
  let prompt = '';
  const previous = 'Open Bluetooth settings and pair your phone.';
  const deps = { retrieve: async (issue: string) => {
    assert.equal(issue, 'My Bluetooth will not connect');
    return [{ text: 'Pair a phone. Alternatively remove the old pairing on both devices.', reference: 's3://approved/manual.pdf' }];
  }, invoke: async (value: string) => { prompt = value; return JSON.stringify({ answer: previous, citationIds: [0] }); } };
  const context = { issue: 'My Bluetooth will not connect', previousAnswers: [previous], unresolved: true };
  assert.equal((await agentcoreGuidance('It still will not connect', 'customer', deps, context)).grounded, false);
  assert.match(prompt, /previouslyTriedGuidance/);
  assert.match(prompt, /distinct next steps/);
  deps.invoke = async () => JSON.stringify({ answer: 'Remove old pairings from both devices before starting a fresh connection.', citationIds: [0] });
  assert.equal((await agentcoreGuidance('It still will not connect', 'customer', deps, context)).grounded, true);
});
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyIssue } from '../src/triage/rules.ts';
import { createTicketSchema, statuses } from '@servicecare/contracts';
import { chatVehicleData, createApp } from '../src/app.ts';
import { memoryRepository } from '../src/tickets/repository.ts';
import { agentcoreGuidance, harnessConfig } from '../src/knowledge/agentcore.ts';
import { normalizeStreamRecord, processStreamBatch, type DynamoStreamRecord } from '../src/analytics/stream.ts';

test('safety reports bypass the knowledge base and receive high priority', () => {
  for (const issue of ['How do I reset a brake warning?', 'Unusual noise during braking', 'Battery is swelling', 'Smoke from engine', 'Steering is stiff']) {
    const result = classifyIssue(issue);
    assert.equal(result.critical, true, issue);
    assert.equal(result.knowledgeBaseEligible, false, issue);
    assert.equal(result.priority, 'HIGH', issue);
  }
});
test('routine questions can use self-service', () => {
  const result = classifyIssue('How can I reconnect my phone?');
  assert.equal(result.knowledgeBaseEligible, true);
  assert.equal(result.category, 'CONNECTIVITY');
});
test('typed concerns search approved guidance first and only safety skips it', async () => {
  const app = createApp(memoryRepository(), true);
  const ask = async (question: string) => (await app.request('/api/assistant/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question }) })).json();
  const display = await ask('My infotainment display keeps restarting.');
  assert.equal(display.triage.knowledgeBaseEligible, true);
  assert.doesNotMatch(display.answer, /individual review/);
  assert.equal((await ask('There is smoke coming from the car.')).source, 'safety-rule');
});
test('direct tickets and shared contracts include the agreed edge cases', () => {
  assert.equal(classifyIssue('The air conditioning is not cooling').category, 'CLIMATE_CONTROL');
  assert.equal(classifyIssue('The air conditioning is not cooling').knowledgeBaseEligible, true);
  assert.equal(classifyIssue('The air conditioning is not cooling').priority, 'MEDIUM');
  assert.ok(statuses.includes('WAITING_FOR_CUSTOMER'));
  assert.equal(createTicketSchema.safeParse({ title: 'x', description: '' }).success, false);
});

test('ticket lifecycle, roles, private notes and conflict protection', async () => {
  const app = createApp(memoryRepository(), true);
  const request = (path: string, method = 'GET', body?: unknown, advisor = false) => app.request(`/api${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Demo-Role': advisor ? 'advisor' : 'customer' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const created = await request('/tickets', 'POST', { title: 'Brake warning light', description: 'The brake warning remains on while driving.' });
  assert.equal(created.status, 201);
  const ticket = await created.json();
  assert.equal(ticket.priority, 'HIGH');
  assert.equal((await request(`/tickets/${ticket.ticketId}`, 'PATCH', { version: 1, status: 'IN_PROGRESS' })).status, 403);
  assert.equal((await request(`/tickets/${ticket.ticketId}`, 'PATCH', { version: 1, priority: 'LOW' }, true)).status, 400);
  const assigned = await request(`/tickets/${ticket.ticketId}/assign`, 'POST', { version: 1 }, true);
  assert.equal((await assigned.json()).status, 'ASSIGNED');
  assert.equal((await request(`/tickets/${ticket.ticketId}/assign`, 'POST', { version: 1 }, true)).status, 409);
  await request(`/tickets/${ticket.ticketId}/messages`, 'POST', { version: 2, text: 'Advisor internal assessment', internal: true }, true);
  assert.equal((await (await request(`/tickets/${ticket.ticketId}`)).json()).messages.length, 0);
  assert.equal((await (await request(`/tickets/${ticket.ticketId}`, 'GET', undefined, true)).json()).messages.length, 1);
});

test('ticket overview is role-scoped and counts beyond the first queue page', async () => {
  const app = createApp(memoryRepository(), true);
  for (let index = 0; index < 51; index++) {
    const response = await app.request('/api/tickets', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Demo-Role': 'customer' },
      body: JSON.stringify({ title: `Brake warning light ${index}`, description: 'The brake warning remains on while driving.' }),
    });
    assert.equal(response.status, 201);
  }
  assert.equal((await app.request('/api/advisor/overview', { headers: { 'X-Demo-Role': 'customer' } })).status, 403);
  const advisor = await app.request('/api/advisor/overview', { headers: { 'X-Demo-Role': 'advisor' } });
  assert.deepEqual(await advisor.json(), { open: 51, unassigned: 51, urgent: 51, waiting: 0 });
  const customer = await app.request('/api/customer/overview', { headers: { 'X-Demo-Role': 'customer' } });
  assert.deepEqual(await customer.json(), { open: 51, unassigned: 51, urgent: 51, waiting: 0 });
  assert.equal((await app.request('/api/customer/overview', { headers: { 'X-Demo-Role': 'advisor' } })).status, 403);
});

test('real ticket creation requires a VIN owned by the authenticated customer', async () => {
  const previousFetch = globalThis.fetch;
  const previousDashboardUrl = process.env.CUSTOMER_DASHBOARD_URL;
  process.env.CUSTOMER_DASHBOARD_URL = 'https://vehicles.example/customer/dashboard';
  globalThis.fetch = async () => new Response(JSON.stringify({
    customer: { owner_name: 'Customer One', owner_email: 'customer@example.com' },
    vehicles: [{
      vehicle: { vin: 'WBA00000000000001', model: 'i4', model_year: 2024 },
      telemetry: [{ signal_name: 'battery_voltage', reading_ts: '2026-10-01T12:00:00Z', value_num: 12.4, unit: 'V', quality: 'good' }],
      diagnostic_events: [{ dtc_code: 'B1000', status: 'active', safety_critical: true, description: { title: 'Airbag system fault', plain_language: 'The airbag system reported a fault.' } }],
    }],
  }), { status: 200 });
  try {
    const app = createApp(memoryRepository(), false, async () => ({ sub: 'customer-1', token_use: 'access', 'cognito:groups': ['CUSTOMER'] }));
    const request = (vin?: string) => app.request('/api/tickets', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Display issue', description: 'The center display stopped responding.', ...(vin ? { vin } : {}) }),
    });
    assert.equal((await request()).status, 400);
    assert.equal((await request('WBA99999999999999')).status, 403);
    const created = await request('WBA00000000000001');
    assert.equal(created.status, 201);
    const ticket = await created.json();
    assert.equal(ticket.vin, 'WBA00000000000001');
    assert.equal(ticket.customerProfile.ownerEmail, 'customer@example.com');
    assert.equal(ticket.customerProfile.vehicle.model, 'i4');
    assert.equal(ticket.customerProfile.diagnosticEvents[0].dtcCode, 'B1000');
    assert.equal(ticket.customerProfile.telemetryReadings[0].value, 12.4);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousDashboardUrl === undefined) delete process.env.CUSTOMER_DASHBOARD_URL;
    else process.env.CUSTOMER_DASHBOARD_URL = previousDashboardUrl;
  }
});

test('self-service can resolve without a ticket or escalate when unresolved', async () => {
  const app = createApp(memoryRepository(), true);
  const feedback = (question: string, resolved: boolean) => app.request('/api/assistant/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, resolved }) });
  assert.equal((await feedback('How do I pair my phone?', true)).status, 200);
  assert.equal((await (await app.request('/api/tickets')).json()).items.length, 0);
  const history = await app.request('/api/assistant/history');
  assert.equal(history.status, 200);
  assert.deepEqual((await history.json()).items.map((item: { question: string }) => item.question), ['How do I pair my phone?']);
  assert.equal((await app.request('/api/assistant/history', { headers: { 'X-Demo-Role': 'advisor' } })).status, 403);
  const result = await feedback('My display still restarts', false);
  assert.equal(result.status, 201);
  assert.equal((await result.json()).ticket.source, 'KNOWLEDGE_BASE');
  assert.equal((await feedback('How do I reset a brake warning?', true)).status, 400);
});

test('assistant Q&A is saved to customer history and resolution updates the same interaction', async () => {
  const app = createApp(memoryRepository(), true);
  const headers = { 'Content-Type': 'application/json', 'X-Demo-Role': 'customer' };
  const response = await app.request('/api/assistant/ask', {
    method: 'POST', headers, body: JSON.stringify({ question: 'How can I pair my phone?' }),
  });
  assert.equal(response.status, 200);
  const answer = await response.json();
  assert.match(answer.interactionId, /^[0-9a-f-]{36}$/i);

  const historyResponse = await app.request('/api/assistant/history', { headers });
  const [interaction] = (await historyResponse.json()).items;
  assert.equal(interaction.interactionId, answer.interactionId);
  assert.equal(interaction.question, answer.question);
  assert.equal(interaction.answer, answer.answer);
  assert.equal(interaction.resolved, false);

  const feedback = await app.request('/api/assistant/feedback', {
    method: 'POST', headers,
    body: JSON.stringify({ question: answer.question, resolved: true, interactionId: answer.interactionId }),
  });
  assert.equal(feedback.status, 200);
  const updatedHistory = (await (await app.request('/api/assistant/history', { headers })).json()).items;
  assert.equal(updatedHistory.length, 1);
  assert.equal(updatedHistory[0].resolved, true);
});

test('advisor conversations are role-gated, projected and paginated alongside customer history', async () => {
  const repository = memoryRepository();
  const answer = {
    question: 'How do I reconnect my phone?', answer: 'Open the vehicle settings.', citations: [{ title: 'Pairing guide', reference: 's3://private/manual.pdf' }],
    triage: { category: 'CONNECTIVITY' as const, priority: 'LOW' as const, critical: false, knowledgeBaseEligible: true, summary: 'Phone pairing help.', recommendedAction: 'Follow the approved pairing steps.' },
    source: 'local-faq' as const,
  };
  for (let index = 0; index < 51; index++) await repository.recordInteraction('customer-demo', answer);
  const app = createApp(repository, true);
  const denied = await app.request('/api/advisor/interactions', { headers: { 'X-Demo-Role': 'customer' } });
  assert.equal(denied.status, 403);
  const firstAdvisorPage = await app.request('/api/advisor/interactions', { headers: { 'X-Demo-Role': 'advisor' } });
  const firstAdvisorResult = await firstAdvisorPage.json();
  assert.equal(firstAdvisorResult.items.length, 50);
  assert.ok(firstAdvisorResult.nextCursor);
  assert.equal('customerId' in firstAdvisorResult.items[0], false);
  assert.equal('citations' in firstAdvisorResult.items[0], false);
  const secondAdvisorPage = await app.request(`/api/advisor/interactions?cursor=${encodeURIComponent(firstAdvisorResult.nextCursor)}`, { headers: { 'X-Demo-Role': 'advisor' } });
  assert.equal((await secondAdvisorPage.json()).items.length, 1);
  const firstCustomerPage = await app.request('/api/assistant/history');
  const firstCustomerResult = await firstCustomerPage.json();
  assert.equal(firstCustomerResult.items.length, 50);
  assert.ok(firstCustomerResult.nextCursor);
});

test('DynamoDB analytics events preserve insert, modification, removal, ordering and privacy', () => {
  const ticketRecord = (eventName: 'INSERT' | 'MODIFY' | 'REMOVE', sequence: string, oldImage?: DynamoStreamRecord['dynamodb'] extends infer D ? D extends { OldImage?: infer I } ? I : never : never, newImage?: DynamoStreamRecord['dynamodb'] extends infer D ? D extends { NewImage?: infer I } ? I : never : never): DynamoStreamRecord => ({
    eventID: `shard-1:${sequence}`,
    eventName,
    eventSourceARN: 'arn:aws:dynamodb:us-east-1:123456789012:table/servicecare-tickets/stream/2026-11-04T00:00:00.000',
    dynamodb: { SequenceNumber: sequence, ApproximateCreationDateTime: 1793750400, Keys: { ticketId: { S: 'TKT-sensitive-id' } }, OldImage: oldImage, NewImage: newImage },
  });
  const inserted = normalizeStreamRecord(ticketRecord('INSERT', '100', undefined, {
    ticketId: { S: 'TKT-sensitive-id' }, customerId: { S: 'customer-sensitive-id' }, vin: { S: 'WBA-sensitive-vin' },
    title: { S: 'Sensitive title' }, description: { S: 'Sensitive description' }, createdAt: { S: '2026-11-03T08:30:00.000Z' }, status: { S: 'OPEN' },
    priority: { S: 'HIGH' }, category: { S: 'MECHANICAL' }, source: { S: 'CUSTOMER_PORTAL' },
  }))!;
  assert.equal(inserted.entity_type, 'ticket');
  assert.equal(inserted.event_type, 'INSERT');
  assert.equal(inserted.status_after, 'OPEN');
  assert.equal(inserted.sequence_number, '100');
  assert.equal(inserted.opened_at, '2026-11-03T08:30:00.000Z');
  assert.equal(inserted.ticket_created, true);
  assert.notEqual(inserted.entity_id, 'TKT-sensitive-id');
  assert.equal('customerId' in inserted, false);
  assert.equal('vin' in inserted, false);
  assert.equal('title' in inserted, false);
  assert.equal('description' in inserted, false);

  const modified = normalizeStreamRecord(ticketRecord('MODIFY', '101',
    { ticketId: { S: 'TKT-sensitive-id' }, status: { S: 'OPEN' }, advisorId: { NULL: true } },
    { ticketId: { S: 'TKT-sensitive-id' }, status: { S: 'ASSIGNED' }, advisorId: { S: 'advisor-sensitive-id' }, priority: { S: 'HIGH' } }))!;
  assert.equal(modified.status_before, 'OPEN');
  assert.equal(modified.status_after, 'ASSIGNED');
  assert.equal(modified.assigned_before, false);
  assert.equal(modified.assigned_after, true);
  assert.equal(modified.advisor_assigned, true);
  assert.notEqual(modified.advisor_hash, 'advisor-sensitive-id');
  assert.equal(modified.sequence_number, '101');
  assert.equal(normalizeStreamRecord(ticketRecord('MODIFY', '101',
    { ticketId: { S: 'TKT-sensitive-id' }, status: { S: 'OPEN' } },
    { ticketId: { S: 'TKT-sensitive-id' }, status: { S: 'ASSIGNED' } }))?.event_id, modified.event_id);

  const removed = normalizeStreamRecord(ticketRecord('REMOVE', '102',
    { ticketId: { S: 'TKT-sensitive-id' }, status: { S: 'ASSIGNED' }, advisorId: { S: 'advisor-sensitive-id' } }))!;
  assert.equal(removed.is_deleted, true);
  assert.equal(removed.status, 'ASSIGNED');
  assert.equal(removed.status_after, null);
  assert.equal(removed.assigned, true);

  const visual = normalizeStreamRecord({
    eventID: 'shard-2:1', eventName: 'MODIFY',
    eventSourceARN: 'arn:aws:dynamodb:us-east-1:123456789012:table/visual-sessions/stream/2026-11-04T00:00:00.000',
    dynamodb: { SequenceNumber: '1', ApproximateCreationDateTime: 1793750400, Keys: { sessionId: { S: 'visual-sensitive-id' } }, NewImage: {
      sessionId: { S: 'visual-sensitive-id' }, ownerId: { S: 'customer-sensitive-id' }, question: { S: 'Sensitive concern text' },
      phase: { S: 'ANALYSIS_READY' }, critical: { BOOL: true },
      analysis: { M: { safetyConcern: { BOOL: true }, detectedText: { L: [{ S: 'Customer identifier text' }] } } },
    } },
  })!;
  assert.equal(visual.entity_type, 'visual_session');
  assert.equal(visual.image_analysis_ready, true);
  assert.equal(visual.safety_concern, true);
  assert.equal('ownerId' in visual, false);
  assert.equal('question' in visual, false);
  assert.equal('detectedText' in visual, false);
});

test('DynamoDB analytics batching reports only failed Firehose records and retries thrown batches', async () => {
  const records = ['1', '2', '3'].map(sequence => ({
    eventID: `shard-1:${sequence}`, eventName: 'INSERT' as const,
    eventSourceARN: 'arn:aws:dynamodb:us-east-1:123456789012:table/servicecare-tickets/stream/2026-11-04T00:00:00.000',
    dynamodb: { SequenceNumber: sequence, ApproximateCreationDateTime: 1793750400, Keys: { ticketId: { S: `ticket-${sequence}` } }, NewImage: { ticketId: { S: `ticket-${sequence}` }, status: { S: 'OPEN' } } },
  }));
  const calls: number[] = [];
  const partial = await processStreamBatch(records, async batch => { calls.push(batch.length); return [1]; });
  assert.deepEqual(calls, [3]);
  assert.deepEqual(partial.batchItemFailures, [{ itemIdentifier: '2' }]);

  const thrown = await processStreamBatch(records, async () => { throw new Error('Firehose unavailable'); });
  assert.deepEqual(thrown.batchItemFailures, records.map(record => ({ itemIdentifier: record.dynamodb.SequenceNumber })));
});

test('DynamoDB analytics batches never exceed Firehose PutRecordBatch limits', async () => {
  const records = Array.from({ length: 501 }, (_, index) => ({
    eventID: `shard-1:${index}`, eventName: 'INSERT' as const,
    eventSourceARN: 'arn:aws:dynamodb:us-east-1:123456789012:table/servicecare-tickets/stream/2026-11-04T00:00:00.000',
    dynamodb: { SequenceNumber: String(index), ApproximateCreationDateTime: 1793750400, Keys: { ticketId: { S: `ticket-${index}` } }, NewImage: { ticketId: { S: `ticket-${index}` }, status: { S: 'OPEN' } } },
  }));
  const calls: number[] = [];
  const response = await processStreamBatch(records, async batch => { calls.push(batch.length); return []; });
  assert.deepEqual(calls, [500, 1]);
  assert.deepEqual(response.batchItemFailures, []);
});

test('advisor analytics embed is advisor-only and fails closed before dashboard setup', async () => {
  const app = createApp(memoryRepository(), true);
  const previousDashboardId = process.env.QUICKSIGHT_DASHBOARD_ID;
  delete process.env.QUICKSIGHT_DASHBOARD_ID;
  try {
    const customer = await app.request('/api/advisor/dashboard/embed', {
      headers: { 'X-Demo-Role': 'customer' },
    });
    assert.equal(customer.status, 403);
    const advisor = await app.request('/api/advisor/dashboard/embed', {
      headers: { 'X-Demo-Role': 'advisor' },
    });
    assert.equal(advisor.status, 503);
  } finally {
    if (previousDashboardId === undefined) delete process.env.QUICKSIGHT_DASHBOARD_ID;
    else process.env.QUICKSIGHT_DASHBOARD_ID = previousDashboardId;
  }
});

test('AWS mode rejects demo impersonation and enforces ticket ownership', async () => {
  const repository = memoryRepository();
  const local = createApp(repository, true);
  await local.request('/api/tickets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'A customer issue', description: 'An issue requiring an advisor review.' }) });
  const app = createApp(repository);
  assert.equal((await app.request('/api/tickets', { headers: { 'X-Demo-Role': 'advisor' } })).status, 401);
  const response = await app.request('/api/tickets', {}, { event: { requestContext: { authorizer: { jwt: { claims: { sub: 'another-customer', token_use: 'access', 'cognito:groups': '[Customers]' } } } } } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).items.length, 0);
});
test('requests without the CloudFront origin token are rejected', async () => {
  const app = createApp(memoryRepository(), true, undefined, 'edge-secret');
  assert.equal((await app.request('/api/health')).status, 403);
  assert.equal((await app.request('/api/health', { headers: { 'x-origin-verify': 'wrong' } })).status, 403);
  assert.equal((await app.request('/api/health', { headers: { 'x-origin-verify': 'edge-secret' } })).status, 200);
});

test('harness ARN accepts the console endpoint ARN and resolves the invoke target', () => {
  const base = 'arn:aws:bedrock-agentcore:eu-north-1:123456789012:harness/Demo_Harness-AbCdEfGhIj';
  assert.deepEqual(harnessConfig({ AGENTCORE_HARNESS_ARN: `${base}/harness-endpoint/DEFAULT` }), { harnessArn: base, qualifier: 'DEFAULT', region: 'eu-north-1', modelId: undefined });
  assert.equal(harnessConfig({ AGENTCORE_HARNESS_ARN: base, AGENTCORE_MODEL_ID: ' eu.amazon.nova-pro-v1:0 ' })?.modelId, 'eu.amazon.nova-pro-v1:0');
  assert.equal(harnessConfig({}), undefined);
  assert.throws(() => harnessConfig({ AGENTCORE_HARNESS_ARN: 'arn:aws:bedrock-agentcore:eu-north-1:123456789012:runtime/Demo-AbCdEfGhIj' }), /valid AgentCore harness/);
});

test('vehicle questions are answered from the signed-in customer data and fall back to knowledge guidance', async () => {
  const prompts: string[] = [];
  let reply = '{"answer":"Odometer: 60,512 km, recorded 2026-11-01T10:00:00Z. This is a recorded sample, not live.","usedVehicleData":true}';
  const deps = { retrieve: async () => [], invoke: async (prompt: string) => { prompts.push(prompt); return reply; } };
  const vehicle = { vehicle: { vin: 'BMWHACK118I230000' }, faults: [], recordedReadings: [{ signalName: 'odometer', value: 60512, unit: 'km', readingAt: '2026-11-01T10:00:00Z' }] };
  const answered = await agentcoreGuidance('What is my mileage?', 'customer-1', deps, undefined, vehicle);
  assert.equal(answered.grounded, true);
  assert.match(prompts[0], /signedInCustomerVehicle/);
  reply = '{"answer":"x","usedVehicleData":false}';
  assert.equal((await agentcoreGuidance('What is my mileage?', 'customer-1', deps, undefined, vehicle)).grounded, false);
  prompts.length = 0;
  await agentcoreGuidance('What is my mileage?', 'customer-1', deps);
  assert.equal(prompts.length, 0);
});

test('harness answers must cite retrieved passages, are scoped to the customer and never see document references', async () => {
  const prompts: string[] = [];
  const actors: string[] = [];
  let reply = 'Sure. {"answer":"Open the vehicle settings.","citationIds":[0]}';
  const passages = [{ text: 'Pair the phone in the vehicle settings.', reference: 's3://approved/manual.pdf' }];
  const deps = {
    retrieve: async () => passages,
    invoke: async (prompt: string, actorId: string) => { prompts.push(prompt); actors.push(actorId); return reply; },
  };
  const grounded = await agentcoreGuidance('How do I pair my phone?', 'customer-1', deps);
  assert.equal(grounded.grounded, true);
  assert.equal(grounded.citations[0].reference, 's3://approved/manual.pdf');
  assert.deepEqual(actors, ['customer-1']);
  assert.doesNotMatch(prompts[0], /s3:|manual\.pdf/);
  reply = '{"answer":"An invented fix.","citationIds":[]}';
  assert.equal((await agentcoreGuidance('How do I pair my phone?', 'customer-1', deps)).grounded, false);
  reply = 'I cannot help with that.';
  await assert.rejects(agentcoreGuidance('How do I pair my phone?', 'customer-1', deps));
  passages.length = 0;
  prompts.length = 0;
  assert.equal((await agentcoreGuidance('Unknown concern here', 'customer-1', deps)).grounded, false);
  assert.equal(prompts.length, 0);
});

test('a configured harness never receives safety concerns and failures stay advisor-safe', async () => {
  process.env.AGENTCORE_HARNESS_ARN = 'arn:aws:bedrock-agentcore:eu-north-1:123456789012:harness/Demo-AbCdEfGhIj';
  const knowledgeBaseId = process.env.KNOWLEDGE_BASE_ID;
  const warn = console.warn;
  console.warn = () => {};
  try {
    const app = createApp(memoryRepository(), true);
    const ask = async (question: string) => (await app.request('/api/assistant/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question }) })).json();
    assert.equal((await ask('There is smoke coming from the car.')).source, 'safety-rule');
    // Without KNOWLEDGE_BASE_ID nothing can be grounded, so the answer is advisor review rather than a model guess.
    delete process.env.KNOWLEDGE_BASE_ID;
    const answer = await ask('How do I pair my phone?');
    assert.equal(answer.source, 'unavailable');
    assert.match(answer.answer, /temporarily unavailable/);
  } finally {
    console.warn = warn;
    delete process.env.AGENTCORE_HARNESS_ARN;
    if (knowledgeBaseId !== undefined) process.env.KNOWLEDGE_BASE_ID = knowledgeBaseId;
  }
});

test('chat vehicle data defaults to the first owned vehicle, honours a VIN in the question and omits personal details', async () => {
  const original = globalThis.fetch;
  process.env.CUSTOMER_DASHBOARD_URL = 'https://dashboard.test/customer/dashboard';
  globalThis.fetch = async () => new Response(JSON.stringify({
    customer: { owner_name: 'Ada', owner_email: 'ada@example.com', owner_phone: '123' },
    vehicles: [
      { vehicle: { vin: 'VIN00000000000001', model: '118i' }, telemetry: [{ signal_name: 'odometer', reading_ts: '2026-11-01T10:00:00Z', value_num: 1, unit: 'km' }, { signal_name: 'odometer', reading_ts: '2026-11-02T10:00:00Z', value_num: 2, unit: 'km' }], diagnostic_events: [] },
      { vehicle: { vin: 'VIN00000000000002', model: 'X5' }, telemetry: [], diagnostic_events: [] },
    ],
  }), { status: 200 });
  try {
    const first = await chatVehicleData(undefined, 'Bearer token', 'What is my mileage?');
    assert.equal(first?.vehicle.vin, 'VIN00000000000001');
    assert.equal(first?.recordedReadings.length, 1);
    assert.equal(first?.recordedReadings[0].value, 2);
    assert.doesNotMatch(JSON.stringify(first), /ada@example|Ada|123/);
    assert.equal((await chatVehicleData(undefined, 'Bearer token', 'readings for vin00000000000002'))?.vehicle.vin, 'VIN00000000000002');
    assert.equal(await chatVehicleData('VIN99999999999999', 'Bearer token'), undefined);
    assert.equal(await chatVehicleData(undefined, undefined), undefined);
  } finally { globalThis.fetch = original; delete process.env.CUSTOMER_DASHBOARD_URL; }
});
test('greetings get a friendly reply without model calls', async () => {
  const { answerQuestion, isSmallTalk } = await import('../src/knowledge/assistant.ts');
  assert.equal(isSmallTalk('Hello!'), true);
  assert.equal(isSmallTalk('hello my brakes are failing'), false);
  const triage = { priority: 'LOW', critical: false, knowledgeBaseEligible: false, recommendedAction: '' } as never;
  const answer = await answerQuestion('Hi there', triage, false, 'c1');
  assert.equal(answer.nextAction, 'guidance');
  assert.match(answer.answer, /ServiceCare assistant/);
});