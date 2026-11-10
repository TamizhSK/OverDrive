// Command-line parsing and dispatch for scripts/deploy.mjs.
import { ciLogin } from './ci-login.mjs';
import { infra } from './infra.mjs';
import { DeployError, createContext } from './lib.mjs';
import { releaseBackend, releaseFrontend } from './release.mjs';
import { status } from './status.mjs';

export const USAGE = `Usage: npm run <script> -- [options]      (or: node scripts/deploy.mjs <command> [options])

  deploy:status                    What is deployed: the code each backend Lambda runs, the stream wiring, live health. Read-only.
  deploy:infra -- <backend|frontend|state|analytics>
                                   Preview the CloudFormation change set, then apply it after confirmation.
      --plan-only                  Show the change set, delete it, change nothing.
      --yes                        Apply without asking.
      --advisor-email <address>    Subscribe an approved advisor inbox to backend ticket alerts.
      --customer-email-sender <address>
                                   Verified SES sender for customer ticket emails (backend only).
  deploy:backend                   Check, build and publish the API, ticket-events and ticket-actions Lambdas, then smoke test the API.
      --check                      Run the checks only and change nothing.
  deploy:frontend                  Check, build, publish to S3, invalidate CloudFront, smoke test.
      --check                      Run the checks only and change nothing.

The pipeline also uses: node scripts/deploy.mjs ci-login <backend|frontend>`;

const OPTIONS = { check: 'flag', yes: 'flag', 'plan-only': 'flag', 'advisor-email': 'string', 'customer-email-sender': 'string' };

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const positional = [];
  const flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (!argument.startsWith('--')) {
      positional.push(argument);
      continue;
    }
    const equals = argument.indexOf('=');
    const name = argument.slice(2, equals === -1 ? undefined : equals);
    const kind = OPTIONS[name];
    if (!kind) throw new DeployError(`Unknown option --${name}.\n\n${USAGE}`);
    if (kind === 'flag') {
      flags[name] = true;
      continue;
    }
    let value = argument.slice(equals + 1);
    if (equals === -1) {
      index += 1;
      value = rest[index];
    }
    if (!value) throw new DeployError(`--${name} needs a value.`);
    flags[name] = value;
  }
  return { command, positional, flags };
}

export async function run(argv, ctx = createContext()) {
  const { command, positional, flags } = parseArgs(argv);
  switch (command) {
    case 'status':
      return status(ctx);
    case 'backend':
      return releaseBackend(ctx, { check: flags.check });
    case 'frontend':
      return releaseFrontend(ctx, { check: flags.check });
    case 'infra':
      return infra(ctx, positional[0], { yes: flags.yes, planOnly: flags['plan-only'], advisorEmail: flags['advisor-email'], customerEmailSender: flags['customer-email-sender'] });
    case 'ci-login':
      return ciLogin(ctx, positional[0]);
    case undefined:
    case 'help':
    case '--help':
      return ctx.log(USAGE);
    default:
      throw new DeployError(`Unknown command "${command}".\n\n${USAGE}`);
  }
}
