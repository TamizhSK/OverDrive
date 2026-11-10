import type { DiagnosticEvent, TelemetryReading, VehicleInfo } from './api';

export type ChipTone = 'danger' | 'warning' | 'info' | 'active' | 'neutral';
export interface TelemetrySummary { tiles: TelemetryReading[]; earlier: TelemetryReading[]; recordedAt?: string; sources: string[] }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]00:?00)?)?$/;
const SIGNAL_WORDS: Record<string, string> = {
  fl: 'front left', fr: 'front right', rl: 'rear left', rr: 'rear right',
  hv: 'HV', soc: 'state of charge', soh: 'state of health', adblue: 'AdBlue', '12v': '12V',
};
const UNIT_SUFFIXES = new Set(['c', 'pct', 'km', 'bar']);
const UNIT_SYMBOLS: Record<string, string> = { degC: '°C' };
const POWERTRAINS: Record<string, string> = { bev: 'Electric', phev: 'Plug-in hybrid', petrol: 'Petrol', diesel: 'Diesel' };
const SEVERITY_TONES: Record<string, ChipTone> = { urgent: 'danger', advisory: 'warning', info: 'info' };
const SIGNAL_ORDER = [
  'odometer_km', 'range_estimate_km', 'fuel_level_pct', 'hv_battery_soc_pct', 'charging_state', 'hv_battery_soh_pct',
  'battery_12v_voltage', 'adblue_level_pct', 'engine_oil_level_pct', 'coolant_temp_c', 'ambient_temp_c',
  'tyre_pressure_fl_bar', 'tyre_pressure_fr_bar', 'tyre_pressure_rl_bar', 'tyre_pressure_rr_bar',
  'brake_pad_front_pct', 'brake_pad_rear_pct', 'door_lock_state',
];

const present = (value: unknown) => value !== undefined && value !== null && value !== '';
const parsedTime = (value: string) => Date.parse(value.includes('T') ? value : value.replace(' ', 'T'));
const formatNumber = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : String(value);
};

export function humanize(value: string): string {
  const text = value.replaceAll(/[_-]+/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Shown as recorded: the API sends no zone unless the value ends in Z.
export function recordedAt(value?: string | null): string {
  if (!value) return '—';
  const match = TIMESTAMP.exec(value.trim());
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  if (!match || !month) return value;
  const [, year, , day, hour, minute, zone] = match;
  const time = hour ? `, ${hour}:${minute}${zone ? ' UTC' : ''}` : '';
  return `${day} ${month} ${year}${time}`;
}

export function signalLabel(name: string): string {
  const parts = name.toLowerCase().split('_').filter(Boolean);
  if (parts.length > 1 && UNIT_SUFFIXES.has(parts.at(-1) ?? '')) parts.pop();
  return humanize(parts.map(part => SIGNAL_WORDS[part] ?? part).join(' '));
}

function readingNumber(reading: Pick<TelemetryReading, 'value_num'>): number | undefined {
  if (!present(reading.value_num)) return undefined;
  const number = Number(reading.value_num);
  return Number.isFinite(number) ? number : undefined;
}

export function readingValue(reading: Pick<TelemetryReading, 'value_num' | 'value_text'>): string {
  const number = readingNumber(reading);
  if (number !== undefined) return formatNumber(number);
  if (present(reading.value_num)) return String(reading.value_num);
  return present(reading.value_text) ? humanize(String(reading.value_text)) : '—';
}

export function readingUnit(unit?: string): string {
  return unit ? UNIT_SYMBOLS[unit] ?? unit : '';
}

export function readingIsText(reading: Pick<TelemetryReading, 'value_num'>): boolean {
  return readingNumber(reading) === undefined;
}

export function readingPercent(reading: TelemetryReading): number | undefined {
  const number = readingNumber(reading);
  return reading.unit === '%' && number !== undefined && number >= 0 && number <= 100 ? number : undefined;
}

export function readingNotes(reading: TelemetryReading, summary: Pick<TelemetrySummary, 'recordedAt' | 'sources'>): string[] {
  const notes: string[] = [];
  if (reading.reading_ts !== summary.recordedAt) notes.push(recordedAt(reading.reading_ts));
  if (summary.sources.length > 1 && reading.source) notes.push(humanize(reading.source));
  if (reading.quality && reading.quality.toLowerCase() !== 'good') notes.push(`Quality: ${humanize(reading.quality)}`);
  return notes;
}

export function summarizeTelemetry(readings: TelemetryReading[]): TelemetrySummary {
  const latest = new Map<string, TelemetryReading>();
  const earlier: TelemetryReading[] = [];
  for (const reading of readings) {
    const current = latest.get(reading.signal_name);
    if (!current) latest.set(reading.signal_name, reading);
    else if (parsedTime(reading.reading_ts) > parsedTime(current.reading_ts)) {
      earlier.push(current);
      latest.set(reading.signal_name, reading);
    } else earlier.push(reading);
  }
  const rank = (name: string) => {
    const index = SIGNAL_ORDER.indexOf(name);
    return index === -1 ? SIGNAL_ORDER.length : index;
  };
  const tiles = [...latest.values()].sort((a, b) => rank(a.signal_name) - rank(b.signal_name) || signalLabel(a.signal_name).localeCompare(signalLabel(b.signal_name)));
  earlier.sort((a, b) => (parsedTime(b.reading_ts) || 0) - (parsedTime(a.reading_ts) || 0));
  const newest = tiles.reduce<TelemetryReading | undefined>((best, reading) => (!best || parsedTime(reading.reading_ts) > parsedTime(best.reading_ts) ? reading : best), undefined);
  const sources = [...new Set(readings.map(reading => reading.source).filter((source): source is string => Boolean(source)))];
  return { tiles, earlier, recordedAt: newest?.reading_ts, sources };
}

export function vehicleTitle(vehicle: VehicleInfo): string {
  const name = [vehicle.make ?? 'BMW', vehicle.model ?? 'vehicle'].join(' ');
  return vehicle.model_year ? `${name} (${vehicle.model_year})` : name;
}

export function vehicleSpecs(vehicle: VehicleInfo): [string, string][] {
  const fields: [string, unknown][] = [
    ['Registration', vehicle.registration], ['Variant', vehicle.variant], ['Colour', vehicle.colour],
    ['Body style', vehicle.body_style], ['Powertrain', vehicle.powertrain && (POWERTRAINS[vehicle.powertrain.toLowerCase()] ?? humanize(vehicle.powertrain))],
    ['Service plan', vehicle.service_plan], ['Home dealer', vehicle.home_dealer], ['Region', vehicle.region],
    ['Last service', vehicle.last_service_date && recordedAt(vehicle.last_service_date)],
    ['Next service due', vehicle.next_service_due_date && recordedAt(vehicle.next_service_due_date)],
  ];
  return fields.filter(([, value]) => present(value)).map(([label, value]): [string, string] => [label, String(value)]);
}

export function diagnosticChips(event: DiagnosticEvent): { label: string; tone: ChipTone }[] {
  const chips: { label: string; tone: ChipTone }[] = [];
  if (event.safety_critical === true || event.severity === 'safety_critical') chips.push({ label: 'Safety critical', tone: 'danger' });
  if (event.severity && event.severity !== 'safety_critical') chips.push({ label: humanize(event.severity), tone: SEVERITY_TONES[event.severity] ?? 'neutral' });
  if (event.status) chips.push({ label: humanize(event.status), tone: event.status === 'active' ? 'active' : 'neutral' });
  return chips;
}

export function diagnosticFacts(event: DiagnosticEvent): [string, string][] {
  const facts: [string, unknown][] = [
    ['ECU', event.ecu], ['Occurrences', event.occurrence_count],
    ['Odometer', present(event.odometer_km) ? `${formatNumber(event.odometer_km)} km` : undefined],
    ['First seen', event.first_seen_ts && recordedAt(event.first_seen_ts)],
    ['Last recorded', event.event_ts && recordedAt(event.event_ts)],
    ['System', event.description?.system], ['Knowledge article', event.description?.kb_article_id],
  ];
  return facts.filter(([, value]) => present(value)).map(([label, value]): [string, string] => [label, String(value)]);
}
