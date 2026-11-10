import assert from 'node:assert/strict';
import { test } from 'node:test';
import { supportTopics, topicById, ticketCounts, ticketNotifications, supportImages, requestDraft, problemDescription } from '../src/lib/support.ts';
import { beginDemoSession, endDemoSession, hasDemoSession, passwordRecoveryUrl } from '../src/lib/session.ts';
import { validateChatImage } from '../src/lib/images.ts';
import type { Ticket } from '@servicecare/contracts';
import { signInPhase, passwordIssue, cognitoRole, authError, demoModeEnabled } from '../src/lib/auth-flow.ts';
import { chatAnswer, sameChatConcern } from '../src/lib/chat.ts';
import type { AssistantAnswer } from '@servicecare/contracts';
import { diagnosticChips, readingUnit, readingValue, recordedAt, signalLabel, summarizeTelemetry, vehicleSpecs } from '../src/lib/vehicle-data.ts';
import { forgetDashboard, rememberDashboard, rememberedDashboard } from '../src/lib/dashboard-memory.ts';
import type { CustomerDashboard, TelemetryReading } from '../src/lib/api.ts';

test('chat requests fresh answers, stops unresolved loops and still triages new critical details', async () => {
  const previous: AssistantAnswer = { question: 'Bluetooth not connecting', answer: 'Pair your phone.', source: 'agentcore', citations: [{ title: 'Manual', reference: 's3://approved/manual.md' }], triage: { category: 'CONNECTIVITY', priority: 'MEDIUM', critical: false, knowledgeBaseEligible: true, summary: 'Pairing concern', recommendedAction: 'Try approved guidance.' } };
  let calls = 0;
  const request = async () => { calls++; return previous; };
  await chatAnswer({ text: previous.question, explicitFollowUp: false, request });
  await chatAnswer({ text: previous.question, explicitFollowUp: false, request });
  assert.equal(calls, 2);
  const context = { issue: previous.question, previousAnswers: ['Pair your phone.', 'Remove old pairing.'], unresolved: true };
  const legacy = await chatAnswer({ text: 'Still unresolved', context: { ...context, previousAnswers: ['Pair your phone.'] }, explicitFollowUp: true, previous, request });
  assert.equal(legacy.nextAction, 'offer-ticket');
  assert.equal(calls, 2);
  assert.equal((await chatAnswer({ text: 'Still unresolved', context, explicitFollowUp: true, previous, request })).nextAction, 'offer-ticket');
  assert.equal(calls, 2);
  const urgent = await chatAnswer({ text: 'Now there is smoke', context, explicitFollowUp: false, previous, request: async () => ({ ...previous, triage: { ...previous.triage, critical: true, priority: 'CRITICAL' } }) });
  assert.equal(urgent.nextAction, 'urgent-ticket');
  assert.equal(sameChatConcern('It still will not connect', previous.question), true);
  assert.equal(sameChatConcern('My charging cable will not connect', previous.question), false);
});

test('vehicle data is shown in plain language and no reading is dropped', () => {
  assert.equal(signalLabel('tyre_pressure_fl_bar'), 'Tyre pressure front left');
  assert.equal(signalLabel('battery_12v_voltage'), 'Battery 12V voltage');
  assert.equal(signalLabel('hv_battery_soc_pct'), 'HV battery state of charge');
  assert.equal(signalLabel('adblue_level_pct'), 'AdBlue level');
  assert.equal(signalLabel('odometer_km'), 'Odometer');
  assert.equal(readingValue({ value_num: 0 }), '0');
  assert.equal(readingValue({ value_num: 33563 }), '33,563');
  assert.equal(readingValue({ value_num: 12.5 }), '12.5');
  assert.equal(readingValue({ value_text: 'unlocked' }), 'Unlocked');
  assert.equal(readingValue({}), '—');
  assert.equal(readingUnit('degC'), '°C');
  assert.equal(readingUnit('bar'), 'bar');
  assert.equal(recordedAt('2026-10-13 05:00:00'), '13 Oct 2026, 05:00');
  assert.equal(recordedAt('2026-03-20'), '20 Mar 2026');
  assert.equal(recordedAt('2026-11-04T10:00:00Z'), '04 Nov 2026, 10:00 UTC');
  assert.equal(recordedAt('not a date'), 'not a date');
  const reading = (signal_name: string, reading_ts: string, value_num: number): TelemetryReading => ({ reading_key: `${signal_name}-${reading_ts}`, vin: 'V', signal_name, reading_ts, value_num, unit: 'km' });
  const summary = summarizeTelemetry([reading('range_estimate_km', '2026-10-13 05:00:00', 400), reading('odometer_km', '2026-10-13 06:00:00', 100), reading('odometer_km', '2026-10-13 07:00:00', 120)]);
  assert.deepEqual(summary.tiles.map(item => item.signal_name), ['odometer_km', 'range_estimate_km']);
  assert.equal(summary.tiles[0].value_num, 120);
  assert.equal(summary.tiles.length + summary.earlier.length, 3);
  assert.equal(summary.recordedAt, '2026-10-13 07:00:00');
  assert.deepEqual(vehicleSpecs({ vin: 'V', powertrain: 'phev', last_service_date: '2026-03-20', colour: '' }), [['Powertrain', 'Plug-in hybrid'], ['Last service', '20 Mar 2026']]);
  assert.deepEqual(diagnosticChips({ event_key: 'a', vin: 'V', severity: 'safety_critical', safety_critical: true, status: 'active' }).map(chip => chip.label), ['Safety critical', 'Active']);
  assert.deepEqual(diagnosticChips({ event_key: 'b', vin: 'V', severity: 'urgent', safety_critical: false, status: 'stored' }).map(chip => chip.tone), ['danger', 'neutral']);
});

test('the last dashboard is only kept in memory until sign-in or sign-out clears it', () => {
  const dashboard: CustomerDashboard = { status: 'ok', customer: { owner_id: 'owner' }, vehicles: [] };
  rememberDashboard(dashboard);
  assert.equal(rememberedDashboard(), dashboard);
  forgetDashboard();
  assert.equal(rememberedDashboard(), undefined);
});

test('embedded Cognito flow keeps invitation, code and recovery challenges explicit', () => {
  const step = (signInStep: string) => ({ isSignedIn: false, nextStep: { signInStep } });
  assert.equal(signInPhase(step('CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED')), 'NEW_PASSWORD');
  assert.equal(signInPhase(step('CONFIRM_SIGN_IN_WITH_TOTP_CODE')), 'MFA_CODE');
  assert.equal(signInPhase(step('CONFIRM_SIGN_UP')), 'CONFIRM_ACCOUNT');
  assert.equal(signInPhase(step('RESET_PASSWORD')), 'RECOVERY');
  assert.equal(signInPhase({ isSignedIn: true, nextStep: { signInStep: 'DONE' } }), 'SIGNED_IN');
  assert.throws(() => signInPhase(step('DONE')));
  assert.throws(() => signInPhase(step('CONTINUE_SIGN_IN_WITH_MFA_SELECTION')));
});
test('configured Cognito never silently falls back to demo mode', () => {
  assert.equal(demoModeEnabled(undefined, true, true), false);
  assert.equal(demoModeEnabled(undefined, true, false), true);
  assert.equal(demoModeEnabled('true', true, true), true);
  assert.equal(demoModeEnabled('false', true, false), false);
  assert.equal(demoModeEnabled('true', false, false), false);
});
test('embedded auth validates new passwords and trusts issued groups, not selected account type', () => {
  assert.equal(passwordIssue('Example9!', 'Example9!'), undefined);
  assert.ok(passwordIssue('short', 'short'));
  assert.ok(passwordIssue('Example9!', 'Different9!'));
  assert.equal(cognitoRole({ 'cognito:groups': ['CUSTOMER'] }), 'customer');
  assert.equal(cognitoRole({ 'cognito:groups': ['ServiceAdvisors'] }), 'advisor');
  assert.throws(() => cognitoRole({}));
});
test('embedded auth errors do not distinguish missing accounts from wrong passwords', () => {
  const missing = Object.assign(new Error('Account details'), { name: 'UserNotFoundException' });
  const denied = Object.assign(new Error('Account details'), { name: 'NotAuthorizedException' });
  assert.equal(authError(missing), authError(denied));
});

test('support topics provide distinct, actionable common issues', () => {
  assert.equal(new Set(supportTopics.map(topic => topic.id)).size, supportTopics.length);
  for (const topic of supportTopics) {
    assert.ok(topic.questions.length >= 3);
    for (const question of topic.questions) assert.ok(question.length >= 5 && question.length <= 400);
  }
  assert.equal(topicById('unknown').id, 'connectivity');
  assert.ok(topicById('safety').questions.some(question => question.includes('brake')));
});

test('an unresolved answer opens the request form with the concern already entered', () => {
  const triage = { category: 'INFOTAINMENT', priority: 'MEDIUM', critical: false, knowledgeBaseEligible: true, summary: 'Display restarts', recommendedAction: 'Search approved guidance; escalate if unresolved.' } as const;
  const draft = requestDraft({ question: 'My infotainment display keeps restarting.', source: 'bedrock', triage });
  assert.equal(draft.initialTitle, 'My infotainment display keeps restarting.');
  assert.match(draft.initialDescription, /^My infotainment display keeps restarting\./);
  assert.equal(draft.knowledgeBaseAttempted, true);
  assert.equal(requestDraft({ question: 'q'.repeat(400), source: 'unavailable', triage }).initialTitle.length, 150);
  assert.equal(requestDraft({ question: 'q'.repeat(400), source: 'unavailable', triage }).knowledgeBaseAttempted, false);
  assert.equal(requestDraft({ question: 'There is smoke coming from the car.', source: 'safety-rule', triage: { ...triage, critical: true } }).knowledgeBaseAttempted, false);
});

test('ticket description states the customer problem and never includes assistant answers', () => {
  const text = problemDescription('My display keeps restarting', 'It restarted again today');
  assert.match(text, /^Problem: My display keeps restarting/);
  assert.match(text, /Latest update from customer: It restarted again today/);
  assert.doesNotMatch(problemDescription('Brake noise', 'Brake noise'), /Latest update/);
  assert.ok(problemDescription('x'.repeat(6000), 'y').length <= 5000);
});

test('advisor workload counts exclude resolved and closed tickets', () => {
  const tickets = [
    { status: 'OPEN', priority: 'HIGH', advisorId: null },
    { status: 'WAITING_FOR_CUSTOMER', priority: 'LOW', advisorId: 'advisor' },
    { status: 'RESOLVED', priority: 'CRITICAL', advisorId: null },
  ];
  assert.deepEqual(ticketCounts(tickets), { open: 2, unassigned: 1, urgent: 1, waiting: 1 });
});

test('a fresh demo session requires explicit entry and sign-out clears it', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  assert.equal(hasDemoSession(storage), false);
  storage.setItem('servicecare-role', 'advisor');
  assert.equal(hasDemoSession(storage), false);
  beginDemoSession('customer', storage);
  assert.equal(hasDemoSession(storage), true);
  assert.equal(storage.getItem('servicecare-role'), 'customer');
  endDemoSession(storage);
  assert.equal(hasDemoSession(storage), false);
});

test('password recovery only links to the configured secure Cognito domain', () => {
  const url = passwordRecoveryUrl('https://auth.example.com', 'client123', 'https://overdrive.example.com');
  assert.ok(url?.startsWith('https://auth.example.com/forgotPassword?'));
  assert.equal(new URL(url!).searchParams.get('redirect_uri'), 'https://overdrive.example.com/auth/callback');
  assert.ok(passwordRecoveryUrl('https://auth.example.com', 'client123', 'http://localhost:5173'));
  assert.equal(passwordRecoveryUrl('https://auth.example.com', 'client123', 'http://attacker.example'), undefined);
  assert.equal(passwordRecoveryUrl('http://auth.example.com', 'client123', 'https://overdrive.example.com'), undefined);
  assert.equal(passwordRecoveryUrl(undefined, 'client123', 'https://overdrive.example.com'), undefined);
});

test('chat images enforce image-only types, size and count limits', () => {
  assert.equal(validateChatImage({ type: 'image/jpeg', size: 1024 }, 0), undefined);
  assert.ok(validateChatImage({ type: 'application/pdf', size: 1024 }, 0));
  assert.ok(validateChatImage({ type: 'image/png', size: 0 }, 0));
  assert.ok(validateChatImage({ type: 'image/webp', size: 11 * 1024 * 1024 }, 0));
  assert.ok(validateChatImage({ type: 'image/png', size: 1024 }, 5));
});

test('notifications use real ticket updates and never expose internal notes', () => {
  const ticket = { ticketId: 'TKT-test', title: 'Connectivity concern', status: 'IN_PROGRESS', updatedAt: '2026-11-02T09:00:00Z', history: [{ status: 'IN_PROGRESS', at: '2026-11-02T09:00:00Z', actor: 'advisor' }], messages: [
    { id: 'public', author: 'advisor', role: 'advisor', text: 'Public reply', internal: false, createdAt: '2026-11-02T09:01:00Z' },
    { id: 'private', author: 'advisor', role: 'advisor', text: 'Private assessment', internal: true, createdAt: '2026-11-02T09:02:00Z' },
  ] } as Ticket;
  const notifications = ticketNotifications([ticket], 'customer');
  assert.equal(notifications.length, 2);
  assert.equal(notifications[0].id, 'public');
  assert.equal(notifications.some(item => item.id === 'private'), false);
});

test('portal renders login, customer home, clean Ask and a separate advisor interface', async () => {
  const { createServer } = await import('vite');
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { MemoryRouter } = await import('react-router-dom');
  const { fileURLToPath } = await import('node:url');
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const previousDemoMode = process.env.VITE_DEMO_MODE;
  process.env.VITE_DEMO_MODE = 'true';
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage });
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), define: { 'import.meta.env.VITE_DEMO_MODE': JSON.stringify('true'), 'import.meta.env.VITE_VISUAL_API_URL': JSON.stringify('') }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  try {
    const { App } = await server.ssrLoadModule('/src/App.tsx');
    const { ConversationResult } = await server.ssrLoadModule('/src/components/Assistant.tsx');
    const { CustomerVehicleContent } = await server.ssrLoadModule('/src/components/VehicleRecords.tsx');
    const dashboard = { status: 'ok', customer: { owner_id: 'test-owner' }, vehicles: [
      { vehicle: { vin: 'TEST-VIN-1', model: '1 Series', model_year: 2023, registration: 'TEST-REG', powertrain: 'phev' }, diagnostic_events: [], telemetry: [
        { reading_key: 'reading-1', vin: 'TEST-VIN-1', signal_name: 'battery_12v_voltage', value_num: 0, unit: 'V', reading_ts: '2026-11-04 10:00:00', quality: 'good', source: 'telematics' },
        { reading_key: 'reading-2', vin: 'TEST-VIN-1', signal_name: 'fuel_level_pct', value_num: 39, unit: '%', reading_ts: '2026-11-04 10:00:00', quality: 'good', source: 'telematics' },
      ] },
      { vehicle: { vin: 'TEST-VIN-2', model: 'X1' }, telemetry: [], diagnostic_events: [{ event_key: 'event-1', vin: 'TEST-VIN-2', dtc_code: 'P0217', status: 'active', severity: 'safety_critical', safety_critical: true, odometer_km: 60512, event_ts: '2026-10-12 23:00:00', description: { title: 'Engine over-temperature', recommended_action: 'Stop safely.' } }] },
    ] };
    const vehicleMarkup = (loading: boolean, error: string) => renderToStaticMarkup(createElement(CustomerVehicleContent, { dashboard, loading, error }));
    for (const markup of [vehicleMarkup(false, ''), vehicleMarkup(true, ''), vehicleMarkup(false, 'Network unavailable')]) {
      assert.match(markup, /TEST-VIN-1/);
      assert.match(markup, /TEST-REG/);
      assert.match(markup, /Plug-in hybrid/);
      assert.match(markup, /Battery 12V voltage/);
      assert.match(markup, /profile-reading-value">0<small>V<\/small>/);
      assert.match(markup, /width:39%/);
      assert.match(markup, /Latest reading 04 Nov 2026, 10:00 · Source: Telematics/);
      assert.match(markup, /profile-telemetry/);
      assert.doesNotMatch(markup, /battery_12v_voltage/);
    }
    const safetyMarkup = renderToStaticMarkup(createElement(CustomerVehicleContent, { dashboard: { ...dashboard, vehicles: [...dashboard.vehicles].reverse() }, loading: false, error: '' }));
    assert.match(safetyMarkup, /60,512 km/);
    assert.match(safetyMarkup, /Recommended action:/);
    assert.equal(safetyMarkup.match(/Safety critical/g)?.length, 1);
    assert.match(vehicleMarkup(true, ''), /Refreshing vehicle data/);
    assert.match(vehicleMarkup(false, 'Network unavailable'), /Previously loaded records are still shown/);
    const guidance: AssistantAnswer = { question: 'My Bluetooth will not connect', answer: 'Pair the phone in settings.', source: 'agentcore', nextAction: 'guidance', citations: [{ title: 'Approved pairing guide', reference: 's3://private-bucket/manual.md' }], triage: { category: 'CONNECTIVITY', priority: 'MEDIUM', critical: false, knowledgeBaseEligible: true, summary: 'Pairing concern', recommendedAction: 'Use approved guidance.' } };
    const response = (answer: AssistantAnswer) => renderToStaticMarkup(createElement(ConversationResult, { answer, resolved: false, busy: false, onResolved() {}, onRequest() {}, onUnresolved() {}, onClose() {} }));
    const initialGuidance = response(guidance);
    assert.match(initialGuidance, /Still unresolved/);
    assert.doesNotMatch(initialGuidance, /Create a service request/);
    assert.match(initialGuidance, /Bedrock Knowledge Base/);
    assert.doesNotMatch(initialGuidance, /s3:\/\//);
    const escalated = response({ ...guidance, source: 'unavailable', citations: [], nextAction: 'offer-ticket', reason: 'no-alternative' });
    assert.match(escalated, /Create a service request/);
    assert.doesNotMatch(escalated, /Still unresolved|Was this answer helpful/);
    const render = (path: string) => renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [path] }, createElement(App)));
    const login = render('/login');
    assert.match(login, /Freude am Fahren/);
    assert.match(login, /WELCOME TO OVERDRIVE/);
    assert.doesNotMatch(login, /WILLKOMMEN/);
    assert.match(login, /src="\/brand\/bmw-logo\.png"/);
    assert.match(login, /Forgot password\?/);
    assert.doesNotMatch(login, /Good to have you here|bmw-wordmark|login-bottom|ServiceCare/);
    assert.match(login, /type="email"/);
    assert.match(login, /Enter demo/);
    assert.doesNotMatch(login, /chat-launcher/);
    beginDemoSession('customer', storage);
    const home = render('/home');
    assert.match(home, /Your BMW/);
    assert.match(home, /aria-label="Bottom navigation"/);
    assert.match(home, /class="portal-side-drawer/);
    assert.match(home, /notification-toggle/);
    assert.match(home, /aria-label="Open Overdrive chat"/);
    assert.match(home, /class="bmw-roundel"/);
    assert.doesNotMatch(home, /ServiceCare|bmw-wordmark/);
    assert.doesNotMatch(home, /aria-label="Demo role"/);
    const bottomNavigation = home.match(/<nav class="portal-bottom-nav"[\s\S]*?<\/nav>/)?.[0] ?? '';
    assert.match(bottomNavigation, /href="\/home"/);
    assert.match(bottomNavigation, /href="\/my-tickets"/);
    assert.doesNotMatch(bottomNavigation, /Help centre|Profile|service-assistant|profile/);
    assert.match(home, new RegExp(supportImages.workshop.split('?')[0]));
    const ask = render('/service-assistant?topic=charging');
    assert.match(ask, /Overdrive conversation/);
    assert.match(ask, /Choose a support topic/);
    assert.match(ask, /Charging &amp; battery/);
    assert.match(ask, /My vehicle is not charging/);
    assert.match(ask, /aria-label="Attach image"/);
    assert.doesNotMatch(ask, /class="servicecare-fab"|chat-panel|home-tagline/);
    assert.doesNotMatch(ask, /New ticket|href="\/create-ticket"|Preview scenario|Synthetic vehicle fixture/);
    assert.match(render('/my-tickets'), /href="\/create-ticket"/);
    assert.match(render('/my-tickets'), /Assistant conversations/);
    const request = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [{ pathname: '/create-ticket', state: { initialTitle: 'Display restarts', initialDescription: 'My infotainment display keeps restarting.' } }] }, createElement(App)));
    assert.match(request, /value="Display restarts"/);
    assert.match(request, /My infotainment display keeps restarting\./);
    const profile = render('/profile');
    assert.doesNotMatch(profile, /home-tagline|portal-account-icon/);
    assert.match(profile, /My BMW/);
    assert.match(profile, /Synthetic sample only/);
    beginDemoSession('advisor', storage);
    const advisor = render('/advisor');
    assert.match(advisor, /SERVICE ADVISOR DESK/);
    assert.doesNotMatch(advisor, /Unassigned/);
    assert.doesNotMatch(advisor, /servicecare-fab/);
    endDemoSession(storage);
    assert.match(render('/home'), /Freude am Fahren/);
  } finally {
    await server.close();
    if (previousDemoMode === undefined) delete process.env.VITE_DEMO_MODE;
    else process.env.VITE_DEMO_MODE = previousDemoMode;
    if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
  }
});