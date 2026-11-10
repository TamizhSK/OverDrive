// Building blocks for the release tooling: configuration, process execution, AWS CLI access, preflight checks and Lambda packaging.
import { spawnSync } from 'node:child_process';
import { deflateRawSync } from 'node:zlib';
import { createInterface } from 'node:readline/promises';

export const CONFIG = Object.freeze({
  // Set AWS_ACCOUNT_ID to your account; the fallback is AWS's documentation example ID.
  accountId: process.env.AWS_ACCOUNT_ID || '123456789012',
  mainBranch: 'main',
  backend: Object.freeze({ name: 'backend', region: 'us-east-1', stack: 'servicecare-backend', template: 'infra/cloudformation/backend-lambda-platform.yml' }),
  frontend: Object.freeze({ name: 'frontend', region: 'eu-north-1', stack: 'servicecare-frontend', template: 'infra/cloudformation/frontend-hosting.yml' }),
  state: Object.freeze({ name: 'state', region: 'eu-north-1', stack: 'servicecare-terraform-state', template: 'infra/cloudformation/terraform-state.yml' }),
  analytics: Object.freeze({ name: 'analytics', region: 'us-east-1', stack: 'servicecare-analytics', template: 'infra/cloudformation/analytics-platform.yml' }),
});

export class DeployError extends Error {
  name = 'DeployError';
}

// A check that cannot run because an earlier one failed.
export class Skip extends Error {
  name = 'Skip';
}

const tail = (text, lines = 6) => String(text ?? '').trim().split(/\r?\n/).slice(-lines).join('\n');

function finish(command, label, result, allowFailure) {
  if (result.error) {
    throw new DeployError(result.error.code === 'ENOENT' ? `"${command}" was not found on PATH.` : `${label}: ${result.error.message}`);
  }
  const outcome = { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  if (outcome.status !== 0 && !allowFailure) {
    throw new DeployError(`${label} failed (exit ${outcome.status}).\n${tail(outcome.stderr || outcome.stdout)}`);
  }
  return outcome;
}

export function exec(command, args, { input, cwd, env, allowFailure = false, inherit = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, AWS_PAGER: '', ...env },
    stdio: inherit ? ['ignore', 'inherit', 'inherit'] : 'pipe',
  });
  return finish(command, `${command} ${args.slice(0, 3).join(' ')}`, result, allowFailure);
}

// npm is a .cmd file on Windows and only starts through a shell; callers pass fixed command lines, never user input.
export function shell(commandLine, { env, inherit = true, allowFailure = false } = {}) {
  const result = spawnSync(commandLine, {
    shell: true,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...env },
    stdio: inherit ? ['ignore', 'inherit', 'inherit'] : 'pipe',
  });
  return finish(commandLine.split(' ')[0], commandLine, result, allowFailure);
}

export function createContext(overrides = {}) {
  return {
    exec,
    shell,
    env: process.env,
    ci: process.env.GITHUB_ACTIONS === 'true',
    now: () => Date.now(),
    sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    log: message => console.log(message),
    http: (url, init) => fetch(url, init),
    // Without a terminal there is nobody to ask, so the answer is no.
    confirm: async question => {
      if (!process.stdin.isTTY) return false;
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return /^y(es)?$/i.test((await prompt.question(`${question} [y/N] `)).trim());
      } finally {
        prompt.close();
      }
    },
    ...overrides,
  };
}

const SESSION_PROBLEM = /ExpiredToken|Unable to locate credentials|security token included in the request is (expired|invalid)|InvalidClientTokenId/i;

export function awsTry(ctx, args, { region, text = false } = {}) {
  const full = [...args, ...(region ? ['--region', region] : []), '--output', text ? 'text' : 'json'];
  const result = ctx.exec('aws', full, { allowFailure: true });
  if (result.status !== 0) return { ok: false, data: null, error: tail(result.stderr || result.stdout) };
  const output = result.stdout.trim();
  return { ok: true, data: text || !output ? output : JSON.parse(output), error: '' };
}

export function aws(ctx, args, options) {
  const result = awsTry(ctx, args, options);
  if (result.ok) return result.data;
  const hint = SESSION_PROBLEM.test(result.error) ? '\nThe AWS session is missing or expired. Refresh your AWS credentials (for example aws sso login) and retry.' : '';
  throw new DeployError(`aws ${args.slice(0, 2).join(' ')} failed: ${result.error}${hint}`);
}

// For commands whose output is not JSON, such as s3 sync and the waiters.
export function awsRun(ctx, args, { region } = {}) {
  return ctx.exec('aws', [...args, ...(region ? ['--region', region] : [])]).stdout;
}

export function verifyIdentity(ctx, target) {
  const identity = aws(ctx, ['sts', 'get-caller-identity']);
  if (identity.Account !== CONFIG.accountId) {
    throw new DeployError(`Signed in to account ${identity.Account}, but this project deploys to ${CONFIG.accountId}.`);
  }
  // Without this, a failed token exchange could silently fall back to the developer credentials stored on the runner machine.
  if (ctx.ci && !identity.Arn.includes(`:assumed-role/${target.stack}-deploy/`)) {
    throw new DeployError(`The pipeline must run as ${target.stack}-deploy, but the active identity is ${identity.Arn}.`);
  }
  return identity;
}

export function readStack(ctx, target, requiredOutputs = []) {
  const { Stacks: [stack] } = aws(ctx, ['cloudformation', 'describe-stacks', '--stack-name', target.stack], { region: target.region });
  if (!['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(stack.StackStatus)) {
    throw new DeployError(`Stack ${target.stack} is ${stack.StackStatus}. Wait for it to finish or repair it before releasing.`);
  }
  const outputs = Object.fromEntries((stack.Outputs ?? []).map(output => [output.OutputKey, output.OutputValue]));
  const parameters = Object.fromEntries((stack.Parameters ?? []).map(parameter => [parameter.ParameterKey, parameter.ParameterValue]));
  const missing = requiredOutputs.filter(key => !outputs[key]);
  if (missing.length > 0) {
    throw new DeployError(`Stack ${target.stack} has no output ${missing.join(', ')}. Apply the current template first: npm run deploy:infra -- ${target.name}`);
  }
  return { status: stack.StackStatus, outputs, parameters };
}

// Runs every check and prints the outcome. With all=false it stops at the first failure so slow checks do not run for nothing.
export function runChecks(ctx, checks, { all = false } = {}) {
  const results = [];
  let stopped = false;
  for (const { name, run, critical = false } of checks) {
    if (stopped) {
      results.push({ name, state: 'skip', detail: 'not reached' });
      continue;
    }
    try {
      results.push({ name, state: 'ok', detail: run() ?? '' });
    } catch (error) {
      if (error instanceof Skip) {
        results.push({ name, state: 'skip', detail: error.message });
      } else if (error instanceof DeployError) {
        results.push({ name, state: 'fail', detail: error.message });
        stopped = critical || !all;
      } else {
        throw error;
      }
    }
  }
  const width = Math.max(...results.map(result => result.name.length));
  const labels = { ok: ' ok ', fail: 'FAIL', skip: 'skip' };
  for (const { name, state, detail } of results) {
    ctx.log(`  [${labels[state]}] ${name.padEnd(width)}  ${detail.replaceAll('\n', `\n${' '.repeat(width + 10)}`)}`);
  }
  return results.every(result => result.state !== 'fail');
}

// ---------------------------------------------------------------- Lambda packaging

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = data => {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

/**
 * A deflated .zip of { name, data } entries, built in-process so the Windows runner and a developer machine
 * produce the same Lambda package without zip, PowerShell or extra npm packages.
 */
export function zipFiles(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const fileName = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0x00210000, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    locals.push(local, fileName, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0x00210000, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, fileName);
    offset += local.length + fileName.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
