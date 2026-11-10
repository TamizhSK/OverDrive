import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { InvokeHarnessCommandInput, InvokeHarnessStreamOutput } from '@aws-sdk/client-bedrock-agentcore';
import { statuses, type Ticket } from '@servicecare/contracts';
import { approvedPayloadHash, ticketToolSchemas, type TicketTool } from './gateway.ts';

const receiptSchema = z.object({ ok: z.literal(true), ticket: z.looseObject({ ticketId: z.string().min(5), customerId: z.string().min(1), status: z.enum(statuses), version: z.number().int().positive() }) });
function receipt(value: unknown): Ticket | undefined {
  if (value && typeof value === 'object' && (value as { isError?: unknown }).isError === true) return undefined;
  const direct = receiptSchema.safeParse(value);
  if (direct.success) return direct.data.ticket as unknown as Ticket;
  if (!value || typeof value !== 'object') return undefined;
  const message = value as { result?: unknown; content?: { text?: string }[] };
  if (message.result) return receipt(message.result);
  for (const content of message.content ?? []) {
    if (!content.text || content.text.length > 100000) continue;
    try { const parsed = receiptSchema.safeParse(JSON.parse(content.text)); if (parsed.success) return parsed.data.ticket as unknown as Ticket; } catch { continue; }
  }
  return undefined;
}
type ResultBlock = { text: string; values: unknown[] };
function recordToolStart(start: InvokeHarnessStreamOutput['contentBlockStart'], expectedTool: string, calls: Map<string, string>, blocks: Map<number, ResultBlock>) {
  const use = start?.start?.toolUse;
  if (use?.toolUseId) calls.set(use.toolUseId, use.name ?? '');
  const result = start?.start?.toolResult;
  if (!result?.toolUseId || result.status !== 'success' || calls.get(result.toolUseId) !== expectedTool) return;
  blocks.set(start!.contentBlockIndex!, { text: '', values: [] });
}
function resultValues(block: ResultBlock): unknown[] {
  if (!block.text) return block.values;
  try { return [...block.values, JSON.parse(block.text)]; }
  catch { return []; }
}
function appendResultParts(block: ResultBlock, parts: { text?: string; json?: unknown }[]) {
  for (const part of parts) {
    if (part.text) block.text += part.text;
    if (part.json) block.values.push(part.json);
  }
  if (block.text.length > 100000) throw new Error('Ticket result exceeds the limit.');
}
async function registeredToolResults(stream: AsyncIterable<InvokeHarnessStreamOutput>, expectedTool: string): Promise<unknown[]> {
  const calls = new Map<string, string>();
  const blocks = new Map<number, ResultBlock>();
  for await (const event of stream) {
    if (event.internalServerException || event.validationException || event.runtimeClientError) throw new Error('Agent ticket action failed.');
    recordToolStart(event.contentBlockStart, expectedTool, calls, blocks);
    const delta = event.contentBlockDelta;
    const block = delta && blocks.get(delta.contentBlockIndex!);
    if (!block) continue;
    appendResultParts(block, delta?.delta?.toolResult ?? []);
  }
  return [...blocks.values()].flatMap(resultValues);
}
export async function runTicketAgent(input: {
  harnessArn: string; gatewayUrl: string; authorization: string; actorId: string; operation: TicketTool;
  data: unknown; requestId: string; confirmed: boolean; advisor: boolean;
}, invoke: (request: InvokeHarnessCommandInput) => Promise<AsyncIterable<InvokeHarnessStreamOutput>>): Promise<Ticket> {
  if (!/^https:\/\/[a-z0-9-]+\.gateway\.bedrock-agentcore\.us-east-1\.amazonaws\.com\/mcp$/.test(input.gatewayUrl)) throw new Error('Unapproved ticket gateway URL.');
  const data = ticketToolSchemas[input.operation].parse(input.data);
  const expectedTool = `ticketbackend___${input.operation}`;
  const stream = await invoke({
    harnessArn: input.harnessArn, runtimeSessionId: randomUUID(), actorId: input.actorId, runtimeUserId: input.actorId,
    model: { bedrockModelConfig: { modelId: 'amazon.nova-lite-v1:0', apiFormat: 'converse_stream', temperature: 0, maxTokens: 800 } },
    maxIterations: 2, maxTokens: 1600, timeoutSeconds: 20,
    tools: [{ type: 'remote_mcp', name: 'servicecare_tickets', config: { remoteMcp: { url: input.gatewayUrl, headers: {
      Authorization: input.authorization, 'x-servicecare-operation': input.operation, 'x-servicecare-payload-hash': approvedPayloadHash(input.operation, data),
      'x-servicecare-confirmed': String(input.confirmed), 'x-servicecare-request-id': input.requestId,
    } } } }],
    skills: [], allowedTools: [`@servicecare_tickets/${expectedTool}`],
    systemPrompt: [{ text: 'The backend has approved the exact operation and data below. Call only the allowed ticket tool with exactly that data. Never change vehicle, ticket or customer references, or invent a result. A ticket is created only when the tool reports a persisted ticket. Do not use shell or other tools.' }],
    messages: [{ role: 'user', content: [{ text: JSON.stringify({ operation: expectedTool, approvedData: data }) }] }],
  });
  for (const value of await registeredToolResults(stream, expectedTool)) {
      const saved = receipt(value);
      if (!saved) continue;
      if (!input.advisor && saved.customerId !== input.actorId) throw new Error('Ticket result is not owned by this customer.');
      if ('ticketId' in data && saved.ticketId !== data.ticketId) throw new Error('Ticket result does not match the approved ticket.');
      if ('vin' in data && saved.vin !== data.vin) throw new Error('Ticket result does not match the approved vehicle.');
      return saved;
  }
  throw new Error('No confirmed backend ticket result was returned.');
}