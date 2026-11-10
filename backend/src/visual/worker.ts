import { visualAwsDependencies } from './aws.ts';
import { visualService } from './service.ts';

const service = visualService(visualAwsDependencies());
type StreamEvent = { Records: { dynamodb?: { SequenceNumber?: string; NewImage?: { sessionId?: { S?: string } } } }[] };
export async function handler(event: StreamEvent) {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    const id = record.dynamodb?.NewImage?.sessionId?.S;
    const sequence = record.dynamodb?.SequenceNumber;
    if (!id || !sequence) continue;
    try { await service.work(id); }
    catch { batchItemFailures.push({ itemIdentifier: sequence }); }
  }
  return { batchItemFailures };
}