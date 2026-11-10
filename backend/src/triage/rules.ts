import type { Triage } from '@servicecare/contracts';

export function classifyIssue(description: string): Triage {
  const text = description.toLowerCase();
  const critical = /brak|steer|smoke|fire|overheat|accident|collision|fluid leak|battery.*(hot|swell|burn)|tyre.*(burst|bulg)|tire.*(burst|bulg)|critical warning/.test(text);
  const category: Triage['category'] = critical ? 'SAFETY'
    : /air condition|cooling|climate|\bac\b/.test(text) ? 'CLIMATE_CONTROL'
    : /phone|pair|bluetooth|connect/.test(text) ? 'CONNECTIVITY'
    : /infotainment|display|navigation/.test(text) ? 'INFOTAINMENT'
    : /charg/.test(text) ? 'CHARGING'
    : /dent|scratch|body damage|windscreen/.test(text) ? 'BODY_DAMAGE'
    : /warranty/.test(text) ? 'WARRANTY'
    : /appointment|book.*service/.test(text) ? 'APPOINTMENT'
    : /maintenance|service interval|oil/.test(text) ? 'MAINTENANCE'
    : /noise|vibrat/.test(text) ? 'MECHANICAL' : 'GENERAL_SERVICE';
  const routineQuestion = !critical && /how (do|can|to)|pair|reconnect|reset|service interval|warranty|map update/.test(text);
  return {
    category, priority: critical ? 'HIGH' : routineQuestion ? 'LOW' : 'MEDIUM', critical,
    // Only safety concerns skip approved guidance; a request follows when the guidance does not resolve the concern.
    knowledgeBaseEligible: !critical, summary: description.slice(0, 500),
    recommendedAction: critical
      ? 'Do not rely on online troubleshooting. Contact roadside assistance or emergency services if there is immediate danger. An advisor must review this issue.'
      : 'Search approved guidance; escalate if unresolved.',
  };
}