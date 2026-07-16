import { createTracker } from '../../src/tracker/index.ts';

const workspaceRoot = process.argv[2];
const projectName = process.argv[3];
const description = process.argv[4];
const tagCount = Number(process.argv.at(5) ?? '0');
const result = await createTracker(workspaceRoot).createTicket(projectName, {
  description,
  tags: Array.from({ length: tagCount }, (_, index) => `tag-${index}`),
});
if (result.ok) {
  process.stdout.write(`${result.value.id}\n`);
} else {
  process.stderr.write(
    `${result.diagnostic.code}: ${result.diagnostic.message}\n`
  );
  process.exitCode = 2;
}
