import { z } from 'zod';
import type { VisualGuidance } from '@servicecare/contracts/visual';

export type KnowledgePassage = { text: string; reference: string };
const answerSchema = z.object({
  answer: z.string().trim().min(1).max(6000),
  citationIds: z.array(z.number().int().min(0)).max(5),
});
export function knowledgeGuidance(deps: {
  retrieve: (question: string) => Promise<KnowledgePassage[]>;
  answer: (question: string, passages: KnowledgePassage[]) => Promise<string>;
}) {
  return async (question: string): Promise<VisualGuidance> => {
    const passages = (await deps.retrieve(question)).filter(item => item.text && item.reference).slice(0, 5);
    const fallback = { answer: 'No cited guidance was found. A service advisor should review this concern.', citations: [], grounded: false };
    if (!passages.length) return fallback;
    const result = answerSchema.parse(JSON.parse(await deps.answer(question, passages)));
    if (!result.citationIds.length || result.citationIds.some(index => index >= passages.length)) return fallback;
    const citations = [...new Set(result.citationIds)].map(index => ({ title: `Service guidance ${index + 1}`, reference: passages[index].reference }));
    return { answer: result.answer, citations, grounded: true };
  };
}