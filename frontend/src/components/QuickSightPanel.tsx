import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api, label, type TicketOverview } from "../lib/api";
import { statuses, type Ticket } from "@servicecare/contracts";
import { demoMode } from "../lib/auth";

export function QuickSightPanel() {
  return demoMode ? <DemoAnalyticsPreview /> : <QuickSightEmbed />;
}

function DemoAnalyticsPreview() {
  const [overview, setOverview] = useState<TicketOverview>();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void Promise.all([api.advisorOverview(), api.tickets()])
      .then(([metrics, page]) => {
        if (active) { setOverview(metrics); setTickets(page.items); }
      })
      .catch(issue => { if (active) setError((issue as Error).message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [attempt]);

  const statusCounts = statuses.map(status => ({
    status,
    count: tickets.filter(ticket => ticket.status === status).length,
  })).filter(item => item.count > 0);
  const highestCount = Math.max(1, ...statusCounts.map(item => item.count));

  return <section className="advisor-analytics" aria-labelledby="advisor-analytics-title">
    <header className="advisor-analytics-heading">
      <div>
        <span className="section-kicker">LOCAL DEMO DATA</span>
        <h2 id="advisor-analytics-title">Service analytics preview</h2>
        <p>Seeded records from the local API. AWS QuickSight is not connected in demo mode.</p>
      </div>
      <button className="icon-button" type="button" aria-label="Refresh demo analytics" title="Refresh demo analytics" disabled={loading} onClick={() => setAttempt(current => current + 1)}><RefreshCw size={18} /></button>
    </header>
    {loading && <output className="advisor-analytics-state">Loading local metrics...</output>}
    {!loading && error && <p className="alert error" role="alert">{error}</p>}
    {!loading && !error && overview && <>
      <div className="demo-analytics-metrics">{[
        { label: 'Open requests', value: overview.open },
        { label: 'Unassigned', value: overview.unassigned },
        { label: 'High priority', value: overview.urgent },
        { label: 'Waiting for customer', value: overview.waiting },
      ].map(item => <div key={item.label}><span>{item.label}</span><strong>{item.value.toString().padStart(2, '0')}</strong></div>)}</div>
      <div className="demo-analytics-status" aria-label="Ticket status breakdown">
        <h3>Requests by status</h3>
        {statusCounts.length ? statusCounts.map(item => <div className="demo-analytics-status-row" key={item.status}>
          <span>{label(item.status)}</span><div><i style={{ width: `${item.count / highestCount * 100}%` }} /></div><strong>{item.count}</strong>
        </div>) : <p>No local tickets yet.</p>}
      </div>
    </>}
  </section>;
}

function QuickSightEmbed() {
  const [embedUrl, setEmbedUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setEmbedUrl("");
    void api.advisorDashboardEmbed()
      .then(result => { if (active) setEmbedUrl(result.embedUrl); })
      .catch(issue => { if (active) setError((issue as Error).message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [attempt]);

  return (
    <section className="advisor-analytics" aria-labelledby="advisor-analytics-title">
      <header className="advisor-analytics-heading">
        <div>
          <span className="section-kicker">HISTORICAL PERFORMANCE</span>
          <h2 id="advisor-analytics-title">Service analytics</h2>
          <p>Advisor-only aggregate metrics from the analytics lake.</p>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="Refresh analytics dashboard"
          title="Refresh analytics dashboard"
          disabled={loading}
          onClick={() => setAttempt(current => current + 1)}
        >
          <RefreshCw size={18} />
        </button>
      </header>
      {loading && <output className="advisor-analytics-state">Connecting to analytics...</output>}
      {!loading && error && (
        <div className="advisor-analytics-state" role="alert">
          <div>
            <p>{error}</p>
            <button className="button secondary" type="button" onClick={() => setAttempt(current => current + 1)}>
              <RefreshCw size={16} />Retry
            </button>
          </div>
        </div>
      )}
      {!loading && embedUrl && (
        <iframe
          className="advisor-analytics-frame"
          title="ServiceCare advisor analytics dashboard"
          src={embedUrl}
          referrerPolicy="no-referrer"
          allowFullScreen
          loading="lazy"
        />
      )}
    </section>
  );
}
