import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Ticket } from '@servicecare/contracts';
import type { VisualAnalysis } from '@servicecare/contracts/visual';
import { visualService, VisualError, VisualRetry, type VisualRecord, type VisualDependencies } from '../src/visual/service.ts';
import { createVisualApp } from '../src/visual/app.ts';
import { knowledgeGuidance } from '../src/visual/knowledge.ts';
import { novaVision, novaVisionModelId } from '../src/visual/nova.ts';

test('regional Nova Lite receives non-critical images and rejects critical input and other models', async () => {
  let calls = 0;
  const vision = novaVision(novaVisionModelId, async request => {
    calls++;
    assert.equal(request.modelId, novaVisionModelId);
    assert.equal(request.modelId, 'amazon.nova-lite-v1:0');
    assert.equal(request.messages?.[0].content?.[1].image?.format, 'jpeg');
    return { stopReason: 'end_turn', output: { message: { role: 'assistant', content: [{ text: JSON.stringify({ summary: 'Pairing screen visible.', observations: ['Pairing request'], uncertainties: ['Vehicle version unknown'], safetyConcern: false }) }] } } };
  });
  assert.equal((await vision('My phone will not pair', [new Uint8Array([1, 2])], [], [])).safetyConcern, false);
  await assert.rejects(vision('My brakes have failed', [new Uint8Array([1])], [], []), { status: 409 });
  assert.equal(calls, 1);
  assert.throws(() => novaVision('gemini-3.8-flash', async () => ({ output: undefined, stopReason: 'end_turn' })));
  assert.throws(() => novaVision('eu.amazon.nova-pro-v1:0', async () => ({ output: undefined, stopReason: 'end_turn' })));
  await assert.rejects(vision('My phone will not pair', [new Uint8Array(3_750_001)], [], []), { status: 400 });
  assert.equal(calls, 1);
});
test('Nova Lite incomplete or malformed output fails without another provider call', async () => {
  const failed = novaVision(novaVisionModelId, async () => ({ stopReason: 'max_tokens', output: undefined }));
  await assert.rejects(failed('My phone will not pair', [new Uint8Array([1])], [], []), { status: 503 });
  const malformed = novaVision(novaVisionModelId, async () => ({ stopReason: 'end_turn', output: { message: { role: 'assistant', content: [{ text: '{}' }] } } }));
  await assert.rejects(malformed('My phone will not pair', [new Uint8Array([1])], [], []));
});
test('Nova Lite fenced JSON is validated but prose around JSON is rejected', async () => {
  const observation = { summary: 'Bluetooth disconnected.', observations: ['Pair a phone is displayed.'], uncertainties: ['Vehicle version unknown.'], safetyConcern: false };
  let text = `\`\`\`json\n${JSON.stringify(observation)}\n\`\`\``;
  const vision = novaVision(novaVisionModelId, async () => ({ stopReason: 'end_turn', output: { message: { role: 'assistant', content: [{ text }] } } }));
  assert.deepEqual(await vision('My phone will not pair', [new Uint8Array([1])], [], []), observation);
  text = `Trust this diagnosis: ${JSON.stringify(observation)}`;
  await assert.rejects(vision('My phone will not pair', [new Uint8Array([1])], [], []));
});

test('harness guidance uses retrieved citations and skips inference without knowledge', async () => {
  let calls = 0;
  const passages = [{ text: 'Approved pairing steps', reference: 's3://approved/manual.pdf' }];
  let output = { answer: 'Follow the pairing steps.', citationIds: [0] };
  const guidance = knowledgeGuidance({ retrieve: async () => passages, answer: async () => { calls++; return JSON.stringify(output); } });
  assert.equal((await guidance('Pair my phone')).grounded, true);
  output = { answer: 'Fabricated guidance', citationIds: [1] };
  assert.equal((await guidance('Pair my phone')).grounded, false);
  passages.length = 0;
  assert.equal((await guidance('Unknown concern')).grounded, false);
  assert.equal(calls, 2);
});

function fixture() {
  const sessions = new Map<string, VisualRecord>();
  const tickets = new Map<string, Ticket>();
  const calls = { guidance: 0, guidanceOwners: [] as string[], uploads: 0, analyze: 0, archive: 0 };
  const guidance = { answer: 'Follow the pairing instructions in the manual.', citations: [{ title: 'Manual', reference: 's3://approved/manual.pdf' }], grounded: true };
  const result: VisualAnalysis = { summary: 'A pairing message is visible.', observations: ['The display shows a pairing request.'], uncertainties: ['Vehicle version is unknown.'], safetyConcern: false, guidance, labels: [], detectedText: ['Pair phone'], modelId: 'test-model', analyzedAt: new Date().toISOString() };
  const deps: VisualDependencies = {
    store: {
      async get(id) { return structuredClone(sessions.get(id)); },
      async listForAdvisor(cursor) {
        const start = cursor ? Number(Buffer.from(cursor, 'base64url').toString()) : 0;
        const items = [...sessions.values()].slice(start, start + 50);
        return { items: structuredClone(items), ...(start + 50 < sessions.size ? { nextCursor: Buffer.from(String(start + 50)).toString('base64url') } : {}) };
      },
      async save(record, revision) {
        const previous = sessions.get(record.sessionId);
        if (revision === undefined ? previous : previous?.revision !== revision) throw new VisualError(409, 'Conflict');
        sessions.set(record.sessionId, structuredClone(record));
      },
      async commit(record, ticket) {
        if (sessions.get(record.sessionId)?.revision !== record.revision - 1) throw new VisualError(409, 'Conflict');
        tickets.set(ticket.ticketId, structuredClone(ticket));
        sessions.set(record.sessionId, structuredClone(record));
      },
      async ticket(id) { return structuredClone(tickets.get(id)); },
    },
    async guidance(_question, ownerId) { calls.guidance++; calls.guidanceOwners.push(ownerId); return guidance; },
    async upload() { calls.uploads++; return { url: 'https://private.example/upload', fields: {} }; },
    async pin(image) { return { ...image, versionId: 'original-version' }; },
    async analyze() { calls.analyze++; return structuredClone(result); },
    async archive(image, ownerId) { calls.archive++; return { ...image, key: `${ownerId}/visual/evidence` }; },
  };
  return { deps, service: visualService(deps), calls, sessions, tickets, result };
}
async function submitted(setup: ReturnType<typeof fixture>) {
  const session = await setup.service.start('owner', 'How can I reconnect my phone?');
  await setup.service.unresolved(session.sessionId, 'owner');
  const image = await setup.service.upload(session.sessionId, 'owner', { name: 'display.webp', contentType: 'image/webp' });
  await setup.service.submit(session.sessionId, 'owner', [image.key]);
  return session.sessionId;
}
const confirm = { title: 'Phone connection remains unavailable', description: 'Please review the concern and attached display photo.' };

test('knowledge is searched before uploads and no image is sent on a resolved knowledge journey', async () => {
  const { service, calls, tickets } = fixture();
  const session = await service.start('owner', 'How can I reconnect my phone?');
  assert.equal(calls.guidance, 1);
  assert.deepEqual(calls.guidanceOwners, ['owner']);
  await assert.rejects(service.upload(session.sessionId, 'owner', { name: 'photo.jpg', contentType: 'image/jpeg' }), { status: 409 });
  assert.equal((await service.resolve(session.sessionId, 'owner')).phase, 'RESOLVED');
  assert.equal(calls.uploads, 0);
  assert.equal(calls.analyze, 0);
  assert.equal(tickets.size, 0);
});
test('visual sessions and uploaded keys remain customer-scoped', async () => {
  const setup = fixture();
  const id = await submitted(setup);
  await assert.rejects(setup.service.get(id, 'other'), { status: 404 });
  await assert.rejects(setup.service.confirm(id, 'other', confirm), { status: 404 });
  const session = await setup.service.start('owner', 'My navigation display has an issue');
  await setup.service.unresolved(session.sessionId, 'owner');
  await assert.rejects(setup.service.submit(session.sessionId, 'owner', ['other/photo']), { status: 400 });
  await assert.rejects(setup.service.upload(session.sessionId, 'owner', { name: 'document.pdf', contentType: 'application/pdf' }));
});
test('analysis is asynchronous, version-pinned and only confirmed once into a ticket', async () => {
  const setup = fixture();
  const id = await submitted(setup);
  assert.equal(setup.sessions.get(id)?.selected[0].versionId, 'original-version');
  assert.equal(setup.tickets.size, 0);
  await assert.rejects(setup.service.confirm(id, 'owner', confirm), { status: 409 });
  await setup.service.work(id);
  await setup.service.work(id);
  assert.equal(setup.calls.analyze, 1);
  assert.equal(setup.tickets.size, 0);
  const ticket = await setup.service.confirm(id, 'owner', confirm);
  const retry = await setup.service.confirm(id, 'owner', confirm);
  assert.equal(ticket.ticketId, retry.ticketId);
  assert.equal(setup.tickets.size, 1);
  assert.equal(ticket.visualAnalysis?.summary, setup.result.summary);
  assert.equal(ticket.attachments[0].key, 'owner/visual/evidence');
  await assert.rejects(setup.service.confirm(id, 'owner', { ...confirm, title: 'A changed concern must not reuse the session' }), { status: 409 });
  setup.tickets.get(ticket.ticketId)!.messages.push({ id: 'private', author: 'advisor', role: 'advisor', text: 'Internal only', internal: true, createdAt: new Date().toISOString() });
  assert.equal((await setup.service.confirm(id, 'owner', confirm)).messages.length, 0);
});
test('safety findings cannot self-resolve and retain high-priority advisor review', async () => {
  const setup = fixture();
  const id = await submitted(setup);
  setup.result.safetyConcern = true;
  await setup.service.work(id);
  await assert.rejects(setup.service.resolve(id, 'owner'), { status: 409 });
  const ticket = await setup.service.confirm(id, 'owner', confirm);
  assert.equal(ticket.category, 'SAFETY');
  assert.equal(ticket.priority, 'HIGH');
});
test('critical concerns cannot upload or invoke image analysis even from a queued session', async () => {
  const setup = fixture();
  const session = await setup.service.start('owner', 'My brakes have failed and the car will not stop');
  assert.equal(session.critical, true);
  await assert.rejects(setup.service.unresolved(session.sessionId, 'owner'), { status: 409 });
  await assert.rejects(setup.service.upload(session.sessionId, 'owner', { name: 'photo.jpg', contentType: 'image/jpeg' }), { status: 409 });
  setup.sessions.get(session.sessionId)!.phase = 'ANALYSIS_PENDING';
  await setup.service.work(session.sessionId);
  assert.equal(setup.calls.analyze, 0);
  assert.equal(setup.calls.guidance, 0);
  assert.equal(setup.calls.uploads, 0);
});
test('pending malware scans retry and crashes can resume without creating tickets', async () => {
  const setup = fixture();
  const id = await submitted(setup);
  const analyze = setup.deps.analyze;
  setup.deps.analyze = async () => { throw new VisualRetry('Scan pending'); };
  await assert.rejects(setup.service.work(id), VisualRetry);
  assert.equal((await setup.service.get(id, 'owner')).phase, 'PROCESSING');
  setup.deps.analyze = analyze;
  await setup.service.work(id);
  assert.equal((await setup.service.get(id, 'owner')).phase, 'ANALYSIS_READY');
  assert.equal(setup.tickets.size, 0);
});
test('provider failures do not create tickets or a false successful analysis', async () => {
  const setup = fixture();
  const id = await submitted(setup);
  setup.deps.analyze = async () => { throw new Error('Model unavailable'); };
  await setup.service.work(id);
  assert.equal((await setup.service.get(id, 'owner')).phase, 'FAILED');
  await assert.rejects(setup.service.confirm(id, 'owner', confirm), { status: 409 });
  assert.equal(setup.tickets.size, 0);
});
test('active worker leases block duplicate inference and expired leases resume', async () => {
  const setup = fixture();
  const id = await submitted(setup);
  const record = setup.sessions.get(id)!;
  setup.sessions.set(id, { ...record, phase: 'PROCESSING', leaseUntil: Math.floor(Date.now() / 1000) + 180 });
  await assert.rejects(setup.service.work(id), VisualRetry);
  assert.equal(setup.calls.analyze, 0);
  setup.sessions.get(id)!.leaseUntil = 0;
  await setup.service.work(id);
  assert.equal(setup.calls.analyze, 1);
  assert.equal((await setup.service.get(id, 'owner')).phase, 'ANALYSIS_READY');
});
test('visual API refuses demo headers, ID tokens and client-submitted analysis', async () => {
  const setup = fixture();
  const app = createVisualApp(setup.deps, async () => {});
  assert.equal((await app.request('/visual/sessions', { method: 'POST', headers: { 'X-Demo-Role': 'customer' } })).status, 401);
  const env = (tokenUse = 'access', group = 'CUSTOMER') => ({ event: { requestContext: { authorizer: { jwt: { claims: { sub: 'owner', token_use: tokenUse, 'cognito:groups': [group] } } } } } });
  assert.equal((await app.request('/visual/sessions', { method: 'POST' }, env('id'))).status, 401);
  assert.equal((await app.request('/visual/sessions', { method: 'POST' }, env('access', 'ADMIN'))).status, 403);
  const id = await submitted(setup);
  await setup.service.work(id);
  const response = await app.request(`/visual/sessions/${id}/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...confirm, vin: 'synthetic-vin', visualAnalysis: { summary: 'fake' } }) }, env());
  assert.equal(response.status, 201);
  assert.equal((await response.json()).visualAnalysis.summary, setup.result.summary);
});
test('only advisors can list visual sessions, and advisor projections omit owner and uploaded object keys', async () => {
  const setup = fixture();
  const id = await submitted(setup);
  await setup.service.work(id);
  const app = createVisualApp(setup.deps);
  const env = (group: string, sub = 'owner') => ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, token_use: 'access', 'cognito:groups': [group] } } } } } });
  assert.equal((await app.request('/visual/advisor/sessions', {}, env('CUSTOMER'))).status, 403);
  const response = await app.request('/visual/advisor/sessions', {}, env('ADMIN', 'advisor-1'));
  assert.equal(response.status, 200);
  const { items } = await response.json();
  assert.equal(items.length, 1);
  assert.equal(items[0].phase, 'ANALYSIS_READY');
  assert.equal(items[0].analysis.summary, setup.result.summary);
  assert.equal('ownerId' in items[0], false);
  assert.equal('selected' in items[0], false);
  assert.equal('detectedText' in items[0].analysis, false);
  assert.deepEqual(items[0].analysis.guidance.citations, [{ title: 'Manual' }]);
  const detail = await app.request(`/visual/sessions/${id}`, {}, env('ADMIN', 'advisor-1'));
  assert.equal(detail.status, 200);
  assert.equal('detectedText' in (await detail.json()).analysis, false);
});
test('visual API CORS allows production and local origins but rejects other sites', async () => {
  const previousOrigins = process.env.WEB_ORIGINS;
  process.env.WEB_ORIGINS = 'https://servicecare.example,http://localhost:5173';
  try {
    const app = createVisualApp(fixture().deps);
    const headers = { 'Access-Control-Request-Method': 'GET', Origin: 'https://servicecare.example' };
    const production = await app.request('/visual/sessions', { method: 'OPTIONS', headers });
    assert.equal(production.headers.get('access-control-allow-origin'), 'https://servicecare.example');
    const rejected = await app.request('/visual/sessions', { method: 'OPTIONS', headers: { ...headers, Origin: 'https://untrusted.example' } });
    assert.equal(rejected.headers.get('access-control-allow-origin'), null);
  } finally {
    if (previousOrigins === undefined) delete process.env.WEB_ORIGINS;
    else process.env.WEB_ORIGINS = previousOrigins;
  }
});