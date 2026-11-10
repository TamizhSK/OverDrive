import { useEffect, useState } from 'react';
import { ArrowUpRight, RefreshCw, ShieldAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api, date, label } from '../lib/api';
import type { AdvisorInteraction } from '../lib/api';
import { visualApi, visualEnabled, type AdvisorVisualSession } from '../lib/visual';

export function AdvisorActivity() {
  const [interactions, setInteractions] = useState<AdvisorInteraction[]>([]);
  const [interactionCursor, setInteractionCursor] = useState<string>();
  const [interactionLoading, setInteractionLoading] = useState(true);
  const [interactionError, setInteractionError] = useState('');
  const [visualSessions, setVisualSessions] = useState<AdvisorVisualSession[]>([]);
  const [visualCursor, setVisualCursor] = useState<string>();
  const [visualLoading, setVisualLoading] = useState(true);
  const [visualError, setVisualError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setInteractionLoading(true);
    setVisualLoading(true);
    setInteractionError('');
    setVisualError('');
    setInteractions([]);
    setVisualSessions([]);
    void (async () => {
      try {
        const page = await api.advisorInteractions();
        if (active) { setInteractions(page.items); setInteractionCursor(page.nextCursor); }
      } catch (issue) {
        if (active) setInteractionError((issue as Error).message);
      } finally {
        if (active) setInteractionLoading(false);
      }
      if (visualEnabled) {
        try {
          const page = await visualApi.advisorSessions();
          if (active) { setVisualSessions(page.items); setVisualCursor(page.nextCursor); }
        } catch (issue) {
          if (active) setVisualError((issue as Error).message);
        } finally {
          if (active) setVisualLoading(false);
        }
      } else if (active) {
        setVisualLoading(false);
      }
    })();
    return () => { active = false; };
  }, [attempt]);

  async function loadMoreInteractions() {
    if (!interactionCursor) return;
    setInteractionLoading(true);
    setInteractionError('');
    try {
      const page = await api.advisorInteractions(interactionCursor);
      setInteractions(current => [...current, ...page.items.filter(item => !current.some(existing => existing.interactionId === item.interactionId))]);
      setInteractionCursor(page.nextCursor);
    } catch (issue) {
      setInteractionError((issue as Error).message);
    } finally {
      setInteractionLoading(false);
    }
  }

  async function loadMoreVisualSessions() {
    if (!visualCursor) return;
    setVisualLoading(true);
    setVisualError('');
    try {
      const page = await visualApi.advisorSessions(visualCursor);
      setVisualSessions(current => [...current, ...page.items.filter(item => !current.some(existing => existing.sessionId === item.sessionId))]);
      setVisualCursor(page.nextCursor);
    } catch (issue) {
      setVisualError((issue as Error).message);
    } finally {
      setVisualLoading(false);
    }
  }

  return <section className="advisor-activity" aria-label="Customer activity">
    <header className="section-heading">
      <div><span className="section-kicker">LIVE CUSTOMER RECORDS</span><h2>Conversations and photo reviews</h2></div>
      <button className="icon-button" type="button" title="Refresh customer activity" aria-label="Refresh customer activity" disabled={interactionLoading || visualLoading} onClick={() => setAttempt(current => current + 1)}><RefreshCw size={18} /></button>
    </header>
    <section className="ticket-section advisor-activity-section" aria-labelledby="advisor-conversations-title">
      <div className="section-heading"><h3 id="advisor-conversations-title">Assistant conversations <span className="count">{interactions.length}</span></h3></div>
      {interactionError ? <p className="alert error" role="alert">{interactionError}</p> : interactionLoading && !interactions.length ? <output className="empty-state">Loading conversations...</output> : !interactions.length ? <p className="empty-state">No conversations are available.</p> : <ul>{interactions.map(item => <li className="advisor-activity-row" key={item.interactionId}>
        <div><h4>{item.question}</h4>{item.answer && <p>{item.answer}</p>}<time dateTime={item.createdAt}>{date(item.createdAt)}</time></div>
        <span className={`badge ${item.resolved ? 'resolved' : 'open'}`}>{item.resolved ? 'Resolved' : 'Open'}</span>
      </li>)}</ul>}
      {interactionCursor && <button className="button secondary load-more" disabled={interactionLoading} onClick={() => void loadMoreInteractions()}>{interactionLoading ? 'Loading...' : 'Load more conversations'}</button>}
    </section>
    <section className="ticket-section advisor-activity-section" aria-labelledby="advisor-photo-reviews-title">
      <div className="section-heading"><h3 id="advisor-photo-reviews-title">Photo analysis sessions <span className="count">{visualSessions.length}</span></h3></div>
      {visualError ? <p className="alert error" role="alert">{visualError}</p> : visualLoading && !visualSessions.length ? <output className="empty-state">Loading photo reviews...</output> : !visualSessions.length ? <p className="empty-state">{visualEnabled ? 'No photo reviews are available.' : 'Photo reviews are available when the AWS visual-support service is enabled.'}</p> : <ul>{visualSessions.map(item => <li className="advisor-activity-row visual-review-row" key={item.sessionId}>
        <div><div className="advisor-activity-title"><h4>{item.question}</h4><span className="badge">{label(item.phase)}</span>{(item.critical || item.analysis?.safetyConcern) && <span className="badge priority-high"><ShieldAlert size={14} />Safety review</span>}</div>
          {item.analysis ? <><p>{item.analysis.summary}</p>{item.analysis.observations.length > 0 && <ul>{item.analysis.observations.slice(0, 3).map(observation => <li key={observation}>{observation}</li>)}</ul>}<p className="muted">{item.analysis.guidance.answer}</p></> : item.error ? <p>{item.error}</p> : <p className="muted">Analysis is still being processed.</p>}
          {item.ticketId && <Link className="text-link" to={`/ticket/${item.ticketId}`}>Open service request <ArrowUpRight size={16} /></Link>}
        </div>
      </li>)}</ul>}
      {visualCursor && <button className="button secondary load-more" disabled={visualLoading} onClick={() => void loadMoreVisualSessions()}>{visualLoading ? 'Loading...' : 'Load more photo reviews'}</button>}
    </section>
  </section>;
}