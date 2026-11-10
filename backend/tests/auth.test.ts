import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp, type TokenVerifier } from '../src/app.ts';
import { cognitoVerifier } from '../src/auth/cognito.ts';
import { memoryRepository } from '../src/tickets/repository.ts';

const tokens: Record<string, Record<string, unknown>> = {
  customer: { sub: 'customer-1', token_use: 'access', 'cognito:groups': ['CUSTOMER'] },
  'other-customer': { sub: 'customer-2', token_use: 'access', 'cognito:groups': ['Customers'] },
  admin: { sub: 'admin-1', token_use: 'access', 'cognito:groups': ['ADMIN'] },
  advisor: { sub: 'advisor-1', token_use: 'access', 'cognito:groups': ['ServiceAdvisors'] },
  'no-group': { sub: 'nobody', token_use: 'access', 'cognito:groups': [] },
  'id-token': { sub: 'customer-1', token_use: 'id', 'cognito:groups': ['CUSTOMER'] },
};
const verify: TokenVerifier = async token => {
  const claims = tokens[token];
  if (!claims) throw new Error('Token failed verification.');
  return claims;
};
const ticket = { title: 'Infotainment display restarting', description: 'The display restarted twice on my last journey.' };
const call = (app: ReturnType<typeof createApp>, path: string, token?: string, init: RequestInit = {}, env?: object) =>
  app.request(`/api${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, env);

test('container mode requires a verified bearer access token', async () => {
  const app = createApp(memoryRepository(), false, verify);
  assert.equal((await app.request('/api/health')).status, 200);
  assert.equal((await call(app, '/tickets')).status, 401);
  assert.equal((await call(app, '/tickets', 'unknown')).status, 401);
  assert.equal((await call(app, '/tickets', 'id-token')).status, 401);
  assert.equal((await app.request('/api/tickets', { headers: { Authorization: 'Basic customer' } })).status, 401);
  assert.equal((await call(app, '/tickets', 'no-group')).status, 403);
  assert.equal((await call(app, '/tickets', 'customer')).status, 200);
});

test('container mode ignores API Gateway claims and demo headers', async () => {
  const app = createApp(memoryRepository(), false, verify);
  const forged = { event: { requestContext: { authorizer: { jwt: { claims: tokens.admin } } } } };
  assert.equal((await call(app, '/tickets', undefined, {}, forged)).status, 401);
  assert.equal((await app.request('/api/tickets', { headers: { 'X-Demo-Role': 'advisor' } })).status, 401);
});

test('local API verifies signed-in roles without breaking token-free demo sessions', async () => {
  const app = createApp(memoryRepository(), true, verify);
  for (const path of ['/advisor/overview', '/advisor/interactions']) {
    assert.equal((await call(app, path, 'admin')).status, 200);
    assert.equal((await call(app, path, 'advisor')).status, 200);
    assert.equal((await call(app, path, 'customer')).status, 403);
    assert.equal((await call(app, path, 'unknown')).status, 401);
    assert.equal((await call(app, path, 'id-token')).status, 401);
    assert.equal((await call(app, path)).status, 403);
    assert.equal((await app.request(`/api${path}`, { headers: { 'X-Demo-Role': 'advisor' } })).status, 200);
    assert.equal((await app.request(`/api${path}`, { headers: { Authorization: 'Bearer customer', 'X-Demo-Role': 'advisor' } })).status, 403);
  }
});

test('CUSTOMER and ADMIN groups map to customer and advisor roles with ownership enforced', async () => {
  const previousFetch = globalThis.fetch;
  const previousDashboardUrl = process.env.CUSTOMER_DASHBOARD_URL;
  process.env.CUSTOMER_DASHBOARD_URL = 'https://vehicles.example/customer/dashboard';
  globalThis.fetch = async () => new Response(JSON.stringify({ vehicles: [{ vehicle: { vin: 'WBA00000000000001' } }] }), { status: 200 });
  try {
    const app = createApp(memoryRepository(), false, verify);
    const created = await call(app, '/tickets', 'customer', { method: 'POST', body: JSON.stringify({ ...ticket, vin: 'WBA00000000000001' }) });
    assert.equal(created.status, 201);
    const { ticketId } = await created.json();
    assert.equal((await call(app, `/tickets/${ticketId}`, 'other-customer')).status, 404);
    assert.equal((await call(app, `/tickets/${ticketId}`, 'customer')).status, 200);
    assert.equal((await call(app, `/tickets/${ticketId}`, 'admin')).status, 200);
    assert.equal((await call(app, `/tickets/${ticketId}`, 'advisor')).status, 200);
    assert.equal((await (await call(app, '/tickets', 'other-customer')).json()).items.length, 0);
    assert.equal((await (await call(app, '/tickets', 'admin')).json()).items.length, 1);
    assert.equal((await call(app, '/tickets', 'admin', { method: 'POST', body: JSON.stringify(ticket) })).status, 403);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousDashboardUrl === undefined) delete process.env.CUSTOMER_DASHBOARD_URL;
    else process.env.CUSTOMER_DASHBOARD_URL = previousDashboardUrl;
  }
});

test('API Gateway authorizer claims still work when no verifier is configured, including the new group names', async () => {
  const app = createApp(memoryRepository());
  const claims = (groups: unknown) => ({ event: { requestContext: { authorizer: { jwt: { claims: { sub: 'user', token_use: 'access', 'cognito:groups': groups } } } } } });
  assert.equal((await app.request('/api/tickets', {}, claims('[CUSTOMER]'))).status, 200);
  assert.equal((await app.request('/api/tickets', {}, claims('[Customers, Other]'))).status, 200);
  assert.equal((await app.request('/api/tickets', {}, claims('[Visitors]'))).status, 403);
});

test('Cognito verifier needs configuration and rejects malformed tokens without network access', async () => {
  assert.throws(() => cognitoVerifier({}), /COGNITO_USER_POOL_ID/);
  assert.throws(() => cognitoVerifier({ COGNITO_USER_POOL_ID: 'eu-north-1_Example', COGNITO_CLIENT_IDS: ' , ' }), /COGNITO_CLIENT_IDS/);
  const verifier = cognitoVerifier({ COGNITO_USER_POOL_ID: 'eu-north-1_Example', COGNITO_CLIENT_IDS: 'client-a, client-b' });
  await assert.rejects(verifier('not-a-jwt'));
});
