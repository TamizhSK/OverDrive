import { ArrowUpRight, Inbox, RefreshCw, Search } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useState } from 'react';
import type { Ticket } from '@servicecare/contracts';
import { statuses } from '@servicecare/contracts';
import { date, label, shortId } from '../lib/api';

export function TicketList({ tickets, loading, advisor, refresh, compact = false }: { tickets: Ticket[]; loading: boolean; advisor: boolean; refresh: () => void; compact?: boolean }) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState('');
  const [category, setCategory] = useState('');
  const visible = tickets.filter(ticket => `${ticket.title} ${ticket.ticketId} ${shortId(ticket.ticketId)}`.toLowerCase().includes(search.toLowerCase()) && (!status || ticket.status === status) && (!priority || ticket.priority === priority) && (!category || ticket.category === category));
  return <section className="ticket-section">
    <div className="section-heading"><h2>{compact ? 'Recent tickets' : advisor ? 'Service queue' : 'My tickets'} <span className="count">{tickets.length}</span></h2>{compact ? <Link className="text-link" to="/my-tickets">View all <ArrowUpRight size={16} /></Link> : <button className="icon-button" title="Refresh tickets" aria-label="Refresh tickets" onClick={refresh} disabled={loading}><RefreshCw size={18} className={loading ? 'spin' : ''} /></button>}</div>
    {!compact && <div className="filters"><label className="search-field"><Search size={17} /><input aria-label="Search tickets" placeholder="Search tickets" value={search} onChange={event => setSearch(event.target.value)} /></label><select aria-label="Filter by status" value={status} onChange={event => setStatus(event.target.value)}><option value="">All statuses</option>{statuses.map(value => <option key={value} value={value}>{label(value)}</option>)}</select>{advisor && <><select aria-label="Filter by priority" value={priority} onChange={event => setPriority(event.target.value)}><option value="">All priorities</option>{['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map(value => <option key={value}>{value}</option>)}</select><select aria-label="Filter by category" value={category} onChange={event => setCategory(event.target.value)}><option value="">All categories</option>{[...new Set(tickets.map(ticket => ticket.category))].map(value => <option key={value} value={value}>{label(value)}</option>)}</select></>}</div>}
    <div className="ticket-table-heading"><span>Ticket / Issue</span><span>Category</span><span>Status</span><span>Updated</span><span /></div>
    {loading && !tickets.length ? <div className="empty-state" role="status">Loading tickets...</div> : !visible.length ? <div className="empty-state"><Inbox size={28} /><h3>{search || status || priority || category ? 'No matching tickets' : 'No tickets yet'}</h3><p>{advisor ? 'New customer requests will appear here.' : 'Your service requests will appear here.'}</p>{!advisor && <Link className="text-link" to="/create-ticket">Create a ticket <ArrowUpRight size={16} /></Link>}</div> : (compact ? visible.slice(0, 3) : visible).map(ticket => <Link className="ticket-row" to={`/ticket/${ticket.ticketId}`} key={ticket.ticketId}><div className="ticket-identity"><div className="ticket-meta"><span>{shortId(ticket.ticketId)}</span><span className={`priority-dot ${ticket.priority.toLowerCase()}`} />{label(ticket.priority)}</div><h3>{ticket.title}</h3></div><span className="ticket-category">{label(ticket.category)}</span><span className={`badge ${ticket.status.toLowerCase()}`}>{label(ticket.status)}</span><span className="ticket-date">{date(ticket.updatedAt)}</span><ArrowUpRight className="row-arrow" size={18} /></Link>)}
  </section>;
}