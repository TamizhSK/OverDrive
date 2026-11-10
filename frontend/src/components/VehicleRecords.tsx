import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { CustomerDashboard, CustomerVehicle, DiagnosticEvent, TelemetryReading } from '../lib/api';
import {
  diagnosticChips, diagnosticFacts, humanize, readingIsText, readingNotes, readingPercent, readingUnit, readingValue,
  recordedAt, signalLabel, summarizeTelemetry, vehicleSpecs, vehicleTitle,
} from '../lib/vehicle-data';

function DiagnosticList({ events }: Readonly<{ events: DiagnosticEvent[] }>) {
  return (
    <ul className="profile-diagnostic-list">
      {events.map(event => {
        const facts = diagnosticFacts(event);
        return (
          <li key={event.event_key}>
            <div className="profile-diagnostic-top">
              <div>
                <strong>{event.dtc_code ?? 'Diagnostic event'}</strong>
                <span>{event.description?.title ?? 'Details unavailable'}</span>
              </div>
              <span className="profile-chips">
                {diagnosticChips(event).map(chip => <span key={chip.label} className={`profile-chip ${chip.tone}`}>{chip.label}</span>)}
              </span>
            </div>
            {facts.length > 0 && <dl className="profile-diagnostic-meta">{facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
            {event.description?.plain_language && <p>{event.description.plain_language}</p>}
            {event.description?.recommended_action && <p><strong>Recommended action:</strong> {event.description.recommended_action}</p>}
          </li>
        );
      })}
    </ul>
  );
}

function TelemetryGrid({ readings }: Readonly<{ readings: TelemetryReading[] }>) {
  const summary = summarizeTelemetry(readings);
  return (
    <>
      <p className="profile-telemetry-meta">
        Latest reading {recordedAt(summary.recordedAt)}
        {summary.sources.length === 1 && ` · Source: ${humanize(summary.sources[0])}`}
      </p>
      <ul className="profile-reading-grid">
        {summary.tiles.map(reading => {
          const percent = readingPercent(reading);
          const notes = readingNotes(reading, summary);
          const unit = readingUnit(reading.unit);
          return (
            <li key={reading.signal_name} className="profile-reading">
              <span className="profile-reading-label">{signalLabel(reading.signal_name)}</span>
              <strong className={readingIsText(reading) ? 'profile-reading-value is-text' : 'profile-reading-value'}>{readingValue(reading)}{unit && <small>{unit}</small>}</strong>
              {percent !== undefined && <span className="profile-reading-gauge" aria-hidden="true"><i style={{ width: `${percent}%` }} /></span>}
              {notes.length > 0 && <span className="profile-reading-notes">{notes.join(' · ')}</span>}
            </li>
          );
        })}
      </ul>
      {summary.earlier.length > 0 && (
        <details className="profile-reading-history">
          <summary>Earlier readings ({summary.earlier.length})</summary>
          <ul>
            {summary.earlier.map(reading => (
              <li key={reading.reading_key}>
                <span>{signalLabel(reading.signal_name)}</span>
                <strong>{[readingValue(reading), readingUnit(reading.unit)].filter(Boolean).join(' ')}</strong>
                <span>{recordedAt(reading.reading_ts)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function VehicleRecord({ record }: Readonly<{ record: CustomerVehicle }>) {
  const { vehicle, diagnostic_events = [], telemetry = [] } = record;
  return (
    <article className="profile-vehicle-record">
      <header className="profile-record-heading">
        <h3>{vehicleTitle(vehicle)}</h3>
        <span className="profile-vin"><small>VIN</small>{vehicle.vin}</span>
      </header>
      <dl className="profile-vehicle-specs">
        {vehicleSpecs(vehicle).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
      <section className="profile-data-block">
        <h4>Diagnostic history <span>{diagnostic_events.length}</span></h4>
        {diagnostic_events.length > 0
          ? <DiagnosticList events={diagnostic_events} />
          : <p className="profile-data-note">No diagnostic events were returned for this vehicle.</p>}
      </section>
      {telemetry.length > 0 ? (
        <details className="profile-telemetry">
          <summary>
            <span className="profile-telemetry-title">Telemetry readings <span>{telemetry.length}</span></span>
            <ChevronDown size={16} aria-hidden="true" />
          </summary>
          <div className="profile-telemetry-body"><TelemetryGrid readings={telemetry} /></div>
        </details>
      ) : (
        <section className="profile-data-block">
          <h4>Telemetry readings <span>0</span></h4>
          <p className="profile-data-note">No telemetry readings were returned for this vehicle.</p>
        </section>
      )}
    </article>
  );
}

export function CustomerVehicleContent({ dashboard, loading, error }: Readonly<{ dashboard?: CustomerDashboard; loading: boolean; error: string }>) {
  const [selectedVin, setSelectedVin] = useState<string>();
  if (!dashboard && loading) return <output className="profile-data-note">Loading verified vehicle data...</output>;
  if (!dashboard && error) return <p className="alert error" role="alert">{error}</p>;
  if (!dashboard?.vehicles.length) return <p className="profile-data-note">No identity-verified vehicle is connected yet. Vehicle information will appear here once connected.</p>;
  const current = dashboard.vehicles.find(record => record.vehicle.vin === selectedVin) ?? dashboard.vehicles[0];
  const diagnosticCount = dashboard.vehicles.reduce((total, item) => total + (item.diagnostic_events?.length ?? 0), 0);
  const telemetryCount = dashboard.vehicles.reduce((total, item) => total + (item.telemetry?.length ?? 0), 0);
  return (
    <>
      {loading && <output className="sr-only">Refreshing vehicle data</output>}
      {error && <p className="alert error" role="alert">Could not refresh vehicle data. Previously loaded records are still shown. {error}</p>}
      <div className="profile-data-summary">
        <div><strong>{dashboard.vehicles.length}</strong><span>Vehicles</span></div>
        <div><strong>{diagnosticCount}</strong><span>Diagnostic events</span></div>
        <div><strong>{telemetryCount}</strong><span>Telemetry readings</span></div>
      </div>
      <div className="profile-vehicle-list">
        {dashboard.vehicles.length > 1 && (
          <div className="profile-vehicle-picker">
            <label htmlFor="profile-vehicle-select">Select vehicle</label>
            <select id="profile-vehicle-select" value={current.vehicle.vin} onChange={event => setSelectedVin(event.target.value)}>
              {dashboard.vehicles.map(record => <option key={record.vehicle.vin} value={record.vehicle.vin}>{vehicleTitle(record.vehicle)} · {record.vehicle.vin}</option>)}
            </select>
          </div>
        )}
        <VehicleRecord key={current.vehicle.vin} record={current} />
      </div>
      <p className="profile-data-note">Diagnostics and readings are recorded service-system data, not a live status or diagnosis.</p>
    </>
  );
}
