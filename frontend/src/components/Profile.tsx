import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowRight, Check, LogOut, Mail, RefreshCw, ShieldCheck, UserRound } from 'lucide-react';
import type { Role, Ticket } from '@servicecare/contracts';
import { demoMode, userManager } from '../lib/auth';
import { vehicleFixtures, type VehicleFixture } from '../lib/wireframe';
import { supportImages, ticketCounts } from '../lib/support';
import { getCustomerDashboard, type CustomerDashboard } from '../lib/api';
import { rememberedDashboard } from '../lib/dashboard-memory';
import { CustomerVehicleContent } from './VehicleRecords';

function DemoVehicleContent({ vehicle, onChange }: Readonly<{ vehicle: VehicleFixture; onChange: (value: VehicleFixture) => void }>) {
  const fixture = vehicleFixtures[vehicle];
  return <><label htmlFor="profile-vehicle">Sample vehicle</label><select id="profile-vehicle" value={vehicle} onChange={event => onChange(event.target.value as VehicleFixture)}>{Object.entries(vehicleFixtures).map(([key, item]) => <option value={key} key={key}>{item.model}</option>)}</select><dl><dt>Model</dt><dd>{fixture.model}</dd><dt>Vehicle reference</dt><dd>...{fixture.vin}</dd><dt>Recorded reading</dt><dd>{fixture.reading ?? 'Not available'}</dd><dt>Recorded at</dt><dd>{fixture.recordedAt ?? 'Not available'}</dd></dl><p className="profile-data-note">Synthetic sample only. Not a verified vehicle session or live vehicle data.</p></>;
}

export function Profile({ role, tickets, onSignOut }: Readonly<{ role: Role; tickets: Ticket[]; onSignOut: () => void }>) {
  const advisor = role === 'advisor';
  const [account, setAccount] = useState<{ name: string; email: string; identifier?: string }>({ name: advisor ? 'Service advisor' : 'Customer', email: 'Not available' });
  const [accountError, setAccountError] = useState('');
  const [dashboard, setDashboard] = useState<CustomerDashboard | undefined>(() => (advisor || demoMode ? undefined : rememberedDashboard()));
  const [dashboardError, setDashboardError] = useState('');
  const [dashboardLoading, setDashboardLoading] = useState(!advisor && !demoMode);
  const [vehicle, setVehicle] = useState<VehicleFixture>('battery');
  const [refreshVersion, setRefreshVersion] = useState(0);
  const location = useLocation();
  const counts = ticketCounts(tickets);
  const accountName = dashboard?.customer.owner_name || account.name;
  const accountEmail = dashboard?.customer.owner_email || account.email;
  const refreshLabel = dashboardError ? 'Retry vehicle data' : 'Refresh vehicle data';
  useEffect(() => {
    if (demoMode) { setAccount({ name: advisor ? 'Demo service advisor' : 'Demo customer', email: 'Synthetic account / no contact address connected' }); return; }
    let active = true;
    userManager?.getUser().then(user => {
      if (!active || !user) return;
      const fallbackName = advisor ? 'Service advisor' : 'Customer';
      setAccount({ name: typeof user.profile.name === 'string' ? user.profile.name : fallbackName, email: typeof user.profile.email === 'string' ? user.profile.email : 'Not available', identifier: typeof user.profile.sub === 'string' ? user.profile.sub : undefined });
    }).catch(() => { if (active) setAccountError('Account details could not be loaded. Please sign in again.'); });
    return () => { active = false; };
  }, [advisor]);
  useEffect(() => {
    if (demoMode || advisor) return;
    let active = true;
    let pending = false;
    async function loadDashboard() {
      if (pending) return;
      pending = true;
      setDashboardLoading(true);
      setDashboardError('');
      try {
        const result = await getCustomerDashboard();
        if (active) setDashboard(result);
      } catch (error_) {
        if (active) setDashboardError((error_ as Error).message);
      } finally {
        pending = false;
        if (active) setDashboardLoading(false);
      }
    }
    function onReturn() {
      if (document.visibilityState === 'visible') void loadDashboard();
    }
    void loadDashboard();
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      active = false;
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [advisor, refreshVersion]);
  useEffect(() => { if (location.hash === '#account-data') document.getElementById('account-data')?.scrollIntoView(); }, [location.hash]);
  return <div className="account-page"><header className="portal-page-title"><span className="section-kicker">YOUR ACCOUNT</span><h1>{advisor ? 'Advisor profile' : 'My profile'}</h1><p>{advisor ? 'Your account and service workspace.' : 'Your account, your BMW, and your service history.'}</p></header>
    <div className="account-layout"><section className="account-details"><div className="account-identity"><span><UserRound size={29} /></span><div><h2>{accountName}</h2><p>{advisor ? 'Service advisor' : 'Customer account'}</p></div></div>{accountError && <p className="alert error" role="alert">{accountError}</p>}<dl><dt><Mail size={16} />Email</dt><dd>{accountEmail}</dd>{!advisor && account.identifier && <><dt>Customer identifier</dt><dd>{account.identifier}</dd></>}{!advisor && dashboard?.customer.owner_phone && <><dt>Phone</dt><dd>{dashboard.customer.owner_phone}</dd></>}{!advisor && dashboard?.customer.preferred_contact && <><dt>Preferred contact</dt><dd>{dashboard.customer.preferred_contact}</dd></>}<dt><ShieldCheck size={16} />Account access</dt><dd>{demoMode ? 'Local demonstration' : 'Cognito authenticated'}</dd><dt><Check size={16} />Role</dt><dd>{advisor ? 'Service advisor' : 'Customer'}</dd></dl><div className="account-request-summary"><div><strong>{counts.open}</strong><span>Open {advisor ? 'queue items' : 'requests'}</span></div><Link to={advisor ? '/advisor' : '/my-tickets'}>View {advisor ? 'service queue' : 'my requests'}<ArrowRight size={16} /></Link></div></section>
      {!advisor && <section className="profile-vehicle">
        <div className="profile-vehicle-hero">
          <img src={supportImages.vehicle} alt="" loading="lazy" decoding="async" onError={event => { event.currentTarget.hidden = true; }} />
          <div className="profile-vehicle-hero-text"><h2>My BMW</h2><p>Vehicle details, diagnostics, and recorded telemetry</p></div>
          {!demoMode && <button type="button" className={`profile-refresh${dashboardLoading ? ' is-loading' : ''}`} title={refreshLabel} aria-label={refreshLabel} disabled={dashboardLoading} onClick={() => setRefreshVersion(current => current + 1)}><RefreshCw size={17} /></button>}
        </div>
        <div className="profile-vehicle-body" aria-busy={dashboardLoading}>{demoMode ? <DemoVehicleContent vehicle={vehicle} onChange={setVehicle} /> : <CustomerVehicleContent dashboard={dashboard} loading={dashboardLoading} error={dashboardError} />}</div>
      </section>}
    </div><section className="account-data-section" id="account-data"><ShieldCheck size={23} /><div><h2>Account & data</h2><p>{demoMode ? 'This environment uses sample accounts and vehicle fixtures. No real contact details are connected. Service requests are kept in memory and reset when the demo API restarts.' : 'Contact and vehicle information is read from the authenticated customer profile. Contact and vehicle changes require the approved account service; they cannot be edited in this portal yet.'}</p><p>Only share information relevant to your service concern. Never include passwords, payment-card details or access codes.</p><button className="button secondary profile-signout" onClick={onSignOut}><LogOut size={16} />Sign out</button></div></section></div>;
}