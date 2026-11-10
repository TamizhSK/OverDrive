// Previews a CloudFormation change set, asks for confirmation, then applies that same change set.
// CloudFormation keeps the stack state and rejects a second update while one is running, so no state bucket or lock table is needed for it.
import { resolve } from 'node:path';
import { CONFIG, DeployError, aws, awsTry, verifyIdentity } from './lib.mjs';

const CHANGE_SET_ARN = /--change-set-name\s+(\S+)/;
const REPLACEMENT_NOTES = { True: 'REPLACES the resource', Conditional: 'may replace the resource' };

export function summarizeChanges(changes) {
  const rows = changes.map(({ ResourceChange: change }) => {
    const properties = [...new Set((change.Details ?? []).filter(detail => detail.Target?.Attribute === 'Properties').map(detail => detail.Target.Name))];
    const replacement = REPLACEMENT_NOTES[change.Replacement] ?? '';
    const notes = [replacement, properties.join(', ')].filter(Boolean).map(note => `  (${note})`).join('');
    return { risky: change.Action === 'Remove' || replacement !== '', text: `${change.Action.padEnd(7)} ${change.LogicalResourceId}  ${change.ResourceType}${notes}` };
  });
  return { lines: rows.map(row => `  ${row.risky ? '!!' : '  '} ${row.text}`), risky: rows.some(row => row.risky) };
}

function dropChangeSet(ctx, region, name) {
  awsTry(ctx, ['cloudformation', 'delete-change-set', '--change-set-name', name], { region });
}

function dropReviewStack(ctx, target) {
  aws(ctx, ['cloudformation', 'delete-stack', '--stack-name', target.stack], { region: target.region });
  const waited = ctx.exec('aws', ['cloudformation', 'wait', 'stack-delete-complete', '--stack-name', target.stack, '--region', target.region], { allowFailure: true });
  if (waited.status !== 0) throw new DeployError(`The empty review stack ${target.stack} could not be cleaned up.`);
}

function reportFailure(ctx, target) {
  const events = awsTry(ctx, ['cloudformation', 'describe-stack-events', '--stack-name', target.stack, '--max-items', '25'], { region: target.region });
  const failed = (events.data?.StackEvents ?? []).filter(event => event.ResourceStatus?.endsWith('FAILED'));
  return failed.slice(0, 5).map(event => `${event.LogicalResourceId}: ${event.ResourceStatusReason}`).join('\n');
}

export async function infra(ctx, targetName, { yes = false, planOnly = false, advisorEmail, customerEmailSender } = {}) {
  const target = CONFIG[targetName];
  if (!target?.template) throw new DeployError('Choose a stack: backend or frontend.');
  if ((advisorEmail || customerEmailSender) && targetName !== 'backend') {
    throw new DeployError('Use --advisor-email and --customer-email-sender only with the backend stack.');
  }
  // Parameters not named here keep their current stack values.
  const overrides = [
    ...(advisorEmail ? [`AdvisorNotificationEmail=${advisorEmail}`] : []),
    ...(customerEmailSender ? [`CustomerEmailSender=${customerEmailSender}`] : []),
  ];
  const identity = verifyIdentity(ctx, target);
  ctx.log(`Signed in as ${identity.Arn}`);
  const described = awsTry(ctx, ['cloudformation', 'describe-stacks', '--stack-name', target.stack], { region: target.region });
  const stackStatus = described.data?.Stacks?.[0]?.StackStatus;
  const exists = described.ok && stackStatus !== 'REVIEW_IN_PROGRESS';
  if (!exists && !['analytics', 'state'].includes(targetName)) {
    throw new DeployError(`Stack ${target.stack} does not exist in ${target.region}. First-time creation is described in docs/deployment.md.`);
  }

  aws(ctx, ['cloudformation', 'validate-template', '--template-body', `file://${resolve(target.template)}`], { region: target.region });
  ctx.log(`${target.template} is valid. Creating a change set; nothing is applied yet.`);
  const created = ctx.exec('aws', [
    'cloudformation', 'deploy', '--no-execute-changeset', '--no-fail-on-empty-changeset',
    '--stack-name', target.stack, '--template-file', target.template, '--capabilities', 'CAPABILITY_NAMED_IAM', '--region', target.region,
    ...(overrides.length ? ['--parameter-overrides', ...overrides] : []),
  ]);
  const changeSet = CHANGE_SET_ARN.exec(`${created.stdout}\n${created.stderr}`)?.[1];
  if (!changeSet) {
    ctx.log(`Stack ${target.stack} already matches the template. Nothing to apply.`);
    return;
  }

  const { Changes: changes = [] } = aws(ctx, ['cloudformation', 'describe-change-set', '--change-set-name', changeSet], { region: target.region });
  const { lines, risky } = summarizeChanges(changes);
  ctx.log(`Stack ${target.stack} (${target.region}) would change:`);
  for (const line of lines) ctx.log(line);
  if (risky) ctx.log('Lines marked !! remove or replace a resource. Read them before you continue.');

  if (planOnly) {
    dropChangeSet(ctx, target.region, changeSet);
    if (!exists) dropReviewStack(ctx, target);
    ctx.log('Plan only: the change set was deleted and nothing was changed.');
    return;
  }
  if (!(yes || await ctx.confirm(`Apply these ${changes.length} change(s) to ${target.stack}?`))) {
    dropChangeSet(ctx, target.region, changeSet);
    if (!exists) dropReviewStack(ctx, target);
    ctx.log('Not applied: the change set was deleted and nothing was changed.');
    return;
  }

  aws(ctx, ['cloudformation', 'execute-change-set', '--change-set-name', changeSet], { region: target.region });
  ctx.log('Applying; this can take several minutes...');
  const waiter = exists ? 'stack-update-complete' : 'stack-create-complete';
  const waited = ctx.exec('aws', ['cloudformation', 'wait', waiter, '--stack-name', target.stack, '--region', target.region], { allowFailure: true });
  const { Stacks: [stack] } = aws(ctx, ['cloudformation', 'describe-stacks', '--stack-name', target.stack], { region: target.region });
  const completeStatuses = exists ? ['UPDATE_COMPLETE'] : ['CREATE_COMPLETE'];
  if (waited.status !== 0 || !completeStatuses.includes(stack.StackStatus)) {
    throw new DeployError(`Stack ${target.stack} ended as ${stack.StackStatus}.\n${reportFailure(ctx, target)}`);
  }
  ctx.log(`Stack ${target.stack} is ${stack.StackStatus}.`);
}
