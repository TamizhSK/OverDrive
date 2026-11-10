import { lazy, Suspense, useEffect, useState } from "react";
import {
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import {
  Plus,
  RefreshCw,
} from "lucide-react";
import type { ResolvedSession, Role, Ticket } from "@servicecare/contracts";
import { api, date } from "./lib/api";
import {
  completeSignIn,
  demoMode,
  getDemoRole,
  signOut,
  userManager,
} from "./lib/auth";
import { TicketList } from "./components/TicketList";
import { Assistant } from "./components/Assistant";
import { CreateTicket } from "./components/CreateTicket";
import { TicketDetails } from "./components/TicketDetails";
import { PortalLayout } from "./components/PortalLayout";
import { Profile } from "./components/Profile";
import { beginDemoSession, endDemoSession, hasDemoSession } from "./lib/session";
import { Login } from "./components/Login";
import { CustomerHome } from "./components/CustomerHome";
import { AdvisorActivity } from "./components/AdvisorActivity";

const QuickSightPanel = lazy(() => import("./components/QuickSightPanel").then(module => ({ default: module.QuickSightPanel })));
import { authError, cognitoRole } from "./lib/auth-flow";

function AdvisorDesk({ tickets, loading, onRefresh, cursor, onMore }: Readonly<{
  tickets: Ticket[]; loading: boolean; onRefresh: () => void; cursor?: string; onMore: () => void;
}>) {
  return <div className="advisor-desk"><header className="advisor-desk-heading"><div><span className="section-kicker">CUSTOMER CARE OPERATIONS</span><h1>Service queue</h1><p>Review concerns. Keep customers informed. Move things forward.</p></div><button className="button secondary" disabled={loading} onClick={onRefresh}><RefreshCw size={17} />Refresh queue</button></header><Suspense fallback={<output className="advisor-analytics-state">Loading analytics panel...</output>}><QuickSightPanel /></Suspense><AdvisorActivity /><TicketList tickets={tickets} loading={loading} advisor refresh={onRefresh} />{cursor && <button className="button secondary load-more" disabled={loading} onClick={onMore}>Load more requests</button>}</div>;
}

function ConversationHistory({ sessions, loading, error, nextCursor, onMore }: Readonly<{ sessions: ResolvedSession[]; loading: boolean; error: string; nextCursor?: string; onMore: () => void }>) {
  let content;
  if (error) content = <p className="alert error" role="alert">{error}</p>;
  else if (loading && !sessions.length) content = <output className="empty-state">Loading conversation history...</output>;
  else if (!sessions.length) content = <div className="empty-state"><p>Your support conversations will appear here.</p></div>;
  else content = <ul>{sessions.map(session => <li key={session.interactionId}><div><h3>{session.question}</h3>{session.answer && <p>{session.answer}</p>}<time dateTime={session.createdAt}>{date(session.createdAt)}</time></div><span className={`badge ${session.resolved ? "resolved" : "open"}`}>{session.resolved ? "Resolved" : "Not resolved"}</span></li>)}</ul>;
  return <section className="ticket-section resolved-session-history"><div className="section-heading"><h2>Assistant conversations <span className="count">{sessions.length}</span></h2></div>{content}{nextCursor && <button className="button secondary load-more" disabled={loading} onClick={onMore}>Load more conversations</button>}</section>;
}

function AuthCallback() {
  const navigate = useNavigate();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!userManager) {
      setError("Cognito is not configured.");
      return;
    }
    void completeSignIn()
      .then(() => {
        window.location.replace("/");
      })
      .catch((issue) => setError(issue.message));
  }, [navigate]);
  return <div className="login-screen">{error || "Completing sign in..."}</div>;
}
export function App() {
  const [role, setRole] = useState<Role>(getDemoRole);
  const [ready, setReady] = useState(demoMode || !userManager);
  const [signedIn, setSignedIn] = useState(() => demoMode && hasDemoSession());
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [resolvedSessions, setResolvedSessions] = useState<ResolvedSession[]>([]);
  const [resolvedCursor, setResolvedCursor] = useState<string>();
  const [resolvedLoading, setResolvedLoading] = useState(false);
  const [resolvedError, setResolvedError] = useState("");
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => { window.scrollTo(0, 0); }, [location.pathname]);
  useEffect(() => {
    if (demoMode) return;
    void userManager
      ?.getUser()
      .then((user) => {
        if (user && !user.expired) {
          const authenticatedRole = cognitoRole(user.profile);
          setSignedIn(true);
          setRole(authenticatedRole);
        }
        setReady(true);
      })
      .catch(() => setReady(true));
    if (!userManager) setReady(true);
  }, []);
  async function refresh(next?: string) {
    if (!signedIn) return;
    setLoading(true);
    setError("");
    try {
      const page = await api.tickets(next);
      setTickets((current) =>
        next
          ? [
              ...current,
              ...page.items.filter(
                (item) =>
                  !current.some(
                    (existing) => existing.ticketId === item.ticketId,
                  ),
              ),
            ]
          : page.items,
      );
      setCursor(page.nextCursor);
    } catch (issue) {
      setError((issue as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (!signedIn) return;
    let active = true;
    setLoading(true);
    setTickets([]);
    setCursor(undefined);
    setError("");
    api
      .tickets()
      .then((page) => {
        if (active) {
          setTickets(page.items);
          setCursor(page.nextCursor);
        }
      })
      .catch((issue) => {
        if (active) setError(issue.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [role, signedIn]);
  useEffect(() => {
    if (!signedIn || role !== "customer" || location.pathname !== "/my-tickets") return;
    let active = true;
    setResolvedLoading(true);
    setResolvedSessions([]);
    setResolvedError("");
    void api.resolvedSessions()
      .then(result => { if (active) { setResolvedSessions(result.items); setResolvedCursor(result.nextCursor); } })
      .catch(issue => { if (active) setResolvedError((issue as Error).message); })
      .finally(() => { if (active) setResolvedLoading(false); });
    return () => { active = false; };
  }, [location.pathname, role, signedIn]);
  async function loadMoreConversations() {
    if (!resolvedCursor) return;
    setResolvedLoading(true);
    setResolvedError("");
    try {
      const page = await api.resolvedSessions(resolvedCursor);
      setResolvedSessions(current => [...current, ...page.items.filter(item => !current.some(existing => existing.interactionId === item.interactionId))]);
      setResolvedCursor(page.nextCursor);
    } catch (issue) {
      setResolvedError((issue as Error).message);
    } finally {
      setResolvedLoading(false);
    }
  }
  function onCreated(ticket: Ticket) {
    setTickets((current) => [ticket, ...current]);
  }
  if (location.pathname === "/auth/callback") return <AuthCallback />;
  if (!ready)
    return (
      <div className="login-screen" role="status">
        Loading Overdrive...
      </div>
    );
  if (!signedIn)
    return (
      <>{location.pathname !== '/login' && <Navigate to="/login" replace />}<Login onDemoSignIn={next => {
        beginDemoSession(next); setRole(next); setSignedIn(true); setError('');
        void navigate(next === 'advisor' ? '/advisor' : '/home', { replace: true });
      }} onSignIn={next => {
        setRole(next); setSignedIn(true); setError('');
        void navigate(next === 'advisor' ? '/advisor' : '/home', { replace: true });
      }} /></>
    );
  const advisor = role === "advisor";
  function logOut() {
    if (!demoMode) { void signOut().catch(error_ => setError(authError(error_))); return; }
    endDemoSession(); setSignedIn(false); setTickets([]); setError('');
    void navigate('/login', { replace: true });
  }
  return (
    <PortalLayout role={role} onSignOut={logOut} tickets={tickets}>
          {error && (
            <div className="alert error" role="alert">
              {error}
              <button className="text-link" onClick={() => void refresh()}>
                Retry
              </button>
            </div>
          )}
          <Routes>
            <Route path="/" element={<Navigate to={advisor ? "/advisor" : "/home"} replace />} />
            <Route path="/login" element={<Navigate to={advisor ? "/advisor" : "/home"} replace />} />
            <Route
              path="/home"
              element={advisor ? <Navigate to="/advisor" replace /> : <CustomerHome tickets={tickets} />}
            />
            <Route
              path="/my-tickets"
              element={
                <>
                  <header className="portal-page-title request-page-heading"><div><span className="section-kicker">YOUR SERVICE HISTORY</span><h1>My requests</h1><p>Updates, replies and next steps from your service team.</p></div><Link className="button primary" to="/create-ticket"><Plus size={17} />Create a request</Link></header>
                  <TicketList
                    tickets={tickets}
                    loading={loading}
                    advisor={advisor}
                    refresh={() => void refresh()}
                  />
                  {!advisor && <ConversationHistory sessions={resolvedSessions} loading={resolvedLoading} error={resolvedError} nextCursor={resolvedCursor} onMore={() => void loadMoreConversations()} />}
                  {cursor && (
                    <button
                      className="button secondary load-more"
                      disabled={loading}
                      onClick={() => void refresh(cursor)}
                    >
                      Load more tickets
                    </button>
                  )}
                </>
              }
            />
            <Route
              path="/advisor"
              element={
                advisor ? (
                  <AdvisorDesk tickets={tickets} loading={loading} onRefresh={() => void refresh()} cursor={cursor} onMore={() => void refresh(cursor)} />
                ) : (
                  <Navigate to="/home" replace />
                )
              }
            />
            <Route
              path="/service-assistant"
              element={
                advisor ? (
                  <Navigate to="/advisor" replace />
                ) : (
                  <Assistant />
                )
              }
            />
            <Route
              path="/create-ticket"
              element={
                advisor ? (
                  <Navigate to="/advisor" replace />
                ) : (
                  <><header className="portal-page-title"><span className="section-kicker">SERVICE FOLLOW-UP</span><h1>Create a service request</h1><p>Your advisor will review the details and respond.</p></header>{((location.state as { files?: File[] } | null)?.files?.length ?? 0) > 0 && <p className="chat-request-attachments">Files selected in chat: {(location.state as { files: File[] }).files.map(file => file.name).join(", ")}</p>}<CreateTicket onCreated={onCreated} /></>
                )
              }
            />
            <Route
              path="/profile"
              element={<Profile role={role} tickets={tickets} onSignOut={logOut} />}
            />
            <Route
              path="/ticket/:ticketId"
              element={
                <TicketDetails role={role} onChanged={() => void refresh()} />
              }
            />
            <Route
              path="*"
              element={
                <div className="empty-state">
                  <h2>Page not found</h2>
                  <Link to="/home" className="text-link">
                    Return to overview
                  </Link>
                </div>
              }
            />
          </Routes>
    </PortalLayout>
  );
}
