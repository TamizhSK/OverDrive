import type { Role } from '@servicecare/contracts';

type SessionStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function hasDemoSession(storage: Pick<Storage, 'getItem'> = sessionStorage) {
  const role = storage.getItem('servicecare-role');
  return storage.getItem('servicecare-demo-session') === 'active' && (role === 'customer' || role === 'advisor');
}

export function beginDemoSession(role: Role, storage: SessionStore = sessionStorage) {
  storage.setItem('servicecare-role', role);
  storage.setItem('servicecare-demo-session', 'active');
}

export function endDemoSession(storage: SessionStore = sessionStorage) {
  storage.removeItem('servicecare-demo-session');
  storage.removeItem('servicecare-role');
}

export function passwordRecoveryUrl(domain: string | undefined, clientId: string | undefined, origin: string) {
  if (!domain || !clientId) return undefined;
  try {
    const url = new URL('/forgotPassword', domain);
    const app = new URL(origin);
    const loopback = app.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(app.hostname);
    if (url.protocol !== 'https:' || (app.protocol !== 'https:' && !loopback)) return undefined;
    url.search = new URLSearchParams({ client_id: clientId, response_type: 'code', scope: 'openid email profile', redirect_uri: `${app.origin}/auth/callback` }).toString();
    return url.toString();
  } catch { return undefined; }
}