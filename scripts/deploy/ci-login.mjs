// Pipeline-only: exchanges the job's OIDC token for the deploy role's short-lived credentials (what aws-actions/configure-aws-credentials does), with no third-party action.
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG, DeployError, aws } from './lib.mjs';

// The claims are not secret, and printing them makes a mismatch with the role's trust policy obvious.
function claimsOf(jwt) {
  try {
    return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

export async function ciLogin(ctx, targetName) {
  const target = ['backend', 'frontend'].includes(targetName) ? CONFIG[targetName] : null;
  if (!target) throw new DeployError('Choose a role: backend or frontend.');
  const { ACTIONS_ID_TOKEN_REQUEST_URL: url, ACTIONS_ID_TOKEN_REQUEST_TOKEN: requestToken, GITHUB_ENV: envFile } = ctx.env;
  if (!url || !requestToken) throw new DeployError('No OIDC token is available. The job needs "permissions: id-token: write".');
  if (!envFile) throw new DeployError('GITHUB_ENV is not set. This command only runs inside a GitHub Actions step.');

  const response = await ctx.http(`${url}${url.includes('?') ? '&' : '?'}audience=sts.amazonaws.com`, {
    headers: { Authorization: `Bearer ${requestToken}`, Accept: 'application/json' },
  });
  if (!response.ok) throw new DeployError(`The OIDC token request failed with HTTP ${response.status}.`);
  const { value: jwt } = await response.json();
  if (!jwt) throw new DeployError('The OIDC token response did not contain a token.');
  ctx.log(`::add-mask::${jwt}`);
  const { iss, sub, aud } = claimsOf(jwt);
  ctx.log(`OIDC token: issuer ${iss}, subject ${sub}, audience ${aud}`);

  const roleArn = `arn:aws:iam::${CONFIG.accountId}:role/${target.stack}-deploy`;
  const sessionName = `gha-${ctx.env.GITHUB_RUN_ID ?? 'manual'}-${ctx.env.GITHUB_RUN_ATTEMPT ?? '1'}`;
  // The token goes through a file, not the command line, so it never shows up in a process listing.
  const directory = mkdtempSync(join(tmpdir(), 'servicecare-oidc-'));
  let credentials;
  try {
    const tokenFile = join(directory, 'token');
    writeFileSync(tokenFile, jwt, { mode: 0o600 });
    ({ Credentials: credentials } = aws(ctx, [
      'sts', 'assume-role-with-web-identity', '--role-arn', roleArn, '--role-session-name', sessionName,
      '--web-identity-token', `file://${tokenFile}`, '--duration-seconds', '3600', '--no-sign-request',
    ], { region: target.region }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  for (const secret of [credentials.AccessKeyId, credentials.SecretAccessKey, credentials.SessionToken]) ctx.log(`::add-mask::${secret}`);
  appendFileSync(envFile, [
    `AWS_ACCESS_KEY_ID=${credentials.AccessKeyId}`,
    `AWS_SECRET_ACCESS_KEY=${credentials.SecretAccessKey}`,
    `AWS_SESSION_TOKEN=${credentials.SessionToken}`,
    `AWS_REGION=${target.region}`,
    `AWS_DEFAULT_REGION=${target.region}`,
    '',
  ].join('\n'));
  ctx.log(`Assumed ${roleArn} in ${target.region} until ${credentials.Expiration}.`);
}
