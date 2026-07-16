import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { version } from '../package.json';
import { createLintWorkspace } from './fixtures/lint-workspace.ts';

const repositoryRoot = join(import.meta.dir, '..');
const assetPath = join(repositoryRoot, 'assets/tickets/SKILL.md');
let temporaryDirectory: string;
let executablePath: string;

const helpOutput = `Usage: tickets [options] [command]

Manage tickets in a local filesystem tracker

Options:
  -v, --version       output the version number
  --workspace <path>  override the default ~/.local/state/tickets workspace
  --project <name>    select a project by name
  -h, --help          display help for command

Commands:
  skill               manage agent skills
  lint [options]      validate the selected project
  help [command]      display help for command
`;

type ProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type RunOptions = {
  cwd?: string;
  env?: Record<string, string>;
};

async function run(
  command: string[],
  { cwd = repositoryRoot, env }: RunOptions = {}
): Promise<ProcessResult> {
  const process = Bun.spawn(command, {
    cwd,
    env: env ? { ...processEnv(), ...env } : undefined,
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

function processEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  );
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

  test('a missing --target value is a usage failure', async () => {
    expect(
      await run([...getCommand(), 'skill', 'install', '--target'])
    ).toEqual({
      stdout: '',
      stderr: "error: option '--target <path>' argument missing\n",
      exitCode: 2,
    });
  });

  test('an unknown option is a one-line usage failure', async () => {
    expect(await run([...getCommand(), 'skill', 'install', '--targt'])).toEqual(
      {
        stdout: '',
        stderr: "error: unknown option '--targt'\n",
        exitCode: 2,
      }
    );
  });

  test('installs the exact bundled bytes into an override target', async () => {
    const target = join(temporaryDirectory, `${_name}-override`, 'tickets');
    const installedPath = resolve(target, 'SKILL.md');

    expect(
      await run([...getCommand(), 'skill', 'install', '--target', target])
    ).toEqual({
      stdout: `${installedPath}\n`,
      stderr: '',
      exitCode: 0,
    });
    expect(await readFile(installedPath)).toEqual(await readFile(assetPath));
  });

  test('uses the default target beneath the home directory', async () => {
    const home = join(temporaryDirectory, `${_name}-home`);
    const installedPath = join(home, '.agents/skills/tickets/SKILL.md');

    expect(
      await run([...getCommand(), 'skill', 'install'], { env: { HOME: home } })
    ).toEqual({
      stdout: `${installedPath}\n`,
      stderr: '',
      exitCode: 0,
    });
    expect(await readFile(installedPath)).toEqual(await readFile(assetPath));
  });
});

test('lint covers every finding code and a clean JSON run through the CLI', async () => {
  const workspace = join(temporaryDirectory, 'lint-workspace');
  const cases = await createLintWorkspace(workspace);
  let observedCodes = new Set<string>();
  const outputs = new Map<string, string>();

  for (const lintCase of cases) {
    const result = await run([
      'bun',
      'src/cli.ts',
      '--workspace',
      workspace,
      '--project',
      lintCase.project,
      'lint',
    ]);
    outputs.set(lintCase.project, result.stdout);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(lintCase.codes.length === 0 ? 0 : 1);
    const codes = result.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t')[1]);
    observedCodes = new Set([...observedCodes, ...codes]);
    expect(codes.toSorted()).toEqual([...lintCase.codes].toSorted());
  }

  expect(outputs.get('invalid-default')).toBe(
    `${join(workspace, 'invalid-default', 'project.md')}\tinvalid-default-status\tDefault-Status must be one normalized status name\n`
  );
  expect(observedCodes.size).toBe(19);

  const repository = join(temporaryDirectory, 'lint-repository');
  await mkdir(repository);
  expect(await run(['git', 'init'], { cwd: repository })).toMatchObject({
    exitCode: 0,
  });
  expect(
    await run(
      ['git', 'remote', 'add', 'origin', 'git@example.com:clean/repo.git'],
      { cwd: repository }
    )
  ).toMatchObject({ exitCode: 0 });
  expect(
    await run(
      [
        'bun',
        resolve(repositoryRoot, 'src/cli.ts'),
        '--workspace',
        workspace,
        'lint',
      ],
      { cwd: repository }
    )
  ).toEqual({ stdout: '', stderr: '', exitCode: 0 });

  expect(
    await run([
      'bun',
      'src/cli.ts',
      '--workspace',
      workspace,
      '--project',
      'clean-project',
      'lint',
      '--json',
    ])
  ).toEqual({
    stdout: '{\n  "project": "clean-project",\n  "violations": []\n}\n',
    stderr: '',
    exitCode: 0,
  });

  const invalidDefaultPath = join(workspace, 'invalid-default', 'project.md');
  expect(
    await run([
      'bun',
      'src/cli.ts',
      '--workspace',
      workspace,
      '--project',
      'invalid-default',
      'lint',
      '--json',
    ])
  ).toEqual({
    stdout: `${JSON.stringify(
      {
        project: 'invalid-default',
        violations: [
          {
            path: invalidDefaultPath,
            code: 'invalid-default-status',
            message: 'Default-Status must be one normalized status name',
          },
        ],
      },
      null,
      2
    )}\n`,
    stderr: '',
    exitCode: 1,
  });
}, 20_000);

test('lint reports selection failures only on stderr with exit status 2', async () => {
  expect(
    await run(
      [
        'bun',
        resolve(repositoryRoot, 'src/cli.ts'),
        '--workspace',
        join(temporaryDirectory, 'missing-workspace'),
        'lint',
      ],
      { cwd: temporaryDirectory }
    )
  ).toEqual({
    stdout: '',
    stderr:
      'Cannot discover a project: the current directory is not in a Git worktree; use --project.\n',
    exitCode: 2,
  });
});

test('an interactive decline preserves the skill and exits successfully', async () => {
  const target = join(temporaryDirectory, 'decline', 'tickets');
  const installedPath = join(target, 'SKILL.md');
  await mkdir(target, { recursive: true });
  await writeFile(installedPath, 'keep me');

  expect(
    await run([
      'bun',
      'tests/fixtures/interactive-cli.ts',
      'skill',
      'install',
      '--target',
      target,
    ])
  ).toEqual({ stdout: '', stderr: '', exitCode: 0 });
  expect(await readFile(installedPath, 'utf8')).toBe('keep me');
});

test('an interactive confirmation replaces the skill', async () => {
  const target = join(temporaryDirectory, 'confirm', 'tickets');
  const installedPath = join(target, 'SKILL.md');
  await mkdir(target, { recursive: true });
  await writeFile(installedPath, 'old skill');

  expect(
    await run(
      [
        'bun',
        'tests/fixtures/interactive-cli.ts',
        'skill',
        'install',
        '--target',
        target,
      ],
      { env: { TICKETS_TEST_CONFIRM: 'yes' } }
    )
  ).toEqual({ stdout: `${installedPath}\n`, stderr: '', exitCode: 0 });
  expect(await readFile(installedPath)).toEqual(await readFile(assetPath));
});

describe.each([
  ['Bun entry point', () => ['bun', 'src/cli.ts']],
  ['native executable', () => [executablePath]],
])('%s overwrite behavior', (_name, getCommand) => {
  test('fails without output when a non-interactive overwrite needs --force', async () => {
    const target = join(
      temporaryDirectory,
      `${_name}-non-interactive`,
      'tickets'
    );
    const installedPath = join(target, 'SKILL.md');
    await mkdir(target, { recursive: true });
    await writeFile(installedPath, 'keep me');

    expect(
      await run([...getCommand(), 'skill', 'install', '--target', target])
    ).toEqual({
      stdout: '',
      stderr: `${installedPath} already exists; use --force to overwrite it\n`,
      exitCode: 2,
    });
    expect(await readFile(installedPath, 'utf8')).toBe('keep me');
  });

  test('--force preserves unrelated target files', async () => {
    const target = join(temporaryDirectory, `${_name}-force`, 'tickets');
    const installedPath = join(target, 'SKILL.md');
    const unrelatedPath = join(target, 'notes.txt');
    await mkdir(target, { recursive: true });
    await writeFile(installedPath, 'old skill');
    await writeFile(unrelatedPath, 'keep me');

    expect(
      await run([
        ...getCommand(),
        'skill',
        'install',
        '--target',
        target,
        '--force',
      ])
    ).toEqual({
      stdout: `${installedPath}\n`,
      stderr: '',
      exitCode: 0,
    });
    expect(await readFile(installedPath)).toEqual(await readFile(assetPath));
    expect(await readFile(unrelatedPath, 'utf8')).toBe('keep me');
  });
});
