// Release entry point; see deploy/cli.mjs for the commands.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './deploy/cli.mjs';
import { DeployError } from './deploy/lib.mjs';

// The templates and build commands use paths relative to the repository root.
process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '..'));

try {
  await run(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof DeployError)) throw error;
  console.error(`\n${error.message}`);
  process.exitCode = 1;
}
