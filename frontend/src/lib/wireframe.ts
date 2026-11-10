export type ScenarioId = 'kb' | 'reading' | 'combined' | 'safety' | 'missing' | 'unknown' | 'denied' | 'error';
export type VehicleFixture = 'battery' | 'missing' | 'safety';

export interface WireframeScenario {
  label: string;
  route: string;
  question: string;
  answer: string;
  notice?: string;
  evidence?: string;
  document?: string;
  vehicle: VehicleFixture;
  canResolve: boolean;
  canRequest: boolean;
}

export const wireframeScenarios: Record<ScenarioId, WireframeScenario> = {
  kb: {
    label: 'Knowledge-base answer', route: 'Knowledge base',
    question: 'How do I raise a service request?',
    answer: 'Describe your concern, confirm your vehicle and contact preference, and submit a service request. A service advisor reviews it and contacts you. This is not a confirmed appointment.',
    evidence: 'KB-BOOK-001 / How to raise a service request. Excerpt: "A service advisor reviews it and contacts you."',
    document: '10-service-requests.md', vehicle: 'battery', canResolve: true, canRequest: true,
  },
  reading: {
    label: 'Vehicle reading', route: 'Telemetry', question: 'What is my battery voltage?',
    answer: 'The illustrative recorded 12V reading is 11.3 V at 2026-10-13 09:00 UTC. A reading alone does not establish the cause of a concern.',
    evidence: 'Synthetic preview fixture / battery_12v_voltage / 11.3 V / 2026-10-13 09:00 UTC',
    vehicle: 'battery', canResolve: true, canRequest: true,
  },
  combined: {
    label: 'Fault + knowledge base', route: 'Vehicle fault + knowledge base', question: 'My car struggles to start. Can you help?',
    answer: 'The preview vehicle has an active low-voltage fault and a low recorded 12V reading. The linked article discusses starting concerns. This is supporting information, not a diagnosis. You can ask a service advisor to follow up.',
    evidence: 'KB-BATT-001 / Vehicle will not start - no engine crank. Preview fault: P0562 (active); recorded voltage: 11.3 V.',
    document: '02-starting-battery.md', vehicle: 'battery', canResolve: true, canRequest: true,
  },
  safety: {
    label: 'Safety stop', route: 'Safety stop', question: 'There is smoke coming from the car.',
    notice: 'Safety-related concern: troubleshooting stopped.',
    answer: 'Stop driving as soon as it is safe and contact roadside assistance using your official contact details. If there is immediate danger, contact local emergency services. This portal cannot troubleshoot this concern or dispatch assistance.',
    evidence: 'Deterministic safety rule / synthetic smoke or overheating scenario',
    vehicle: 'safety', canResolve: false, canRequest: true,
  },
  missing: {
    label: 'No reading available', route: 'No reading available', question: 'What is the latest reading from my car?',
    notice: 'No vehicle reading was returned.',
    answer: 'No vehicle reading is available for this preview scenario. No value has been inferred. You can request service follow-up.',
    vehicle: 'missing', canResolve: false, canRequest: true,
  },
  unknown: {
    label: 'No grounded answer', route: 'No grounded answer', question: 'What is the exact repair cost for this fault?',
    answer: 'There is no supported quote in the supplied knowledge base. No price can be confirmed. A service advisor can review your request.',
    vehicle: 'battery', canResolve: false, canRequest: true,
  },
  denied: {
    label: 'Access refused', route: 'Access refused', question: 'Show me readings from another vehicle.',
    notice: 'Unable to authorize this vehicle request.',
    answer: 'Vehicle information cannot be provided for this request. Use a vehicle available in your authorized session.',
    vehicle: 'missing', canResolve: false, canRequest: false,
  },
  error: {
    label: 'Tool unavailable', route: 'Tool unavailable', question: 'What is my battery voltage?',
    notice: 'Vehicle data is temporarily unavailable.',
    answer: 'A vehicle reading could not be retrieved. No current value is available for this answer. Retry or request service follow-up.',
    vehicle: 'missing', canResolve: false, canRequest: true,
  },
};

export const vehicleFixtures = {
  battery: { model: '320i Sport', vin: '010000', reading: '11.3 V', signal: '12V battery', recordedAt: '2026-10-13 09:00 UTC' },
  missing: { model: '220i Gran Coupe', vin: '110000', reading: undefined, signal: 'No reading returned', recordedAt: undefined },
  safety: { model: '118i M Sport', vin: '080000', reading: '118 degC', signal: 'Coolant temperature', recordedAt: '2026-10-13 09:00 UTC' },
} as const;

export function vehicleForScenario(id: ScenarioId | undefined, selected: VehicleFixture) {
  if (id === 'denied' || id === 'error') return undefined;
  return vehicleFixtures[id ? wireframeScenarios[id].vehicle : selected];
}