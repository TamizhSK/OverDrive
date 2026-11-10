import type { AssistantAnswer, ChatContext } from '@servicecare/contracts';

export function sameChatConcern(message: string, issue: string) {
  if (/\b(still|again|not resolved|not helpful|didn't work|did not work|same (?:issue|problem))\b/i.test(message)) return true;
  const ignored = new Set(['this', 'that', 'with', 'will', 'does', 'have', 'from', 'cannot', 'connect', 'connecting', 'working', 'problem', 'issue']);
  const meaningful = (issue.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(word => word.length > 3 && !ignored.has(word));
  const latest = new Set(message.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  return meaningful.some(word => latest.has(word));
}
export async function chatAnswer(input: {
  text: string; context?: ChatContext; explicitFollowUp: boolean; previous?: AssistantAnswer;
  request: (text: string, context?: ChatContext) => Promise<AssistantAnswer>;
}): Promise<AssistantAnswer> {
  const { text, context, explicitFollowUp, previous, request } = input;
  if (context && context.previousAnswers.length >= 2 && explicitFollowUp && previous) return {
    ...previous, question: text, answer: 'The guidance tried has not resolved your concern. Your service advisor should review it.',
    citations: [], source: 'unavailable', nextAction: 'offer-ticket', reason: 'no-alternative', contextApplied: true,
  };
  if (context?.unresolved && explicitFollowUp && previous && !previous.contextApplied) return {
    ...previous, question: text, answer: 'Additional grounded troubleshooting needs the updated chat service. Your advisor can review this unresolved concern.',
    citations: [], source: 'unavailable', nextAction: 'offer-ticket', reason: 'no-alternative',
  };
  let result = await request(text, context);
  if (result.triage.critical || ['HIGH', 'CRITICAL'].includes(result.triage.priority)) return { ...result, nextAction: 'urgent-ticket' };
  if (context?.unresolved && !result.contextApplied) result = {
    ...result, answer: 'No additional approved guidance is available in this chat version. Your advisor should review the unresolved concern.',
    citations: [], source: 'unavailable', nextAction: 'offer-ticket', reason: 'no-alternative',
  };
  return result;
}