import assert from 'node:assert/strict';
import { test } from 'node:test';
import { vehicleForScenario, wireframeScenarios } from '../src/lib/wireframe.ts';

test('all eight wireframe states have explicit routing and follow-up behavior', () => {
  assert.equal(Object.keys(wireframeScenarios).length, 8);
  assert.equal(wireframeScenarios.safety.canResolve, false);
  assert.equal(wireframeScenarios.denied.canRequest, false);
  for (const id of ['safety', 'missing', 'unknown', 'denied', 'error'] as const) assert.equal(wireframeScenarios[id].canResolve, false, id);
  assert.equal(wireframeScenarios.kb.document, '10-service-requests.md');
});

test('unavailable and denied states never show a stale vehicle reading', () => {
  assert.equal(vehicleForScenario('denied', 'battery'), undefined);
  assert.equal(vehicleForScenario('error', 'battery'), undefined);
  assert.equal(vehicleForScenario('missing', 'battery')?.reading, undefined);
  assert.equal(vehicleForScenario('reading', 'missing')?.reading, '11.3 V');
  assert.equal(vehicleForScenario('safety', 'battery')?.recordedAt, '2026-10-13 09:00 UTC');
});