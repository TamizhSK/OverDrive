import assert from 'node:assert/strict';
import { test } from 'node:test';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { Ticket } from '@servicecare/contracts';
import { deriveTicketEvents, publishStreamRecords, type TicketStreamRecord } from '../src/events/stream.ts';
import { customerMessage, processBatch, type TicketActionDependencies } from '../src/notifications/worker.ts';

const now = '2026-11-10T10:00:00.000Z';
const ticket: Ticket = {
  ticketId: 'TKT-11111111-2222-4333-8444-555555555555', customerId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', vin: 'WBA00000000000001',
  title: 'Display issue', description: 'The center display stopped responding.', attachments: [],
  category: 'INFOTAINMENT', priority: 'MEDIUM', aiSummary: 'Display not responding.', status: 'OPEN', source: 'CUSTOMER_PORTAL', advisorId: null,
  knowledgeBaseAttempted: false, knowledgeBaseResolved: false, messages: [], history: [{ status: 'OPEN', at: now, actor: 'customer' }],
  createdAt: now, updatedAt: now, version: 1,
};
const image = (value: Ticket) => marshall(value, { removeUndefinedValues: true }) as NonNullable<TicketStreamRecord['dynamodb']>['NewImage'];
const insert = (value: Ticket, sequence = '1'): TicketStreamRecord => ({ eventName: 'INSERT', dynamodb: { NewImage: image(value), SequenceNumber: sequence } });
const modify = (before: Ticket, after: Ticket, sequence = '2'): TicketStreamRecord => ({ eventName: 'MODIFY', dynamodb: { OldImage: image(before), NewImage: image(after), SequenceNumber: sequence } });
const message = (role: 'customer' | 'advisor', internal = false) => ({ id: `m-${role}-${internal}`, author: role, role, text: 'Private conversation text', internal, createdAt: now });

test('every kind of ticket write becomes the right domain event, without ticket content', () => {
  const [created] = deriveTicketEvents(insert(ticket));
  assert.equal(created.type, 'TicketCreated');
  assert.deepEqual(Object.keys(created.detail).sort(), ['category', 'customerId', 'priority', 'status', 'ticketId']);
  assert.equal(JSON.stringify(created).includes(ticket.description), false);
  assert.equal(JSON.stringify(created).includes(ticket.vin!), false);

  const assigned = { ...ticket, advisorId: 'advisor-1', status: 'ASSIGNED' as const, version: 2 };
  assert.deepEqual(deriveTicketEvents(modify(ticket, assigned)).map(event => event.type), ['TicketAssigned']);
  assert.deepEqual(deriveTicketEvents(modify(assigned, { ...assigned, status: 'IN_PROGRESS' })).map(event => event.type), ['TicketStatusChanged']);
  const resolved = deriveTicketEvents(modify(assigned, { ...assigned, status: 'RESOLVED' }));
  assert.deepEqual(resolved.map(event => [event.type, event.detail.previousStatus]), [['TicketResolved', 'ASSIGNED']]);

  const replied = deriveTicketEvents(modify(assigned, { ...assigned, messages: [message('advisor')] }));
  assert.deepEqual(replied.map(event => [event.type, event.detail.authorRole]), [['TicketMessageAdded', 'advisor']]);
  assert.equal(JSON.stringify(replied).includes('Private conversation text'), false);
  assert.deepEqual(deriveTicketEvents(modify(assigned, { ...assigned, messages: [message('advisor', true)] })), [], 'internal notes stay internal');
  assert.deepEqual(deriveTicketEvents(modify(assigned, { ...assigned, priority: 'HIGH' })), [], 'a priority-only edit has no customer or advisor audience');
  assert.deepEqual(deriveTicketEvents({ eventName: 'REMOVE', dynamodb: { OldImage: image(ticket) } }), []);
});

test('stream records are published in order and a failure is retried from that record', async () => {
  const sent: string[][] = [];
  const records = [insert(ticket, '1'), modify(ticket, { ...ticket, advisorId: 'advisor-1', status: 'ASSIGNED' }, '2'), insert({ ...ticket, ticketId: 'TKT-2' }, '3')];
  const ok = await publishStreamRecords(records, async entries => { sent.push(entries.map(entry => entry.DetailType!)); return { FailedEntryCount: 0 }; }, 'default');
  assert.deepEqual(ok, { batchItemFailures: [] });
  assert.deepEqual(sent, [['TicketCreated'], ['TicketAssigned'], ['TicketCreated']]);

  let calls = 0;
  const failed = await publishStreamRecords(records, async () => (++calls === 2 ? { FailedEntryCount: 1, Entries: [{ ErrorCode: 'ThrottlingException' }] } : { FailedEntryCount: 0 }), 'default');
  assert.deepEqual(failed, { batchItemFailures: [{ itemIdentifier: '2' }] });
  assert.equal(calls, 2, 'records after the failure are not published out of order');
});

function fakeDeps(overrides: Partial<TicketActionDependencies> = {}) {
  const workflows: { name: string; input: unknown }[] = [];
  const emails: { to: string; subject: string; body: string }[] = [];
  const deps: TicketActionDependencies = {
    webOrigin: 'https://servicecare.example',
    getTicket: async id => (id === ticket.ticketId ? ticket : undefined),
    startWorkflow: async (name, input) => { workflows.push({ name, input }); },
    customerEmail: async id => (id === ticket.customerId ? 'customer@example.com' : undefined),
    sendEmail: async (to, subject, body) => { emails.push({ to, subject, body }); },
    ...overrides,
  };
  return { deps, workflows, emails };
}
const envelope = (type: string, detail: Record<string, unknown> = {}) => ({
  messageId: `msg-${type}`,
  body: JSON.stringify({ 'detail-type': type, detail: { ticketId: ticket.ticketId, customerId: ticket.customerId, status: 'OPEN', priority: 'MEDIUM', category: 'INFOTAINMENT', ...detail } }),
});

test('a new ticket starts the diagnostics workflow once, named after the ticket, and confirms receipt to the customer', async () => {
  const { deps, workflows, emails } = fakeDeps();
  assert.deepEqual(await processBatch([envelope('TicketCreated')], deps), { batchItemFailures: [] });
  assert.deepEqual(workflows, [{ name: ticket.ticketId, input: { vin: ticket.vin, ownerId: ticket.customerId, customerIssue: `${ticket.title}\n${ticket.description}` } }]);
  assert.equal(emails.length, 1);
  assert.match(emails[0].subject, /TKT-11\.\.\.5555 is received/);
  assert.equal(emails[0].body.includes(ticket.description), false, 'emails never contain ticket content');
  assert.match(emails[0].body, /https:\/\/servicecare\.example/);
});

test('advisor-side changes email the customer; failures are retried per message', async () => {
  const { deps, emails } = fakeDeps();
  await processBatch([envelope('TicketAssigned', { status: 'ASSIGNED' }), envelope('TicketResolved', { status: 'RESOLVED' }), envelope('TicketMessageAdded', { authorRole: 'advisor' })], deps);
  assert.deepEqual(emails.map(email => email.subject), [
    'Your service request TKT-11...5555 is assigned to a service advisor',
    'Your service request TKT-11...5555 is resolved',
    'Your service advisor replied (request TKT-11...5555)',
  ]);
  assert.equal(customerMessage('TicketMessageAdded', { ticketId: 'TKT-1', customerId: 'c', status: 'OPEN', priority: 'LOW', category: 'OTHER', authorRole: 'customer' }, ''), undefined);

  const flaky = fakeDeps({ sendEmail: async () => { throw new Error('Throttling'); } });
  const result = await processBatch([envelope('TicketResolved', { status: 'RESOLVED' }), { messageId: 'bad', body: 'not json' }], flaky.deps);
  assert.deepEqual(result.batchItemFailures.map(item => item.itemIdentifier).sort(), ['bad', 'msg-TicketResolved']);
});

test('without a workflow or a verified sender the actions are skipped, not failed', async () => {
  const { deps } = fakeDeps({ startWorkflow: undefined, customerEmail: undefined, sendEmail: undefined });
  assert.deepEqual(await processBatch([envelope('TicketCreated'), envelope('TicketResolved', { status: 'RESOLVED' })], deps), { batchItemFailures: [] });
  const noVin = fakeDeps({ getTicket: async () => ({ ...ticket, vin: undefined }) });
  await processBatch([envelope('TicketCreated')], noVin.deps);
  assert.equal(noVin.workflows.length, 0);
});
