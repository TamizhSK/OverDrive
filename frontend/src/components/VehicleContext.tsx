import { useState } from 'react';
import { Activity, CarFront, ChevronDown, Clock3, ShieldCheck } from 'lucide-react';
import { demoMode } from '../lib/auth';
import { vehicleForScenario, vehicleFixtures, wireframeScenarios, type ScenarioId, type VehicleFixture } from '../lib/wireframe';

interface Props {
  scenario?: ScenarioId;
  selected: VehicleFixture;
  onSelect: (vehicle: VehicleFixture) => void;
  critical: boolean;
  dataUnavailable: boolean;
}

export function VehicleContext({ scenario, selected, onSelect, critical, dataUnavailable }: Readonly<Props>) {
  const [expanded, setExpanded] = useState(false);
  const vehicle = demoMode ? vehicleForScenario(scenario, selected) : undefined;
  const reading = dataUnavailable ? undefined : vehicle?.reading;
  return <aside className="vehicle-context" aria-label="Vehicle context">
    <div className="context-header"><div className="context-title"><CarFront size={22} /><h2>My vehicle</h2></div><button className="context-toggle" aria-label="Vehicle details" aria-expanded={expanded} aria-controls="vehicle-context-details" onClick={() => setExpanded(current => !current)}><span>{reading ?? 'Not available'}</span><ChevronDown size={18} /></button></div>
    <div className="context-mobile-summary"><span>{vehicle?.model ?? 'Vehicle data unavailable'}</span><small>{reading ? 'Recorded sample, not live' : 'No reading available'}</small></div>
    <div id="vehicle-context-details" className={`vehicle-context-body ${expanded ? 'is-expanded' : ''}`}>
    {demoMode ? <>
      <label htmlFor="vehicle-fixture">Synthetic vehicle fixture</label>
      <select id="vehicle-fixture" value={scenario ? wireframeScenarios[scenario].vehicle : selected} onChange={event => onSelect(event.target.value as VehicleFixture)}>
        {Object.entries(vehicleFixtures).map(([key, fixture]) => <option key={key} value={key}>{fixture.model} / ...{fixture.vin}</option>)}
      </select>
    </> : <p className="context-unavailable">Vehicle context is not connected.</p>}
    <div className="vehicle-identity">
      <h3>{vehicle?.model ?? 'No vehicle information available'}</h3>
      {vehicle && <p>Vehicle ID ...{vehicle.vin}</p>}
      <span className="context-provenance">{demoMode ? 'Synthetic preview only. Not an authorized vehicle session.' : 'An identity-verified vehicle connection is required.'}</span>
    </div>
    <section className="vehicle-reading" aria-label="Latest recorded reading">
      <div className="reading-label"><Activity size={17} /><h3>Latest recorded reading</h3></div>
      <div className="reading-value">{reading ?? 'Not available'}</div>
      <p>{reading ? vehicle?.signal : 'No reading returned'}</p>
      <div className="recorded-at"><Clock3 size={14} /><span>Recorded at: {reading ? vehicle?.recordedAt : 'not available'}</span></div>
      <p className="reading-disclaimer">{reading ? 'Recorded sample, not live vehicle data' : 'No value inferred or substituted'}</p>
    </section>
    <section className={`context-safety ${critical ? 'is-critical' : ''}`}>
      <ShieldCheck size={20} />
      <h3>{critical ? 'Troubleshooting stopped' : 'Safety comes first'}</h3>
      <p>Brake, steering, smoke, overheating and battery-safety concerns require human review.</p>
      <p>In immediate danger, contact local emergency services or official roadside assistance.</p>
    </section>
    </div>
  </aside>;
}