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
  -v, --version            output the version number
  --workspace <path>       override the default ~/.local/state/tickets workspace
  --project <name>         select a project by name
  -h, --help               display help for command

Commands:
  project                  manage projects
  status                   manage statuses
  show <reference>         show a complete ticket document
  list [options] <status>  list tickets in one status
  search [options]         search tickets using structured criteria
  skill                    manage agent skills
  lint [options]           validate the selected project
  help [command]           display help for command
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

async function git(cwd: string, arguments_: string[]): Promise<void> {
  const result = await run(['git', '-C', cwd, ...arguments_]);
  if (result.exitCode !== 0) throw new Error(result.stderr);
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

describe('read-only commands', () => {
  test('discovers the selected project from a real Git origin', async () => {
    const cwd = await mkdtemp(join(temporaryDirectory, 'read-git-selection-'));
    const workspace = join(cwd, 'workspace');
    const projectPath = join(workspace, 'alpha-project');
    const todoPath = join(projectPath, 'todo');
    const ticketPath = join(todoPath, '001-selected.md');
    const ticketSource = '---\nTags: [selected]\n---\nSelected by Git\n';
    await mkdir(todoPath, { recursive: true });
    await mkdir(join(workspace, 'unrelated-project'));
    await mkdir(join(workspace, 'malformed-project'));
    await writeFile(
      join(workspace, 'malformed-project', 'project.md'),
      'not YAML front matter\n'
    );
    await writeFile(
      join(projectPath, 'project.md'),
      '---\nDefault-Status: todo\nGit-Repo: git@example.com:OWNER/REPO.git\n---\n'
    );
    await writeFile(ticketPath, ticketSource);
    await git(cwd, ['init']);
    await git(cwd, [
      'remote',
      'add',
      'origin',
      'https://example.com/owner/repo.git',
    ]);

    const base = [
      'bun',
      join(repositoryRoot, 'src/cli.ts'),
      '--workspace',
      workspace,
    ];
    expect(await run([...base, 'status', 'list'], { cwd })).toEqual({
      stdout: `todo\t${todoPath}\n`,
      stderr: '',
      exitCode: 0,
    });
    expect(await run([...base, 'show', '001-selected'], { cwd })).toEqual({
      stdout: ticketSource,
      stderr: '',
      exitCode: 0,
    });
    expect(await run([...base, 'list', 'todo'], { cwd })).toEqual({
      stdout: `todo\t001-selected\t${ticketPath}\n`,
      stderr: '',
      exitCode: 0,
    });
    expect(
      await run([...base, 'search', '--tag', 'selected'], { cwd })
    ).toEqual({
      stdout: `todo\t001-selected\t${ticketPath}\n`,
      stderr: '',
      exitCode: 0,
    });
  });

  test('shows a cross-project reference without selecting a project', async () => {
    const cwd = await mkdtemp(join(temporaryDirectory, 'read-cross-project-'));
    const workspace = join(cwd, 'workspace');
    const statusPath = join(workspace, 'beta-project', 'todo');
    const ticketPath = join(statusPath, '001-cross-project.md');
    const source = '---\nTags: []\n---\nCross project\n';
    await mkdir(statusPath, { recursive: true });
    await writeFile(ticketPath, source);
    const base = [
      'bun',
      join(repositoryRoot, 'src/cli.ts'),
      '--workspace',
      workspace,
      'show',
    ];

    expect(
      await run([...base, 'beta-project/001-cross-project'], { cwd })
    ).toEqual({ stdout: source, stderr: '', exitCode: 0 });
    expect(await run([...base, 'BAD'], { cwd })).toEqual({
      stdout: '',
      stderr: 'Invalid ticket reference: BAD\n',
      exitCode: 2,
    });
  });

  test('lists projects and statuses in plain text and JSON from an isolated workspace', async () => {
    const cwd = await mkdtemp(join(temporaryDirectory, 'read-listings-'));
    const workspace = join(cwd, 'workspace');
    const projectPath = join(workspace, 'alpha-project');
    await mkdir(join(projectPath, 'todo'), { recursive: true });
    await mkdir(join(projectPath, 'done'));

    expect(
      await run(
        [
          'bun',
          join(repositoryRoot, 'src/cli.ts'),
          '--workspace',
          workspace,
          'project',
          'list',
        ],
        { cwd }
      )
    ).toEqual({
      stdout: `alpha-project\t${projectPath}\n`,
      stderr: '',
      exitCode: 0,
    });
    expect(
      await run(
        [
          'bun',
          join(repositoryRoot, 'src/cli.ts'),
          '--workspace',
          workspace,
          'project',
          'list',
          '--json',
        ],
        { cwd }
      )
    ).toEqual({
      stdout: `${JSON.stringify(
        { projects: [{ name: 'alpha-project', path: projectPath }] },
        null,
        2
      )}\n`,
      stderr: '',
      exitCode: 0,
    });
    const statusCommand = [
      'bun',
      join(repositoryRoot, 'src/cli.ts'),
      '--workspace',
      workspace,
      '--project',
      'alpha-project',
      'status',
      'list',
    ];
    expect(await run(statusCommand, { cwd })).toEqual({
      stdout: `done\t${join(projectPath, 'done')}\ntodo\t${join(projectPath, 'todo')}\n`,
      stderr: '',
      exitCode: 0,
    });
    expect(await run([...statusCommand, '--json'], { cwd })).toEqual({
      stdout: `${JSON.stringify(
        {
          project: 'alpha-project',
          statuses: [
            { name: 'done', path: join(projectPath, 'done') },
            { name: 'todo', path: join(projectPath, 'todo') },
          ],
        },
        null,
        2
      )}\n`,
      stderr: '',
      exitCode: 0,
    });
  });

  test('shows, lists, and searches tickets with exact plain and JSON output', async () => {
    const cwd = await mkdtemp(join(temporaryDirectory, 'read-tickets-'));
    const workspace = join(cwd, 'workspace');
    const projectPath = join(workspace, 'alpha-project');
    const todoPath = join(projectPath, 'todo');
    const donePath = join(projectPath, 'done');
    const firstPath = join(todoPath, '010-first.md');
    const secondPath = join(donePath, '002-second.md');
    const firstSource =
      '---\nAssigned-To: pi\nTags: [task, urgent]\nParent: 001-parent\nBlocked-By: [002-blocker]\n---\n# First\n';
    await mkdir(todoPath, { recursive: true });
    await mkdir(donePath);
    await writeFile(firstPath, firstSource);
    await writeFile(
      secondPath,
      '---\nAssigned-To:\nTags: []\nParent:\nBlocked-By: []\n---\n'
    );
    const base = [
      'bun',
      join(repositoryRoot, 'src/cli.ts'),
      '--workspace',
      workspace,
      '--project',
      'alpha-project',
    ];

    expect(await run([...base, 'show', '010-first'], { cwd })).toEqual({
      stdout: firstSource,
      stderr: '',
      exitCode: 0,
    });
    expect(await run([...base, 'list', 'todo'], { cwd })).toEqual({
      stdout: `todo\t010-first\t${firstPath}\n`,
      stderr: '',
      exitCode: 0,
    });
    expect(await run([...base, 'list', 'todo', '--json'], { cwd })).toEqual({
      stdout: `${JSON.stringify(
        {
          project: 'alpha-project',
          tickets: [
            {
              name: '010-first',
              status: 'todo',
              path: firstPath,
              assignedTo: 'pi',
              tags: ['task', 'urgent'],
              parent: '001-parent',
              blockedBy: ['002-blocker'],
            },
          ],
        },
        null,
        2
      )}\n`,
      stderr: '',
      exitCode: 0,
    });
    expect(
      await run(
        [
          ...base,
          'search',
          '--tag',
          'task',
          '--tag',
          'urgent',
          '--assigned-to',
          'pi',
          '--blocked-by',
          '002-blocker',
          '--json',
        ],
        { cwd }
      )
    ).toEqual({
      stdout: `${JSON.stringify(
        {
          project: 'alpha-project',
          tickets: [
            {
              name: '010-first',
              status: 'todo',
              path: firstPath,
              assignedTo: 'pi',
              tags: ['task', 'urgent'],
              parent: '001-parent',
              blockedBy: ['002-blocker'],
            },
          ],
        },
        null,
        2
      )}\n`,
      stderr: '',
      exitCode: 0,
    });
    expect(
      await run([...base, 'search', '--status', 'missing'], { cwd })
    ).toEqual({ stdout: '', stderr: '', exitCode: 0 });
    for (const repeated of [
      ['--status', 'todo', '--status', 'done'],
      ['--assigned-to', 'pi', '--assigned-to', 'someone-else'],
      ['--parent', '001-parent', '--parent', '002-other'],
    ]) {
      expect(await run([...base, 'search', ...repeated], { cwd })).toEqual({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });
    }
    expect(
      await run([...base, 'search', '--unassigned', '--unblocked'], { cwd })
    ).toEqual({
      stdout: `done\t002-second\t${secondPath}\n`,
      stderr: '',
      exitCode: 0,
    });
  });

  test('retains partial output, reports malformed files, and rejects conflicting criteria', async () => {
    const cwd = await mkdtemp(join(temporaryDirectory, 'read-partial-'));
    const workspace = join(cwd, 'workspace');
    const statusPath = join(workspace, 'alpha-project', 'todo');
    const validPath = join(statusPath, '001-valid.md');
    const malformedPath = join(statusPath, '002-malformed.md');
    await mkdir(statusPath, { recursive: true });
    await writeFile(validPath, '---\nTags: []\n---\n');
    await writeFile(malformedPath, '---\nTags: [broken\n---\n');
    const base = [
      'bun',
      join(repositoryRoot, 'src/cli.ts'),
      '--workspace',
      workspace,
      '--project',
      'alpha-project',
    ];

    const malformedDiagnostic = `${malformedPath}\tFlow sequence in block collection must be sufficiently indented and end with a ]\n`;
    expect(await run([...base, 'list', 'todo'], { cwd })).toEqual({
      stdout: `todo\t001-valid\t${validPath}\n`,
      stderr: malformedDiagnostic,
      exitCode: 2,
    });
    expect(
      await run([...base, 'search', '--status', 'done', '--json'], { cwd })
    ).toEqual({
      stdout: `${JSON.stringify(
        { project: 'alpha-project', tickets: [] },
        null,
        2
      )}\n`,
      stderr: malformedDiagnostic,
      exitCode: 2,
    });

    expect(
      await run([...base, 'search', '--assigned-to', 'pi', '--unassigned'], {
        cwd,
      })
    ).toEqual({
      stdout: '',
      stderr: '--assigned-to and --unassigned cannot be used together\n',
      exitCode: 2,
    });
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
