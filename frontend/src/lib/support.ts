import type { AssistantAnswer, Role, Ticket } from '@servicecare/contracts';

export const supportTopics = [
  { id: 'connectivity', title: 'Phone & infotainment', description: 'Pairing, maps and your display', icon: 'phone', questions: ['How can I reconnect my phone?', 'My infotainment display keeps restarting.', 'How do I update my navigation maps?'] },
  { id: 'service', title: 'Service & maintenance', description: 'Service intervals and workshop visits', icon: 'wrench', questions: ['How do I check my service interval?', 'I would like to request a service appointment.', 'How do I raise a service request?'] },
  { id: 'charging', title: 'Charging & battery', description: 'Charging sessions and starting concerns', icon: 'charging', questions: ['My vehicle is not charging. What should I do?', 'My car struggles to start.', 'What information should I provide about a charging problem?'] },
  { id: 'comfort', title: 'Climate & comfort', description: 'Air conditioning and cabin features', icon: 'climate', questions: ['The air conditioning is not cooling.', 'My cabin heating is not working.', 'There is an unusual smell from the air vents.'] },
  { id: 'warranty', title: 'Warranty & ownership', description: 'Coverage, keys and ownership questions', icon: 'shield', questions: ['What does my warranty cover?', 'My vehicle key is not being recognized.', 'How can I ask an advisor about warranty coverage?'] },
  { id: 'safety', title: 'Warnings & roadside help', description: 'Warning messages and urgent concerns', icon: 'warning', questions: ['The brake warning remains on while driving.', 'There is smoke coming from the car.', 'I need help with a vehicle warning message.'] },
] as const;

export type TopicId = typeof supportTopics[number]['id'];
export const supportImages = {
  workshop: 'https://images.unsplash.com/photo-1580273916550-e323be2ae537?auto=format&fit=crop&w=2000&q=85',
  vehicle: 'https://images.unsplash.com/photo-1556189250-72ba954cfc2b?auto=format&fit=crop&w=1400&q=85',
};

export function topicById(id: string) { return supportTopics.find(topic => topic.id === id) ?? supportTopics[0]; }
/** Pre-fills the Create a service request page with the concern the customer just raised in chat. */
export function requestDraft(answer: Pick<AssistantAnswer, 'question' | 'source' | 'triage'>, files: File[] = []) {
  return {
    initialTitle: answer.question.slice(0, 150),
    initialDescription: `${answer.question}\n\nPlease include when this started and any relevant details.`,
    knowledgeBaseAttempted: !answer.triage.critical && answer.source !== 'unavailable',
    files,
  };
}
export function problemDescription(originalConcern: string, latestMessage: string) {
  const original = originalConcern.trim();
  const latest = latestMessage.trim();
  const lines = [`Problem: ${original}`];
  if (latest && latest !== original) lines.push(`Latest update from customer: ${latest}`);
  lines.push('Self-service guidance did not resolve this.', 'Please add when it started and any other relevant details.');
  return lines.join('\n\n').slice(0, 5000);
}
export function ticketCounts(tickets: readonly { status: string; priority: string; advisorId: string | null }[]) {
  const active = tickets.filter(ticket => !['RESOLVED', 'CLOSED'].includes(ticket.status));
  return {
    open: active.length, unassigned: active.filter(ticket => !ticket.advisorId).length,
    urgent: active.filter(ticket => ['HIGH', 'CRITICAL'].includes(ticket.priority)).length,
    waiting: active.filter(ticket => ticket.status === 'WAITING_FOR_CUSTOMER').length,
  };
}

export function ticketNotifications(tickets: readonly Ticket[], role: Role) {
  return tickets.flatMap(ticket => {
    const status = ticket.status.toLowerCase().replaceAll('_', ' ');
    const updates = [{ id: `${ticket.ticketId}:status:${ticket.history.length}`, ticketId: ticket.ticketId, title: ticket.title, text: ticket.status === 'OPEN' ? 'Service request received' : `Request status: ${status}`, at: ticket.history.at(-1)?.at ?? ticket.updatedAt }];
    const response = ticket.messages.filter(message => !message.internal && message.role !== role).at(-1);
    if (response) updates.push({ id: response.id, ticketId: ticket.ticketId, title: ticket.title, text: role === 'customer' ? 'Your service advisor sent a reply' : 'Customer sent a reply', at: response.createdAt });
    return updates;
  }).sort((first, second) => second.at.localeCompare(first.at)).slice(0, 25);
}