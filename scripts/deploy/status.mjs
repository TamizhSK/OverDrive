// Read-only report of what is deployed: the code each backend Lambda runs, its event wiring, and whether the live site answers.
import { CONFIG, DeployError, aws, awsTry, verifyIdentity } from './lib.mjs';
import { BACKEND_FUNCTIONS, currentCommit } from './release.mjs';

// Each finding is { ok: true | false | null, text }; null is informational.
export function assessFunction(name, config) {
  if (!config) return { ok: false, text: `${name} does not exist: npm run deploy:infra -- backend` };
  const placeholder = config.CodeSize < 1024;
  const healthy = config.State === 'Active' && config.LastUpdateStatus === 'Successful' && !placeholder;
  const detail = placeholder ? 'still runs the bootstrap placeholder: npm run deploy:backend' : `code ${config.CodeSha256.slice(0, 12)}, updated ${config.LastModified}`;
  return { ok: healthy, text: `${name}: ${config.State}/${config.LastUpdateStatus}, ${detail}` };
}

const MARKS = new Map([[true, '[ ok ]'], [false, '[ !! ]'], [null, '[ -- ]']]);
const mark = ok => MARKS.get(ok);

function section(ctx, title, work) {
  ctx.log(`\n${title}`);
  return Promise.resolve()
    .then(work)
    .catch(error => {
      if (!(error instanceof DeployError)) throw error;
      ctx.log(`  unavailable: ${error.message.split('\n')[0]}`);
    });
}

async function probe(ctx, url, expectedStatus) {
  try {
    const response = await ctx.http(url);
    const body = (await response.text()).replace(/\s+/g, ' ').slice(0, 80);
    return `${mark(response.status === expectedStatus)} ${url} -> ${response.status} ${body}`;
  } catch (error) {
    return `${mark(false)} ${url} -> ${error.message}`;
  }
}

async function backend(ctx) {
  const target = CONFIG.backend;
  const { Stacks: [stack] } = aws(ctx, ['cloudformation', 'describe-stacks', '--stack-name', target.stack], { region: target.region });
  const outputs = Object.fromEntries((stack.Outputs ?? []).map(output => [output.OutputKey, output.OutputValue]));
  const parameters = Object.fromEntries((stack.Parameters ?? []).map(parameter => [parameter.ParameterKey, parameter.ParameterValue]));
  ctx.log(`  stack ${target.stack}: ${stack.StackStatus}`);

  for (const { output } of BACKEND_FUNCTIONS) {
    const name = outputs[output];
    const config = name ? awsTry(ctx, ['lambda', 'get-function-configuration', '--function-name', name], { region: target.region }).data : null;
    const { ok, text } = assessFunction(name ?? output, config);
    ctx.log(`  ${mark(ok)} ${text}`);
  }
  if (outputs.TicketEventsFunctionName) {
    const mappings = awsTry(ctx, ['lambda', 'list-event-source-mappings', '--function-name', outputs.TicketEventsFunctionName], { region: target.region }).data?.EventSourceMappings ?? [];
    const stream = mappings.find(mapping => mapping.EventSourceArn?.includes(':dynamodb:'));
    ctx.log(`  ${mark(stream?.State === 'Enabled')} Tickets stream -> ticket events: ${stream?.State ?? 'not connected'}`);
  }

  if (parameters.WebOrigin) {
    ctx.log(`  ${await probe(ctx, `${parameters.WebOrigin}/api/health`, 200)}`);
    ctx.log(`  ${await probe(ctx, `${parameters.WebOrigin}/api/tickets`, 401)}  (401 expected without a token)`);
  }

  const table = awsTry(ctx, ['dynamodb', 'describe-table', '--table-name', outputs.InteractionsTable], { region: target.region });
  const index = table.data?.Table?.GlobalSecondaryIndexes?.find(candidate => candidate.IndexName === 'customer-created');
  ctx.log(`  ${mark(index?.IndexStatus === 'ACTIVE')} ${index ? `Resolved-history index is ${index.IndexStatus}` : 'Resolved-history index is missing: npm run deploy:infra -- backend'}`);
}

async function frontend(ctx) {
  const target = CONFIG.frontend;
  const { Stacks: [stack] } = aws(ctx, ['cloudformation', 'describe-stacks', '--stack-name', target.stack], { region: target.region });
  const outputs = Object.fromEntries((stack.Outputs ?? []).map(output => [output.OutputKey, output.OutputValue]));
  ctx.log(`  stack ${target.stack}: ${stack.StackStatus}`);
  const page = awsTry(ctx, ['s3api', 'head-object', '--bucket', outputs.BucketName, '--key', 'index.html'], { region: target.region });
  ctx.log(page.ok ? `  index.html in s3://${outputs.BucketName} was last published ${page.data.LastModified}` : '  index.html: not readable with this session');
  ctx.log(`  ${await probe(ctx, `${outputs.WebUrl}/`, 200)}`);
}

export async function status(ctx) {
  const identity = verifyIdentity(ctx, CONFIG.backend);
  ctx.log(`Signed in as ${identity.Arn}`);
  await section(ctx, 'Source', () => {
    ctx.exec('git', ['fetch', '--quiet', 'origin', CONFIG.mainBranch], { allowFailure: true });
    const head = ctx.exec('git', ['rev-parse', `origin/${CONFIG.mainBranch}`]).stdout.trim();
    ctx.log(`  local HEAD ${currentCommit(ctx).slice(0, 7)}, origin/${CONFIG.mainBranch} ${head.slice(0, 7)}`);
  });
  await section(ctx, `Backend (${CONFIG.backend.region})`, () => backend(ctx));
  await section(ctx, `Frontend (${CONFIG.frontend.region})`, () => frontend(ctx));
}
