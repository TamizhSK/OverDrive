// Backend and frontend releases. The pipeline and a developer releasing by hand run exactly the same code.
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  CONFIG, DeployError, aws, awsRun, awsTry, readStack, runChecks, verifyIdentity, zipFiles,
} from './lib.mjs';

// Each backend function and the build output it runs. The handler names are set in backend-lambda-platform.yml.
export const BACKEND_FUNCTIONS = Object.freeze([
  Object.freeze({ output: 'ApiFunctionName', files: ['backend/dist/index.cjs'] }),
  Object.freeze({ output: 'TicketEventsFunctionName', files: ['backend/dist/ticket-events/stream.cjs'] }),
  Object.freeze({ output: 'TicketActionsFunctionName', files: ['backend/dist/ticket-events/worker.cjs'] }),
]);
const BACKEND_OUTPUTS = BACKEND_FUNCTIONS.map(fn => fn.output);
const BACKEND_BUILDS = ['npm run build:lambda -w @servicecare/api', 'npm run build:ticket-events -w @servicecare/api'];
const FRONTEND_OUTPUTS = ['BucketName', 'DistributionId', 'WebUrl', 'CognitoAuthority', 'CognitoDomain', 'CognitoClientId'];

const BACKEND_TESTS = ['npm run typecheck -w @servicecare/api', 'npm run test:backend', 'npm run test:scripts'];
const FRONTEND_TESTS = ['npm run typecheck -w @servicecare/web', 'npm run test:frontend', 'npm run test:scripts'];

export const currentCommit = ctx => ctx.exec('git', ['rev-parse', 'HEAD']).stdout.trim();

// A release started by hand must be exactly what is on origin/main, so what runs can always be traced to a merged commit.
export function sourceCheck(ctx) {
  const dirty = ctx.exec('git', ['status', '--porcelain']).stdout.trimEnd();
  if (dirty) {
    const files = dirty.split(/\r?\n/);
    const listed = files.slice(0, 5).join('\n') + (files.length > 5 ? '\n...' : '');
    throw new DeployError(`${files.length} uncommitted or untracked file(s); commit, stash or remove them first:\n${listed}`);
  }
  ctx.exec('git', ['fetch', '--quiet', 'origin', CONFIG.mainBranch]);
  const head = currentCommit(ctx);
  const main = ctx.exec('git', ['rev-parse', `origin/${CONFIG.mainBranch}`]).stdout.trim();
  if (head !== main) {
    throw new DeployError(`HEAD ${head.slice(0, 7)} is not origin/${CONFIG.mainBranch} (${main.slice(0, 7)}). Release only what is merged: git pull, or merge your branch first.`);
  }
  return `${head.slice(0, 7)} is origin/${CONFIG.mainBranch}`;
}

function verifyCode(ctx, commands) {
  for (const command of commands) {
    ctx.log(`      $ ${command}`);
    if (ctx.shell(command, { allowFailure: true }).status !== 0) throw new DeployError(`"${command}" failed.`);
  }
  return `${commands.length} commands passed`;
}

function summarize(ctx, lines) {
  for (const line of lines) ctx.log(line);
  if (ctx.env.GITHUB_STEP_SUMMARY) appendFileSync(ctx.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}

// ---------------------------------------------------------------- backend

// Zips each function's bundle (as its handler file name) and publishes it, waiting until Lambda reports the update finished.
function publishFunctions(ctx, target, outputs) {
  const directory = mkdtempSync(join(tmpdir(), 'servicecare-lambda-'));
  const published = [];
  try {
    for (const { output, files } of BACKEND_FUNCTIONS) {
      const name = outputs[output];
      for (const file of files) if (!existsSync(file)) throw new DeployError(`The build did not produce ${file}.`);
      const archive = join(directory, `${name}.zip`);
      writeFileSync(archive, zipFiles(files.map(file => ({ name: basename(file), data: readFileSync(file) }))));
      const update = aws(ctx, ['lambda', 'update-function-code', '--function-name', name, '--zip-file', `fileb://${archive}`], { region: target.region });
      awsRun(ctx, ['lambda', 'wait', 'function-updated-v2', '--function-name', name], { region: target.region });
      const current = aws(ctx, ['lambda', 'get-function-configuration', '--function-name', name], { region: target.region });
      if (current.LastUpdateStatus !== 'Successful' || current.CodeSha256 !== update.CodeSha256) {
        throw new DeployError(`${name} did not take the new code (status ${current.LastUpdateStatus}: ${current.LastUpdateStatusReason ?? 'no reason given'}).`);
      }
      published.push(`${name} runs ${current.CodeSha256.slice(0, 12)}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  return published;
}

export async function checkHealth(ctx, origin) {
  const url = `${origin}/api/health`;
  let last = 'no response';
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const response = await ctx.http(url);
      const body = response.ok ? await response.json() : null;
      if (body?.status === 'ok') return `${url} answered 200 (${body.mode})`;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error.message;
    }
    await ctx.sleep(5000);
  }
  throw new DeployError(`${url} did not report healthy: ${last}`);
}

// The API must refuse a request without a token; anything else means the JWT authorizer is not in front of it.
export async function checkProtected(ctx, origin) {
  const url = `${origin}/api/tickets`;
  const response = await ctx.http(url);
  if (response.status !== 401) throw new DeployError(`${url} answered ${response.status} without a token; expected 401.`);
  return `${url} refuses unauthenticated requests (401)`;
}

export async function releaseBackend(ctx, { check = false } = {}) {
  const target = CONFIG.backend;
  const state = {};
  const checks = [
    { name: 'AWS identity', critical: true, run: () => { state.identity = verifyIdentity(ctx, target); return state.identity.Arn; } },
    ...(ctx.ci ? [] : [{ name: 'Source', run: () => sourceCheck(ctx) }]),
    { name: 'Platform stack', run: () => { state.stack = readStack(ctx, target, BACKEND_OUTPUTS); return `${target.stack} is ${state.stack.status}`; } },
    ...(ctx.ci ? [] : [{ name: 'Tests', run: () => verifyCode(ctx, BACKEND_TESTS) }]),
  ];

  ctx.log(`Backend release${check ? ' (check only)' : ''}`);
  if (!runChecks(ctx, checks, { all: check })) {
    throw new DeployError(check ? 'Not ready to release; see the failed checks above.' : 'Preflight failed. Nothing was changed.');
  }
  if (check) {
    ctx.log('All checks passed. Nothing was changed.');
    return;
  }

  const { outputs, parameters } = state.stack;
  ctx.log('Building the Lambda bundles');
  for (const command of BACKEND_BUILDS) ctx.shell(command);
  const lines = publishFunctions(ctx, target, outputs);
  if (parameters.WebOrigin) lines.push(await checkHealth(ctx, parameters.WebOrigin), await checkProtected(ctx, parameters.WebOrigin));
  summarize(ctx, lines);
}

// ---------------------------------------------------------------- frontend

function publishSite(ctx, target, bucket) {
  awsRun(ctx, ['s3', 'sync', 'frontend/dist/assets', `s3://${bucket}/assets`, '--cache-control', 'public,max-age=31536000,immutable', '--only-show-errors'], { region: target.region });
  awsRun(ctx, ['s3', 'sync', 'frontend/dist', `s3://${bucket}/`, '--exclude', 'assets/*', '--exclude', 'index.html', '--cache-control', 'public,max-age=3600', '--only-show-errors'], { region: target.region });
  // index.html goes last, so visitors never get a page that points at assets which are not uploaded yet.
  awsRun(ctx, ['s3', 'cp', 'frontend/dist/index.html', `s3://${bucket}/index.html`, '--cache-control', 'no-cache', '--content-type', 'text/html; charset=utf-8', '--only-show-errors'], { region: target.region });
}

function invalidateCache(ctx, target, distribution) {
  const { Invalidation: invalidation } = aws(ctx, ['cloudfront', 'create-invalidation', '--distribution-id', distribution, '--paths', '/*'], { region: target.region });
  ctx.log('Waiting for the CloudFront invalidation...');
  awsRun(ctx, ['cloudfront', 'wait', 'invalidation-completed', '--distribution-id', distribution, '--id', invalidation.Id], { region: target.region });
}

export async function smokeTestSite(ctx, url) {
  const root = await ctx.http(`${url}/`);
  if (!root.ok || !(await root.text()).includes('<div id="root">')) throw new DeployError(`${url}/ did not return the app shell.`);
  const deepLink = await ctx.http(`${url}/my-tickets`);
  if (deepLink.status !== 200) throw new DeployError(`${url}/my-tickets returned ${deepLink.status}; client-side routing is not working.`);
}

// Settings baked into the web build. The hosted-UI variables and the pool id are both set because the sign-in code has used each.
export function frontendBuildEnvironment(outputs, visualApiUrl = '', customerDashboardUrl = '') {
  return {
    VITE_DEMO_MODE: 'false',
    VITE_COGNITO_AUTHORITY: outputs.CognitoAuthority,
    VITE_COGNITO_DOMAIN: outputs.CognitoDomain,
    VITE_COGNITO_CLIENT_ID: outputs.CognitoClientId,
    VITE_COGNITO_USER_POOL_ID: outputs.CognitoAuthority.split('/').pop(),
    ...(visualApiUrl ? { VITE_VISUAL_API_URL: visualApiUrl } : {}),
    ...(customerDashboardUrl ? { VITE_CUSTOMER_DASHBOARD_URL: customerDashboardUrl } : {}),
  };
}

export function readVisualApiUrl(ctx) {
  const result = awsTry(ctx, ['cloudformation', 'describe-stacks', '--stack-name', 'servicecare-visual-support'], { region: 'us-east-1' });
  if (!result.ok) {
    if (/does not exist|not exist/i.test(result.error)) return '';
    throw new DeployError(`Could not read the optional visual-support stack: ${result.error}`);
  }
  const stack = result.data?.Stacks?.[0];
  if (!stack) return '';
  if (!['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(stack.StackStatus)) {
    throw new DeployError(`Visual-support stack is ${stack.StackStatus}; wait for it to finish before publishing the frontend.`);
  }
  return stack.Outputs?.find(output => output.OutputKey === 'VisualApiUrl')?.OutputValue ?? '';
}

export async function releaseFrontend(ctx, { check = false } = {}) {
  const target = CONFIG.frontend;
  const state = {};
  const checks = [
    { name: 'AWS identity', critical: true, run: () => { state.identity = verifyIdentity(ctx, target); return state.identity.Arn; } },
    ...(ctx.ci ? [] : [{ name: 'Source', run: () => sourceCheck(ctx) }]),
    { name: 'Hosting stack', run: () => { state.stack = readStack(ctx, target, FRONTEND_OUTPUTS); return `${target.stack} is ${state.stack.status}`; } },
    { name: 'Visual API', run: () => { state.visualApiUrl = readVisualApiUrl(ctx); return state.visualApiUrl || 'not configured; photo support stays disabled'; } },
    ...(ctx.ci ? [] : [{ name: 'Tests', run: () => verifyCode(ctx, FRONTEND_TESTS) }]),
  ];

  ctx.log(`Frontend release${check ? ' (check only)' : ''}`);
  if (!runChecks(ctx, checks, { all: check })) {
    throw new DeployError(check ? 'Not ready to release; see the failed checks above.' : 'Preflight failed. Nothing was changed.');
  }
  if (check) {
    ctx.log('All checks passed. Nothing was changed.');
    return;
  }

  const { outputs } = state.stack;
  ctx.log('Building the web app');
  ctx.shell('npm run build -w @servicecare/web', { env: frontendBuildEnvironment(outputs, state.visualApiUrl, process.env.CUSTOMER_DASHBOARD_URL ?? '') });
  if (!existsSync('frontend/dist/index.html')) throw new DeployError('The build did not produce frontend/dist/index.html.');
  ctx.log(`Publishing to s3://${outputs.BucketName}`);
  publishSite(ctx, target, outputs.BucketName);
  invalidateCache(ctx, target, outputs.DistributionId);
  await smokeTestSite(ctx, outputs.WebUrl);
  summarize(ctx, [`Deployed ${outputs.WebUrl}; the app shell and a deep link both answered 200.`]);
}
