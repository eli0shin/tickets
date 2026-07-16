import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { version } from '../package.json';

const repositoryRoot = join(import.meta.dir, '..');
let temporaryDirectory: string;
let executablePath: string;

const helpOutput = `Usage: tickets [options]

Manage tickets in a local filesystem tracker

Options:
  -v, --version       output the version number
  --workspace <path>  override the default ~/.local/state/tickets workspace
  --project <name>    select a project by name
  -h, --help          display help for command
`;

type ProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

async function run(command: string[]): Promise<ProcessResult> {
  const process = Bun.spawn(command, {
    cwd: repositoryRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);

  return { stdout, stderr, exitCode };
}

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'tickets-packaging-'));
  executablePath = join(temporaryDirectory, 'tickets');

  const result = await run([
    'bun',
    'build',
    'src/cli.ts',
    '--compile',
    `--outfile=${executablePath}`,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`Could not build tickets executable:\n${result.stderr}`);
  }
}, 30_000);

afterAll(async () => {
  await rm(temporaryDirectory, { force: true, recursive: true });
});

describe.each([
  ['Bun entry point', () => ['bun', 'src/cli.ts']],
  ['native executable', () => [executablePath]],
])('%s', (_name, getCommand) => {
  test('--help prints the complete help text', async () => {
    expect(await run([...getCommand(), '--help'])).toEqual({
      stdout: helpOutput,
      stderr: '',
      exitCode: 0,
    });
  });

  test('--version prints the package version', async () => {
    expect(await run([...getCommand(), '--version'])).toEqual({
      stdout: `${version}\n`,
      stderr: '',
      exitCode: 0,
    });
  });
});
