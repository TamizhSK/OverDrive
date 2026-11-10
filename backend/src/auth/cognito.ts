import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { TokenVerifier } from '../app.ts';

/** Verifies Cognito access tokens (signature, expiry, issuer, token_use and app client) against the pool's published keys. */
export function cognitoVerifier(env: Record<string, string | undefined> = process.env): TokenVerifier {
  const userPoolId = env.COGNITO_USER_POOL_ID?.trim();
  const clientIds = (env.COGNITO_CLIENT_IDS ?? '').split(',').map(id => id.trim()).filter(Boolean);
  if (!userPoolId || clientIds.length === 0) throw new Error('COGNITO_USER_POOL_ID and COGNITO_CLIENT_IDS are required.');
  const verifier = CognitoJwtVerifier.create({ userPoolId, tokenUse: 'access', clientId: clientIds });
  return async token => ({ ...(await verifier.verify(token)) });
}
