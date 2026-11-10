import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { test } from 'node:test';
import { ciLogin } from './ci-login.mjs';
import { parseArgs } from './cli.mjs';
import { infra, summarizeChanges } from './infra.mjs';
import { CONFIG, DeployError, Skip, createContext, readStack, runChecks, verifyIdentity, zipFiles } from './lib.mjs';
import { BACKEND_FUNCTIONS, frontendBuildEnvironment, readVisualApiUrl, releaseBackend, sourceCheck } from './release.mjs';
import { assessFunction } from './status.mjs';

const SHA = 'a'.repeat(40);
const NOW = Date.parse('2026-11-03T10:00:00Z');
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const failure = stderr => ({ status: 255, stdout: '', stderr });

// Commands are answered by the first handler whose pattern matches the full command line; anything else fails the test.
function fakeContext(handlers = [], overrides = {}) {
  const calls = [];
  const invocations = [];
  const logs = [];
  const ctx = createContext({
    ci: false,
    env: {},
    now: () => NOW,
    sleep: async () => {},
    log: message => logs.push(message),
    exec: (command, args) => {
      const line = [command, ...args].join(' ');
      calls.push(line);
      invocations.push({ command, args });
      const handler = handlers.find(([pattern]) => pattern.test(line));
      if (!handler) throw new Error(`Unexpected command: ${line}`);
      return typeof handler[1] === 'function' ? handler[1](line, args) : handler[1];
    },
    shell: command => {
      calls.push(command);
      return ok();
    },
    ...overrides,
  });
  return { ctx, calls, invocations, logs };
}

const stackJson = (outputs, status = 'UPDATE_COMPLETE') => JSON.stringify({
  Stacks: [{
    StackStatus: status,
    Outputs: Object.entries(outputs).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })),
    Parameters: [{ ParameterKey: 'WebOrigin', ParameterValue: 'https://web.example' }],
  }],
});

const BACKEND_OUTPUTS = {
  ApiFunctionName: 'servicecare-backend-api',
  TicketEventsFunctionName: 'servicecare-backend-ticket-events',
  TicketActionsFunctionName: 'servicecare-backend-ticket-actions',
  InteractionsTable: 'interactions',
};

const IDENTITY = ok(JSON.stringify({ Account: CONFIG.accountId, Arn: 'arn:aws:sts::123456789012:assumed-role/Developer/me' }));

test('options are parsed and unknown or malformed ones are rejected', () => {
  assert.deepEqual(parseArgs(['backend', '--check']), { command: 'backend', positional: [], flags: { check: true } });
  assert.deepEqual(parseArgs(['infra', 'backend', '--plan-only']).positional, ['backend']);
  assert.equal(parseArgs(['infra', 'backend', '--advisor-email', 'advisor@example.com']).flags['advisor-email'], 'advisor@example.com');
  assert.equal(parseArgs(['infra', 'backend', '--advisor-email=advisor@example.com']).flags['advisor-email'], 'advisor@example.com');
  assert.throws(() => parseArgs(['infra', 'backend', '--advisor-email']), /needs a value/);
  assert.equal(parseArgs(['infra', 'backend', '--customer-email-sender', 'service@example.com']).flags['customer-email-sender'], 'service@example.com');
  assert.throws(() => parseArgs(['backend', '--force']), /Unknown option --force/);
  assert.throws(() => parseArgs(['backend', '--desired-count', '1']), /Unknown option --desired-count/);
});

test('the account and, in the pipeline, the deploy role are enforced', () => {
  const wrongAccount = fakeContext([[/sts get-caller-identity/, ok(JSON.stringify({ Account: '111111111111', Arn: 'arn:aws:sts::111111111111:assumed-role/x/y' }))]]);
  assert.throws(() => verifyIdentity(wrongAccount.ctx, CONFIG.backend), /deploys to 123456789012/);

  const developerCredentials = fakeContext([[/sts get-caller-identity/, IDENTITY]], { ci: true });
  assert.throws(() => verifyIdentity(developerCredentials.ctx, CONFIG.backend), /must run as servicecare-backend-deploy/);

  const deployRole = ok(JSON.stringify({ Account: CONFIG.accountId, Arn: 'arn:aws:sts::123456789012:assumed-role/servicecare-backend-deploy/gha-1-1' }));
  assert.equal(verifyIdentity(fakeContext([[/sts get-caller-identity/, deployRole]], { ci: true }).ctx, CONFIG.backend).Account, CONFIG.accountId);
});

test('a stack that predates the current template points to the infra command', () => {
  const { ctx } = fakeContext([[/cloudformation describe-stacks/, ok(stackJson({ ApiFunctionName: 'servicecare-backend-api' }))]]);
  assert.throws(() => readStack(ctx, CONFIG.backend, ['ApiFunctionName', 'TicketEventsFunctionName']), /no output TicketEventsFunctionName.*npm run deploy:infra -- backend/s);
  const rolledBack = fakeContext([[/cloudformation describe-stacks/, ok(stackJson({}, 'UPDATE_ROLLBACK_COMPLETE'))]]);
  assert.throws(() => readStack(rolledBack.ctx, CONFIG.backend), /UPDATE_ROLLBACK_COMPLETE/);
});

test('checks stop at the first failure unless every result is wanted', () => {
  const sequence = () => [
    { name: 'first', run: () => 'fine' },
    { name: 'second', run: () => { throw new DeployError('broken'); } },
    { name: 'third', run: () => { throw new Skip('needs second'); } },
    { name: 'fourth', run: () => 'fine' },
  ];
  const failFast = fakeContext();
  assert.equal(runChecks(failFast.ctx, sequence()), false);
  assert.match(failFast.logs.join('\n'), /\[FAIL\] second\s+broken[\s\S]*\[skip\] third\s+not reached/);

  const everything = fakeContext();
  assert.equal(runChecks(everything.ctx, sequence(), { all: true }), false);
  assert.match(everything.logs.join('\n'), /\[skip\] third\s+needs second[\s\S]*\[ ok \] fourth/);
});

test('a hand-run release must be the clean, current tip of main', () => {
  const git = (status, head, main) => fakeContext([
    [/git status/, ok(status)],
    [/git fetch/, ok()],
    [/git rev-parse HEAD/, ok(`${head}\n`)],
    [/git rev-parse origin\/main/, ok(`${main}\n`)],
  ]).ctx;
  assert.match(sourceCheck(git('', SHA, SHA)), /is origin\/main/);
  assert.throws(() => sourceCheck(git(' M backend/src/app.ts\n?? notes.txt', SHA, SHA)), /2 uncommitted or untracked file\(s\)[\s\S]*notes\.txt/);
  assert.throws(() => sourceCheck(git('', SHA, 'd'.repeat(40))), /is not origin\/main/);
});

test('the web build gets every sign-in setting the app has used, taken from the hosting stack', () => {
  const environment = frontendBuildEnvironment({
    CognitoAuthority: 'https://cognito-idp.eu-north-1.amazonaws.com/eu-north-1_Example12',
    CognitoDomain: 'https://example.auth.eu-north-1.amazoncognito.com',
    CognitoClientId: 'client',
  });
  assert.deepEqual(environment, {
    VITE_DEMO_MODE: 'false',
    VITE_COGNITO_AUTHORITY: 'https://cognito-idp.eu-north-1.amazonaws.com/eu-north-1_Example12',
    VITE_COGNITO_DOMAIN: 'https://example.auth.eu-north-1.amazoncognito.com',
    VITE_COGNITO_CLIENT_ID: 'client',
    VITE_COGNITO_USER_POOL_ID: 'eu-north-1_Example12',
  });
  assert.equal(frontendBuildEnvironment({
    CognitoAuthority: 'https://cognito-idp.eu-north-1.amazonaws.com/eu-north-1_Example12',
    CognitoDomain: 'https://example.auth.eu-north-1.amazoncognito.com',
    CognitoClientId: 'client',
  }, 'https://visual.example.execute-api.us-east-1.amazonaws.com').VITE_VISUAL_API_URL, 'https://visual.example.execute-api.us-east-1.amazonaws.com');
  assert.equal(frontendBuildEnvironment({
    CognitoAuthority: 'https://cognito-idp.eu-north-1.amazonaws.com/eu-north-1_Example12',
    CognitoDomain: 'https://example.auth.eu-north-1.amazoncognito.com',
    CognitoClientId: 'client',
  }, '', 'https://dashboard.example/customer/dashboard').VITE_CUSTOMER_DASHBOARD_URL, 'https://dashboard.example/customer/dashboard');
});

test('frontend release reads the optional visual API URL and disables photos if its stack is absent', () => {
  const found = fakeContext([[/cloudformation describe-stacks/, ok(JSON.stringify({ Stacks: [{ StackStatus: 'UPDATE_COMPLETE', Outputs: [{ OutputKey: 'VisualApiUrl', OutputValue: 'https://visual.example' }] }] }))]]);
  assert.equal(readVisualApiUrl(found.ctx), 'https://visual.example');
  const missing = fakeContext([[/cloudformation describe-stacks/, failure('Stack with id servicecare-visual-support does not exist')]]);
  assert.equal(readVisualApiUrl(missing.ctx), '');
});

test('change sets are summarised and destructive changes are flagged', () => {
  const { lines, risky } = summarizeChanges([
    { ResourceChange: { Action: 'Add', LogicalResourceId: 'BackupBucket', ResourceType: 'AWS::S3::Bucket', Replacement: undefined } },
    { ResourceChange: { Action: 'Modify', LogicalResourceId: 'InteractionsTable', ResourceType: 'AWS::DynamoDB::Table', Replacement: 'False', Details: [{ Target: { Attribute: 'Properties', Name: 'GlobalSecondaryIndexes' } }] } },
  ]);
  assert.equal(risky, false);
  assert.match(lines[0], /Add\s+BackupBucket/);
  assert.match(lines[1], /Modify\s+InteractionsTable.*\(GlobalSecondaryIndexes\)/);

  const replaced = summarizeChanges([{ ResourceChange: { Action: 'Modify', LogicalResourceId: 'TicketsTable', ResourceType: 'AWS::DynamoDB::Table', Replacement: 'True' } }]);
  assert.equal(replaced.risky, true);
  assert.match(replaced.lines[0], /^ {2}!! Modify {2}TicketsTable.*REPLACES the resource/);
});

  test('analytics stack first-run plan previews and deletes its create change set', async () => {
    const changeSet = 'arn:aws:cloudformation:us-east-1:123456789012:changeSet/servicecare-analytics-create/abc';
    const { ctx, calls, logs } = fakeContext([
      [/sts get-caller-identity/, IDENTITY],
      [/cloudformation describe-stacks/, failure('Stack with id servicecare-analytics does not exist')],
      [/cloudformation validate-template/, ok('{}')],
        [/cloudformation deploy/, ok(`Created change set with name: --change-set-name ${changeSet}\n`) ],
      [/cloudformation describe-change-set/, ok(JSON.stringify({ Changes: [{ ResourceChange: { Action: 'Add', LogicalResourceId: 'AnalyticsBucket', ResourceType: 'AWS::S3::Bucket' } }] }))],
      [/cloudformation delete-change-set/, ok()],
      [/cloudformation delete-stack/, ok()],
      [/cloudformation wait stack-delete-complete/, ok()],
    ]);
    await infra(ctx, 'analytics', { planOnly: true });
    assert.ok(calls.some(call => call.includes('--stack-name servicecare-analytics')));
    assert.ok(calls.some(call => call.includes('cloudformation delete-change-set')));
    assert.ok(calls.some(call => call.includes('cloudformation delete-stack --stack-name servicecare-analytics')));
    assert.ok(calls.some(call => call.includes('cloudformation wait stack-delete-complete')));
    assert.equal(calls.some(call => call.includes('cloudformation execute-change-set')), false);
    assert.match(logs.join('\n'), /Stack servicecare-analytics \(us-east-1\) would change/);
  });

test('a CloudFormation review stack uses the create waiter after change-set execution', async () => {
  const changeSet = 'arn:aws:cloudformation:us-east-1:123456789012:changeSet/servicecare-analytics-create/abc';
  let stackReads = 0;
  const { ctx, calls } = fakeContext([
    [/sts get-caller-identity/, IDENTITY],
    [/cloudformation describe-stacks/, () => ok(stackReads++ === 0 ? stackJson({}, 'REVIEW_IN_PROGRESS') : stackJson({}, 'CREATE_COMPLETE'))],
    [/cloudformation validate-template/, ok('{}')],
    [/cloudformation deploy/, ok(`Created change set with name: --change-set-name ${changeSet}\n`)],
    [/cloudformation describe-change-set/, ok(JSON.stringify({ Changes: [{ ResourceChange: { Action: 'Add', LogicalResourceId: 'AnalyticsBucket', ResourceType: 'AWS::S3::Bucket' } }] }))],
    [/cloudformation execute-change-set/, ok()],
    [/cloudformation wait stack-create-complete/, ok()],
  ]);
  await infra(ctx, 'analytics', { yes: true });
  assert.ok(calls.some(call => call.includes('cloudformation wait stack-create-complete')));
  assert.equal(calls.some(call => call.includes('cloudformation wait stack-update-complete')), false);
});

const claims = { iss: 'https://token.actions.githubusercontent.com', sub: 'repo:your-org/overdrive:ref:refs/heads/main', aud: 'sts.amazonaws.com' };
const OIDC_TOKEN = `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;

test('the pipeline trades its OIDC token for role credentials and masks every secret', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'deploy-test-'));
  try {
    const envFile = join(directory, 'github-env');
    writeFileSync(envFile, '');
    let tokenSeenByCli;
    const { ctx, logs, invocations } = fakeContext([[/sts assume-role-with-web-identity/, (line, args) => {
      tokenSeenByCli = readFileSync(args[args.indexOf('--web-identity-token') + 1].replace('file://', ''), 'utf8');
      return ok(JSON.stringify({ Credentials: { AccessKeyId: 'AKIA', SecretAccessKey: 'secret', SessionToken: 'session', Expiration: '2026-11-03T11:00:00Z' } }));
    }]], {
      env: { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.example/id?api-version=2.0', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token', GITHUB_ENV: envFile, GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '2' },
      http: async (url, init) => {
        assert.equal(url, 'https://token.example/id?api-version=2.0&audience=sts.amazonaws.com');
        assert.equal(init.headers.Authorization, 'Bearer request-token');
        return { ok: true, json: async () => ({ value: OIDC_TOKEN }) };
      },
    });
    await ciLogin(ctx, 'backend');

    const args = invocations[0].args;
    assert.equal(args[args.indexOf('--role-arn') + 1], 'arn:aws:iam::123456789012:role/servicecare-backend-deploy');
    assert.equal(args[args.indexOf('--role-session-name') + 1], 'gha-42-2');
    assert.ok(args.includes('--no-sign-request'));
    assert.equal(args.includes(OIDC_TOKEN), false, 'the token must not be on the command line');
    assert.equal(tokenSeenByCli, OIDC_TOKEN);
    assert.equal(args[args.indexOf('--region') + 1], 'us-east-1');
    assert.ok(logs.includes(`OIDC token: issuer ${claims.iss}, subject ${claims.sub}, audience ${claims.aud}`));
    for (const secret of [OIDC_TOKEN, 'AKIA', 'secret', 'session']) assert.ok(logs.includes(`::add-mask::${secret}`), `${secret} must be masked`);
    assert.equal(logs.some(line => line.includes(OIDC_TOKEN) && !line.startsWith('::add-mask::')), false, 'the token must only appear in a mask command');
    assert.equal(readFileSync(envFile, 'utf8'), 'AWS_ACCESS_KEY_ID=AKIA\nAWS_SECRET_ACCESS_KEY=secret\nAWS_SESSION_TOKEN=session\nAWS_REGION=us-east-1\nAWS_DEFAULT_REGION=us-east-1\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  await assert.rejects(ciLogin(fakeContext().ctx, 'backend'), /id-token: write/);
});

// ---------------------------------------------------------------- whole-release behaviour with a fake AWS

function backendHandlers({ dirty = false, updateStatus = 'Successful' } = {}) {
  return [
    [/sts get-caller-identity/, IDENTITY],
    [/git status/, ok(dirty ? ' M backend/src/app.ts' : '')],
    [/git fetch/, ok()],
    [/git rev-parse/, ok(`${SHA}\n`)],
    [/cloudformation describe-stacks/, ok(stackJson(BACKEND_OUTPUTS))],
    [/lambda update-function-code/, line => ok(JSON.stringify({ CodeSha256: `sha-${line.split(' ')[4]}` }))],
    [/lambda wait function-updated-v2/, ok()],
    [/lambda get-function-configuration/, line => ok(JSON.stringify({ CodeSha256: `sha-${line.split(' ')[4]}`, LastUpdateStatus: updateStatus, LastUpdateStatusReason: 'bad zip' }))],
  ];
}

const healthyApi = async url => (url.endsWith('/api/tickets')
  ? { ok: false, status: 401, json: async () => ({}) }
  : { ok: true, status: 200, json: async () => ({ status: 'ok', mode: 'aws' }) });
const MUTATIONS = /update-function-code/;

// Real build outputs are not needed: each test writes small stand-ins where the bundler would put them.
function withBuildOutputs(task) {
  const created = [];
  for (const { files } of BACKEND_FUNCTIONS) {
    for (const file of files) {
      if (existsSync(file)) continue;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, 'exports.handler = async () => ({});\n');
      created.push(file);
    }
  }
  return Promise.resolve().then(task).finally(() => { for (const file of created) rmSync(file, { force: true }); });
}

test('a check-only run reports readiness and changes nothing', async () => {
  const { ctx, calls, logs } = fakeContext(backendHandlers(), { http: healthyApi });
  await releaseBackend(ctx, { check: true });
  assert.equal(calls.filter(call => MUTATIONS.test(call)).length, 0);
  assert.match(logs.join('\n'), /\[ ok \] Platform stack\s+servicecare-backend is UPDATE_COMPLETE/);
  assert.match(logs.join('\n'), /All checks passed. Nothing was changed./);
});

test('a real release stops before touching anything when a check fails', async () => {
  const { ctx, calls } = fakeContext(backendHandlers({ dirty: true }), { http: healthyApi });
  await assert.rejects(releaseBackend(ctx), /Preflight failed. Nothing was changed./);
  assert.equal(calls.filter(call => MUTATIONS.test(call)).length, 0);
  assert.equal(calls.some(call => call.includes('cloudformation describe-stacks')), false, 'fail fast: later checks do not run');
});

test('a release builds, publishes every backend function, waits for each and smoke tests the API', () => withBuildOutputs(async () => {
  const { ctx, calls, logs } = fakeContext(backendHandlers(), { http: healthyApi });
  await releaseBackend(ctx);
  assert.ok(calls.indexOf('npm run build:ticket-events -w @servicecare/api') < calls.findIndex(call => call.includes('update-function-code')));
  for (const name of ['servicecare-backend-api', 'servicecare-backend-ticket-events', 'servicecare-backend-ticket-actions']) {
    const update = calls.findIndex(call => call.includes(`update-function-code --function-name ${name} `));
    const wait = calls.findIndex(call => call.includes(`function-updated-v2 --function-name ${name}`));
    assert.ok(update !== -1 && wait > update, `${name} is published and awaited`);
  }
  const report = logs.join('\n');
  assert.match(report, /servicecare-backend-ticket-actions runs sha-servicec/);
  assert.match(report, /api\/health answered 200 \(aws\)/);
  assert.match(report, /refuses unauthenticated requests \(401\)/);
}));

test('a function that rejects its new code fails the release', () => withBuildOutputs(async () => {
  const { ctx } = fakeContext(backendHandlers({ updateStatus: 'Failed' }), { http: healthyApi });
  await assert.rejects(releaseBackend(ctx), /servicecare-backend-api did not take the new code \(status Failed: bad zip\)/);
}));

test('Lambda packages are valid deflated zip archives', () => {
  const data = Buffer.from('exports.handler = async () => ({ statusCode: 200 });\n'.repeat(20));
  const archive = zipFiles([{ name: 'index.cjs', data }]);
  assert.equal(archive.readUInt32LE(0), 0x04034b50);
  const nameLength = archive.readUInt16LE(26);
  assert.equal(archive.subarray(30, 30 + nameLength).toString(), 'index.cjs');
  const compressedSize = archive.readUInt32LE(18);
  assert.deepEqual(inflateRawSync(archive.subarray(30 + nameLength, 30 + nameLength + compressedSize)), data);
  const end = archive.length - 22;
  assert.equal(archive.readUInt32LE(end), 0x06054b50);
  assert.equal(archive.readUInt16LE(end + 10), 1);
});

test('status flags missing functions and bootstrap placeholders', () => {
  assert.equal(assessFunction('api', null).ok, false);
  const placeholder = assessFunction('api', { State: 'Active', LastUpdateStatus: 'Successful', CodeSize: 300, CodeSha256: 'x', LastModified: 'now' });
  assert.equal(placeholder.ok, false);
  assert.match(placeholder.text, /bootstrap placeholder/);
  assert.equal(assessFunction('api', { State: 'Active', LastUpdateStatus: 'Successful', CodeSize: 900_000, CodeSha256: 'abcdef1234567890', LastModified: 'now' }).ok, true);
});
