import { User, UserManager, WebStorageStateStore } from 'oidc-client-ts';
import { Amplify } from 'aws-amplify';
import { signIn, confirmSignIn, fetchAuthSession, signOut as cognitoSignOut, resetPassword, confirmResetPassword, confirmSignUp, resendSignUpCode } from 'aws-amplify/auth';
import { cognitoUserPoolsTokenProvider } from 'aws-amplify/auth/cognito';
import { sessionStorage as amplifySessionStorage } from 'aws-amplify/utils';
import type { Role } from '@servicecare/contracts';
import { cognitoRole, demoModeEnabled, signInPhase, type LoginPhase } from './auth-flow';
import { forgetDashboard } from './dashboard-memory';

const authority = import.meta.env.VITE_COGNITO_AUTHORITY;
const clientId = import.meta.env.VITE_COGNITO_CLIENT_ID;
const domain = import.meta.env.VITE_COGNITO_DOMAIN;
export const demoMode = demoModeEnabled(import.meta.env.VITE_DEMO_MODE, import.meta.env.DEV, Boolean(authority && clientId && domain));
const browser = typeof window !== 'undefined';
export const embeddedAuthConfigured = Boolean(browser && !demoMode && authority && clientId && domain);
if (embeddedAuthConfigured) {
  Amplify.configure({ Auth: { Cognito: { userPoolId: authority.split('/').at(-1)!, userPoolClientId: clientId, loginWith: { email: true } } } });
  cognitoUserPoolsTokenProvider.setKeyValueStorage(amplifySessionStorage);
}
export const userManager = browser && !demoMode && authority && clientId && domain ? new UserManager({
  authority, client_id: clientId,
  redirect_uri: `${window.location.origin}/auth/callback`, post_logout_redirect_uri: `${window.location.origin}/login`,
  response_type: 'code', scope: 'openid email profile', automaticSilentRenew: false,
  userStore: new WebStorageStateStore({ store: window.sessionStorage }),
  metadata: {
    issuer: authority, authorization_endpoint: `${domain}/oauth2/authorize`, token_endpoint: `${domain}/oauth2/token`,
    userinfo_endpoint: `${domain}/oauth2/userInfo`, jwks_uri: `${authority}/.well-known/jwks.json`,
  },
}) : undefined;
let callback: Promise<unknown> | undefined;
export function completeSignIn() { callback ??= userManager!.signinRedirectCallback(); return callback; }
export type EmbeddedAuthResult = { phase: LoginPhase | 'SIGNED_IN'; role?: Role };
async function storeEmbeddedSession(): Promise<Role> {
  if (!userManager) throw new Error('Cognito session storage is not configured.');
  const { tokens } = await fetchAuthSession();
  const access = tokens?.accessToken;
  const identity = tokens?.idToken;
  if (!access || !identity || typeof identity.payload.sub !== 'string' || typeof access.payload.exp !== 'number') throw new Error('Cognito did not return a valid session.');
  const role = cognitoRole(access.payload);
  await userManager.storeUser(new User({
    id_token: identity.toString(), access_token: access.toString(), token_type: 'Bearer', scope: 'openid email profile',
    profile: { ...identity.payload, sub: identity.payload.sub, iss: authority!, aud: clientId!, exp: Number(identity.payload.exp), iat: Number(identity.payload.iat) },
    expires_at: access.payload.exp,
  }));
  return role;
}
async function authResult(result: Parameters<typeof signInPhase>[0]): Promise<EmbeddedAuthResult> {
  const phase = signInPhase(result);
  if (phase !== 'SIGNED_IN') return { phase };
  try { return { phase, role: await storeEmbeddedSession() }; }
  catch (error) { await cognitoSignOut(); await userManager?.removeUser(); throw error; }
}
export async function signInOnPage(email: string, password: string): Promise<EmbeddedAuthResult> {
  if (!embeddedAuthConfigured) throw new Error('Cognito is not configured.');
  forgetDashboard();
  await cognitoSignOut();
  await userManager?.removeUser();
  return authResult(await signIn({ username: email.trim(), password, options: { authFlowType: 'USER_SRP_AUTH' } }));
}
export async function confirmSignInOnPage(response: string, email?: string): Promise<EmbeddedAuthResult> {
  return authResult(await confirmSignIn({ challengeResponse: response, ...(email ? { options: { userAttributes: { email } } } : {}) }));
}
export async function requestPasswordReset(email: string) {
  await resetPassword({ username: email.trim() });
}
export async function finishPasswordReset(email: string, code: string, password: string) {
  await confirmResetPassword({ username: email.trim(), confirmationCode: code.trim(), newPassword: password });
}
export async function verifyExistingAccount(email: string, code: string) {
  await confirmSignUp({ username: email.trim(), confirmationCode: code.trim() });
}
export async function resendAccountCode(email: string) {
  await resendSignUpCode({ username: email.trim() });
}
export function getDemoRole(): Role { return sessionStorage.getItem('servicecare-role') === 'advisor' ? 'advisor' : 'customer'; }
export async function authHeaders(): Promise<Record<string, string>> {
  if (demoMode) return { 'X-Demo-Role': getDemoRole() };
  const user = await userManager?.getUser();
  if (!user || user.expired) throw new Error('Your session has expired. Please sign in again.');
  return { Authorization: `Bearer ${user.access_token}` };
}
export async function signOut() {
  forgetDashboard();
  await cognitoSignOut();
  await userManager?.removeUser();
  window.location.assign('/login');
}