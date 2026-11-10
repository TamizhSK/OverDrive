import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, ImagePlus, RefreshCw, Send, ShieldAlert } from 'lucide-react';
import type { Ticket } from '@servicecare/contracts';
import type { VisualSession } from '@servicecare/contracts/visual';
import { visualApi } from '../lib/visual';
import { validateChatImage } from '../lib/images';
import { problemDescription } from '../lib/support';
import { api, agentTicketsEnabled, getCustomerDashboard, type CustomerVehicle } from '../lib/api';
import './visual.css';

export function VisualSupport({ question, initialFiles, onCreated, onClose, onFallback }: Readonly<{
  question: string; initialFiles: File[]; onCreated: (ticket: Ticket) => void; onClose: () => void; onFallback: () => void;
}>) {
  const [session, setSession] = useState<VisualSession>();
  const [files, setFiles] = useState(initialFiles);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [title, setTitle] = useState(question.slice(0, 150));
  const [description, setDescription] = useState(() => problemDescription(question, question));
  const [vehicles, setVehicles] = useState<CustomerVehicle[]>([]);
  const [vin, setVin] = useState('');
  const [requestId] = useState(() => crypto.randomUUID());
  const autoStep = useRef({ unresolved: false, analyze: false });
  const [vehicleLoading, setVehicleLoading] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    let active = true;
    setVehicleLoading(true);
    void getCustomerDashboard().then(dashboard => {
      if (!active) return;
      setVehicles(dashboard.vehicles);
      setVin(dashboard.vehicles.length === 1 ? dashboard.vehicles[0].vehicle.vin : '');
    }).catch(error_ => { if (active) setError(error_.message); }).finally(() => { if (active) setVehicleLoading(false); });
    return () => { active = false; };
  }, [confirming]);
  useEffect(() => {
    let active = true;
    void visualApi.start(question).then(value => { if (active) setSession(value); }).catch(issue => { if (active) setError(issue.message); });
    return () => { active = false; };
  }, [question]);
  useEffect(() => {
    if (!session || !['ANALYSIS_PENDING', 'PROCESSING'].includes(session.phase)) return;
    let active = true;
    let inFlight = false;
    const timer = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void visualApi.get(session.sessionId).then(value => { if (active) setSession(value); }).catch(issue => { if (active) setError(issue.message); }).finally(() => { inFlight = false; });
    }, 2500);
    return () => { active = false; clearInterval(timer); };
  }, [session?.sessionId, session?.phase]);
  async function action(operation: () => Promise<VisualSession>) {
    setBusy(true); setError('');
    try { setSession(await operation()); } catch (issue) { setError((issue as Error).message); } finally { setBusy(false); }
  }
  async function analyze() {
    if (!session) return;
    await action(async () => {
      const keys: string[] = [];
      for (const file of files) keys.push(await visualApi.upload(session.sessionId, file));
      return visualApi.analyze(session.sessionId, keys);
    });
  }
  async function confirm(event: FormEvent) {
    event.preventDefault();
    if (!session) return;
    setBusy(true); setError('');
    try { onCreated(agentTicketsEnabled ? await api.agentCreate({ requestId, title, description, vin, knowledgeBaseAttempted: true, visualSessionId: session.sessionId }) : await visualApi.confirm(session.sessionId, title, description, vin)); }
    catch (issue) { setError((issue as Error).message); }
    finally { setBusy(false); }
  }
  const analysis = session?.analysis;
  const guidance = analysis?.guidance ?? session?.knowledge;
  const autoAnalyzing = initialFiles.length > 0 && !error && !!session && !session.critical && ['KNOWLEDGE_READY', 'UPLOAD_ALLOWED'].includes(session.phase);
  useEffect(() => {
    if (!autoAnalyzing || busy || !session) return;
    if (session.phase === 'KNOWLEDGE_READY' && !autoStep.current.unresolved) { autoStep.current.unresolved = true; void action(() => visualApi.unresolved(session.sessionId)); }
    if (session.phase === 'UPLOAD_ALLOWED' && !autoStep.current.analyze) { autoStep.current.analyze = true; void analyze(); }
  }, [autoAnalyzing, busy, session?.phase]);
  const mayResolve = guidance?.grounded && !session?.critical && !analysis?.safetyConcern;
  return <section className="visual-support" aria-label="Visual service support">
    <h2>Review your concern</h2>
    {error && <p className="alert error" role="alert">{error}</p>}
    {!session && !error && <output>Checking service guidance...</output>}
    {session?.phase === 'RESOLVED' ? <><p>No service request was created.</p><button className="button secondary" onClick={onClose}><Check size={16} />Close concern</button></> : <>
      {guidance && !autoAnalyzing && <><p className="preserve-lines">{guidance.answer}</p>{guidance.citations.length > 0 && <details><summary>Knowledge references</summary><ul>{guidance.citations.map(source => <li key={source.reference}>{source.title}</li>)}</ul></details>}</>}
      {session?.phase === 'KNOWLEDGE_READY' && !autoAnalyzing && <div className="visual-actions">
        {mayResolve && <button className="button secondary" disabled={busy} onClick={() => void action(() => visualApi.resolve(session.sessionId))}><Check size={16} />Resolved</button>}
        {session.critical
          ? <button className="button primary" disabled={busy} onClick={onFallback}><ShieldAlert size={16} />Request immediate advisor review</button>
          : <button className="button primary" disabled={busy} onClick={() => void action(() => visualApi.unresolved(session.sessionId))}><ImagePlus size={16} />Still unresolved: add photos</button>}
      </div>}
      {session?.phase === 'UPLOAD_ALLOWED' && !autoAnalyzing && <>
        <label>Concern photos<input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={busy} onChange={event => {
          const selected = Array.from(event.target.files ?? []);
          const issue = selected.map((file, index) => validateChatImage(file, index)).find(Boolean);
          if (issue) { setError(issue); return; }
          setError(''); setFiles(selected);
        }} /></label>
        <ul>{files.map((file, index) => <li key={`${file.name}-${index}`}>{file.name}</li>)}</ul>
        <button className="button primary" disabled={busy || !files.length} onClick={() => void analyze()}><ImagePlus size={16} />{busy ? 'Uploading photos...' : 'Analyze concern photos'}</button>
      </>}
      {session && ['ANALYSIS_PENDING', 'PROCESSING'].includes(session.phase) && <output><RefreshCw size={16} />Checking photo safety and visible evidence...</output>}
      {analysis && <>
        <h3>Visible evidence</h3><p>{analysis.summary}</p>
        <ul>{analysis.observations.map(item => <li key={item}>{item}</li>)}</ul>
        {analysis.uncertainties.length > 0 && <><h3>Uncertainties</h3><ul>{analysis.uncertainties.map(item => <li key={item}>{item}</li>)}</ul></>}
        {(session?.critical || analysis.safetyConcern) && <p className="alert safety"><ShieldAlert size={18} />An advisor must review this concern. Image analysis is not a diagnosis.</p>}
        <div className="visual-actions">
          {mayResolve && session && <button className="button secondary" disabled={busy} onClick={() => void action(() => visualApi.resolve(session.sessionId))}><Check size={16} />Resolved</button>}
          <button className="button primary" disabled={busy} onClick={() => setConfirming(true)}><Send size={16} />Request advisor review</button>
        </div>
      </>}
      {confirming && <form onSubmit={event => void confirm(event)}>
        <h3>Confirm service request</h3>
        <label>Vehicle<select value={vin} required disabled={busy || vehicleLoading} onChange={event => setVin(event.target.value)}><option value="">{vehicleLoading ? 'Loading your vehicles...' : 'Select your vehicle'}</option>{vehicles.map(({ vehicle }) => <option key={vehicle.vin} value={vehicle.vin}>{vehicle.model ?? 'BMW'} · {vehicle.vin}</option>)}</select></label>
        {!vehicleLoading && !vehicles.length && <p className="alert error" role="alert">No linked vehicle is available. Contact your advisor before submitting.</p>}
        <label>Title<input value={title} minLength={5} maxLength={150} required disabled={busy} onChange={event => setTitle(event.target.value)} /></label>
        <label>Description<textarea value={description} minLength={10} maxLength={5000} required disabled={busy} onChange={event => setDescription(event.target.value)} /></label>
        <p>The verified photos, analysis and knowledge references will accompany the request.</p>
        <div className="visual-actions"><button className="button primary" disabled={busy || vehicleLoading || !vin} type="submit"><Send size={16} />Confirm request</button>
        <button className="button secondary" disabled={busy} type="button" onClick={() => setConfirming(false)}>Cancel</button></div>
      </form>}
      {(error || session?.phase === 'FAILED') && <><p>{session?.error}</p><button className="button secondary" onClick={onFallback}>Continue with a standard request</button></>}
    </>}
  </section>;
}