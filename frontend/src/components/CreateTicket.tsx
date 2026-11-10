import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { ArrowRight, FilePlus2, Paperclip, ShieldCheck, X } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { Attachment, Ticket } from '@servicecare/contracts';
import { api, agentTicketsEnabled, getCustomerDashboard, type CustomerVehicle } from '../lib/api';
import { demoMode } from '../lib/auth';

export function CreateTicket({ onCreated }: Readonly<{ onCreated: (ticket: Ticket) => void }>) {
  const location = useLocation();
  const initialRequest = location.state as { initialTitle?: string; initialDescription?: string; knowledgeBaseAttempted?: boolean; files?: File[] } | null;
  const [title, setTitle] = useState(initialRequest?.initialTitle ?? '');
  const [requestId] = useState(() => crypto.randomUUID());
  const [description, setDescription] = useState(initialRequest?.initialDescription ?? '');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [vehicles, setVehicles] = useState<CustomerVehicle[]>([]);
  const [selectedVin, setSelectedVin] = useState('');
  const [vehicleLoading, setVehicleLoading] = useState(!demoMode);
  const [vehicleError, setVehicleError] = useState('');
  const [pendingFiles] = useState<File[]>(initialRequest?.files ?? []);
  const uploadedFiles = useRef(new Map<File, Attachment>());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  useEffect(() => {
    if (demoMode) return;
    let active = true;
    void getCustomerDashboard()
      .then(dashboard => {
        if (!active) return;
        setVehicles(dashboard.vehicles);
        setSelectedVin(dashboard.vehicles[0]?.vehicle.vin ?? '');
      })
      .catch(issue => { if (active) setVehicleError((issue as Error).message); })
      .finally(() => { if (active) setVehicleLoading(false); });
    return () => { active = false; };
  }, []);
  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    try { const uploaded = await Promise.all(pendingFiles.map(async file => { const cached = uploadedFiles.current.get(file); if (cached) return cached; const result = await api.upload(file); uploadedFiles.current.set(file, result); return result; })); const input = { requestId, title, description, ...(demoMode ? {} : { vin: selectedVin }), attachments: [...attachments, ...uploaded], knowledgeBaseAttempted: initialRequest?.knowledgeBaseAttempted }; const ticket = agentTicketsEnabled && !demoMode && !input.attachments.length ? await api.agentCreate(input) : await api.create(input); onCreated(ticket); await navigate(`/ticket/${ticket.ticketId}`); }
    catch (error_) { setError((error_ as Error).message); } finally { setBusy(false); }
  }
  async function upload(file?: File) {
    if (!file) return;
    setBusy(true); setError('');
    try { const attachment = await api.upload(file); setAttachments(current => [...current, attachment]); }
    catch (error_) { setError((error_ as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="form-layout">
      <form className="ticket-form" onSubmit={submit}>
        <div className="form-section-title"><FilePlus2 size={21} /><h2>Tell us what happened</h2></div>
        {!demoMode && <>
          <label htmlFor="ticket-vehicle">Vehicle</label>
          {vehicleLoading ? <output className="empty-state">Loading your vehicles...</output> : vehicleError ? <p className="alert error" role="alert">{vehicleError}</p> : vehicles.length ? <select id="ticket-vehicle" required value={selectedVin} onChange={event => setSelectedVin(event.target.value)}>{vehicles.map(({ vehicle }) => <option value={vehicle.vin} key={vehicle.vin}>{vehicle.model ?? 'BMW'}{vehicle.model_year ? ` (${vehicle.model_year})` : ''} · {vehicle.vin}</option>)}</select> : <p className="alert error" role="alert">No vehicles are linked to your account. Contact your advisor before submitting a ticket.</p>}
        </>}
        <label htmlFor="title">Issue title</label>
        <input id="title" placeholder="e.g. Air conditioning is not cooling" required minLength={5} maxLength={150} value={title} onChange={event => setTitle(event.target.value)} />
        <label htmlFor="description">Description</label>
        <textarea id="description" placeholder="When did it start? What are you experiencing?" rows={7} required minLength={10} maxLength={5000} value={description} onChange={event => setDescription(event.target.value)} />
        <div className="field-heading"><label htmlFor="attachment">Supporting evidence</label><span className="muted">Optional</span></div>
        <label className={`upload-zone ${demoMode ? 'disabled' : ''}`} htmlFor="attachment">
          <Paperclip size={22} /><strong>{demoMode ? 'Attachments available after AWS setup' : 'Attach an image or document'}</strong><span>JPEG, PNG, WebP or PDF. Up to 10 MB each.</span>
          <input id="attachment" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" disabled={demoMode || busy || attachments.length >= 5} onChange={event => { void upload(event.target.files?.[0]); event.target.value = ''; }} />
        </label>
        {attachments.map((attachment, index) => <div className="attachment-item" key={attachment.key}><Paperclip size={16} /><span>{attachment.name}</span><button type="button" className="icon-button" title="Remove attachment" onClick={() => setAttachments(current => current.filter((_, position) => position !== index))}><X size={16} /></button></div>)}
        {error && <p className="alert error" role="alert">{error}</p>}
        <div className="form-footer"><button type="button" className="button secondary" onClick={() => navigate('/my-tickets')}>Cancel</button><button className="button primary" disabled={busy || (!demoMode && (vehicleLoading || !!vehicleError || !selectedVin))}>{busy ? 'Saving...' : 'Submit ticket'}<ArrowRight size={17} /></button></div>
      </form>
      <aside className="side-note"><ShieldCheck size={23} /><h3>In the right hands.</h3><p>Your request is categorized and prioritized before it reaches a service advisor.</p><p>You can follow progress and reply to your advisor in My requests.</p><p>A request is not a confirmed appointment or a roadside dispatch. If there is immediate danger, contact emergency services or official roadside assistance.</p></aside>
    </div>
  );
}