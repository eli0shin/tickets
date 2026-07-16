import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { version } from '../package.json';
import { createProgram } from '../src/cli.ts';
import { createLintWorkspace } from './fixtures/lint-workspace.ts';

const repositoryRoot = join(import.meta.dir, '..');
const assetPath = join(repositoryRoot, 'assets/tickets/SKILL.md');
let temporaryDirectory: string;
let executablePath: string;
let interactiveExecutablePath: string;

const helpOutput = `Usage: tickets [options] [command]

Manage tickets in a local filesystem tracker

Options:
  -V, --version                     output the version number
  --workspace <path>                override the default ~/.local/state/tickets
                                    workspace
  --project <name>                  select a project by name
  -h, --help                        display help for command

Commands:
  project                           manage projects
  status                            manage statuses
  show <reference>                  show a complete ticket document
  list [options] <status>           list tickets in one status
  search [options]                  search tickets using structured criteria
  create [options] <description>    create a ticket in the selected project
  rename <reference> <description>  rename a ticket and update workspace
                                    references
  move <reference> <status>         move a ticket to another status
  done <reference>                  complete a ticket
  skill                             manage agent skills
  lint [options]                    validate the selected project
  help [command]                    display help for command
`;

type ProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type RunOptions = {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
};

type JsonRestrictionCase = {
  name: string;
  arguments: (workspace: string, skillTarget: string) => string[];
};

const unauthorizedJsonCommands: readonly JsonRestrictionCase[] = [
  {
    name: 'project create',
    arguments: (workspace: string) => [
      '--workspace',
      workspace,
      'project',
      'create',
      'new-project',
      '--json',
    ],
  },
  {
    name: 'status create',
    arguments: (workspace: string) => [
      '--workspace',
      workspace,
      '--project',
      'alpha-project',
      'status',
      'create',
      'review',
      '--json',
    ],
  },
  {
    name: 'show',
    arguments: (workspace: string) => [
      '--workspace',
      workspace,
      '--project',
      'alpha-project',
      'show',
      '001-original',
      '--json',
    ],
  },
  {
    name: 'create',
    arguments: (workspace: string) => [
      '--workspace',
      workspace,
      '--project',
      'alpha-project',
      'create',
      'new-ticket',
      '--json',
    ],
  },
  {
    name: 'rename',
    arguments: (workspace: string) => [
      '--workspace',
      workspace,
      '--project',
      'alpha-project',
      'rename',
      '001-original',
      'renamed',
      '--json',
    ],
  },
  {
    name: 'move',
    arguments: (workspace: string) => [
      '--workspace',
      workspace,
      '--project',
      'alpha-project',
      'move',
      '001-original',
      'done',
      '--json',
    ],
  },
  {
    name: 'done',
    arguments: (workspace: string) => [
      '--workspace',
      workspace,
      '--project',
      'alpha-project',
      'done',
      '001-original',
      '--json',
    ],
  },
  {
    name: 'skill install',
    arguments: (workspace: string, skillTarget: string) => [
      '--workspace',
      workspace,
      'skill',
      'install',
      '--target',
      skillTarget,
      '--json',
    ],
  },
];

const ticketSource =
  '---\nAssigned-To:\nTags: []\nParent:\nBlocked-By: []\n---\nOriginal ticket\n';

async function run(
  command: string[],
  { cwd = repositoryRoot, env, stdin }: RunOptions = {}
): Promise<ProcessResult> {
  const process = Bun.spawn(command, {
    cwd,
    env: env ? { ...processEnv(), ...env } : undefined,
    stdin: stdin === undefined ? undefined : new Blob([stdin]),
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

async function captureProcessOutput(action: () => Promise<void>): Promise<{
  stdout: string;
  stderr: string;
  exitCode: typeof process.exitCode;
}> {
  let stdout = '';
  let stderr = '';
  const stdoutWrite = spyOn(process.stdout, 'write').mockImplementation(
    (chunk) => {
      stdout += String(chunk);
      return true;
    }
  );
  const stderrWrite = spyOn(process.stderr, 'write').mockImplementation(
    (chunk) => {
      stderr += String(chunk);
      return true;
    }
  );
  const previousExitCode = process.exitCode;

  try {
    await action();
    return { stdout, stderr, exitCode: process.exitCode };
  } finally {
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
    process.exitCode = previousExitCode;
  }
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

async function sourceFilesMatching(pattern: RegExp): Promise<string[]> {
  const matches: string[] = [];
  for await (const sourceFile of new Bun.Glob('src/**/*.ts').scan({
    cwd: repositoryRoot,
  })) {
    const source = await readFile(join(repositoryRoot, sourceFile), 'utf8');
    if (pattern.test(source)) matches.push(sourceFile);
  }
  return matches;
}

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'tickets-packaging-'));
  executablePath = join(temporaryDirectory, 'tickets');
  interactiveExecutablePath = join(temporaryDirectory, 'tickets-interactive');

  for (const [source, output] of [
    ['src/cli.ts', executablePath],
    ['tests/fixtures/interactive-cli.ts', interactiveExecutablePath],
  ]) {
    const result = await run([
      'bun',
      'build',
      source,
      '--compile',
      `--outfile=${output}`,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`Could not build ${source}:\n${result.stderr}`);
    }
  }
}, 120_000);

afterAll(async () => {
  await rm(temporaryDirectory, { force: true, recursive: true });
});

test('output.ts is the sole source output boundary', async () => {
  expect(
    await sourceFilesMatching(/process\.(?:stdout|stderr)\.write/u)
  ).toEqual(['src/output.ts']);
  expect(await sourceFilesMatching(/from 'node:readline\/promises'/u)).toEqual([
    'src/output.ts',
  ]);
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
  }, 15_000);

  test('standard version options print only the package version', async () => {
    for (const option of ['-V', '--version']) {
      expect(await run([...getCommand(), option])).toEqual({
        stdout: `${version}\n`,
        stderr: '',
        exitCode: 0,
      });
    }
  });

  test('-v is not a version option', async () => {
    expect(await run([...getCommand(), '-v'])).toEqual({
      stdout: '',
      stderr: "error: unknown option '-v'\n",
      exitCode: 2,
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

  for (const jsonCase of unauthorizedJsonCommands) {
    test(`${jsonCase.name} rejects --json before performing any operation`, async () => {
      const sandbox = await mkdtemp(
        join(temporaryDirectory, 'json-restriction-')
      );
      const workspace = join(sandbox, 'workspace');
      const projectPath = join(workspace, 'alpha-project');
      const todoPath = join(projectPath, 'todo');
      const donePath = join(projectPath, 'done');
      const ticketPath = join(todoPath, '001-original.md');
      const projectSource =
        '---\nDefault-Status: todo\nGit-Repo:\n---\nProject body\n';
      const skillTarget = join(sandbox, 'skill-target');
      await mkdir(todoPath, { recursive: true });
      await mkdir(donePath);
      await writeFile(join(projectPath, 'project.md'), projectSource);
      await writeFile(ticketPath, ticketSource);

      expect(
        await run([
          ...getCommand(),
          ...jsonCase.arguments(workspace, skillTarget),
        ])
      ).toEqual({
        stdout: '',
        stderr: "error: unknown option '--json'\n",
        exitCode: 2,
      });

      expect(await readdir(sandbox)).toEqual(['workspace']);
      expect(await readdir(workspace)).toEqual(['alpha-project']);
      expect((await readdir(projectPath)).toSorted()).toEqual([
        'done',
        'project.md',
        'todo',
      ]);
      expect(await readdir(todoPath)).toEqual(['001-original.md']);
      expect(await readdir(donePath)).toEqual([]);
      expect(await readFile(join(projectPath, 'project.md'), 'utf8')).toBe(
        projectSource
      );
      expect(await readFile(ticketPath, 'utf8')).toBe(ticketSource);
    });
  }

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

test('the CLI boundary renders an injected unexpected command failure', async () => {
  expect(
    await run(['bun', 'tests/fixtures/unexpected-cli.ts', 'status', 'list'], {
      env: { TICKETS_TEST_UNEXPECTED: 'command' },
    })
  ).toEqual({
    stdout: '',
    stderr: 'Unexpected failure: command failed unexpectedly with context\n',
    exitCode: 2,
  });
});

test('an arbitrary CommanderError from a command reaches the CLI boundary', async () => {
  expect(
    await run(['bun', 'tests/fixtures/unexpected-cli.ts', 'status', 'list'], {
      env: { TICKETS_TEST_UNEXPECTED: 'commander' },
    })
  ).toEqual({
    stdout: '',
    stderr: 'Unexpected failure: command exploded\n',
    exitCode: 2,
  });
});

test('a rejected skill confirmation reaches the CLI boundary', async () => {
  const target = join(temporaryDirectory, 'rejected-confirmation', 'tickets');
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'SKILL.md'), 'keep me');

  expect(
    await run(
      [
        'bun',
        'tests/fixtures/unexpected-cli.ts',
        'skill',
        'install',
        '--target',
        target,
      ],
      { env: { TICKETS_TEST_UNEXPECTED: 'confirmation' } }
    )
  ).toEqual({
    stdout: '',
    stderr: 'Unexpected failure: confirmation unavailable\n',
    exitCode: 2,
  });
  expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toBe('keep me');
});

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

test('broken references fail only when followed and do not block unrelated operations', async () => {
  const workspace = join(temporaryDirectory, 'broken-reference-boundary');
  const alphaPath = join(workspace, 'alpha-project');
  const alphaTodo = join(alphaPath, 'todo');
  const betaPath = join(workspace, 'beta-project');
  const betaTodo = join(betaPath, 'todo');
  const brokenPath = join(alphaTodo, '001-broken-metadata.md');
  const healthyPath = join(alphaTodo, '002-healthy.md');
  const brokenSource =
    '---\nAssigned-To:\nTags: [broken]\nParent: 999-local-only\nBlocked-By: [beta-project/998-cross-project-missing]\n---\nBroken references remain visible\n';
  const healthySource =
    '---\nAssigned-To:\nTags: [healthy]\nParent:\nBlocked-By: []\n---\nHealthy ticket\n';
  const peerSource =
    '---\nAssigned-To:\nTags: []\nParent:\nBlocked-By: []\n---\nPeer ticket\n';
  await Promise.all([
    mkdir(join(alphaPath, 'done'), { recursive: true }),
    mkdir(alphaTodo, { recursive: true }),
    mkdir(betaTodo, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(alphaPath, 'project.md'),
      '---\nDefault-Status: todo\nGit-Repo:\n---\n'
    ),
    writeFile(
      join(betaPath, 'project.md'),
      '---\nDefault-Status: todo\nGit-Repo:\n---\n'
    ),
    writeFile(brokenPath, brokenSource),
    writeFile(healthyPath, healthySource),
    writeFile(join(betaTodo, '999-local-only.md'), peerSource),
  ]);
  const cli = ['bun', 'src/cli.ts', '--workspace', workspace];
  const alpha = [...cli, '--project', 'alpha-project'];

  expect(await run([...alpha, 'show', '999-local-only'])).toEqual({
    stdout: '',
    stderr: 'Ticket not found: 999-local-only\n',
    exitCode: 2,
  });
  expect(
    await run([...cli, 'show', 'beta-project/998-cross-project-missing'])
  ).toEqual({
    stdout: '',
    stderr: 'Ticket not found: beta-project/998-cross-project-missing\n',
    exitCode: 2,
  });

  expect(await run([...alpha, 'show', '002-healthy'])).toEqual({
    stdout: healthySource,
    stderr: '',
    exitCode: 0,
  });
  expect(await run([...alpha, 'list', 'todo'])).toEqual({
    stdout: `todo\t001-broken-metadata\t${brokenPath}\ntodo\t002-healthy\t${healthyPath}\n`,
    stderr: '',
    exitCode: 0,
  });
  expect(await run([...alpha, 'search', '--tag', 'healthy'])).toEqual({
    stdout: `todo\t002-healthy\t${healthyPath}\n`,
    stderr: '',
    exitCode: 0,
  });

  const createdPath = join(alphaTodo, '003-created.md');
  expect(await run([...alpha, 'create', 'created'])).toEqual({
    stdout: `${createdPath}\n`,
    stderr: '',
    exitCode: 0,
  });
  const renamedPath = join(alphaTodo, '002-renamed.md');
  expect(await run([...alpha, 'rename', '002-healthy', 'renamed'])).toEqual({
    stdout: `${renamedPath}\n`,
    stderr: '',
    exitCode: 0,
  });
  expect(await readFile(brokenPath, 'utf8')).toBe(brokenSource);

  expect(await run([...alpha, 'lint'])).toEqual({
    stdout:
      `${brokenPath}\tbroken-blocker-reference\tBlocker reference does not resolve to exactly one ticket: beta-project/998-cross-project-missing\n` +
      `${brokenPath}\tbroken-parent-reference\tParent reference does not resolve to exactly one ticket: 999-local-only\n`,
    stderr: '',
    exitCode: 1,
  });
  expect(await run([...cli, '--project', 'beta-project', 'lint'])).toEqual({
    stdout: '',
    stderr: '',
    exitCode: 0,
  });
}, 20_000);

describe('read-only commands', () => {
  test('uses createProgram configured cwd for Git project selection', async () => {
    const repository = await mkdtemp(
      join(temporaryDirectory, 'read-configured-cwd-')
    );
    const workspace = join(repository, 'workspace');
    const projectPath = join(workspace, 'configured-project');
    const statusPath = join(projectPath, 'todo');
    await mkdir(statusPath, { recursive: true });
    await writeFile(
      join(projectPath, 'project.md'),
      '---\nDefault-Status: todo\nGit-Repo: https://configured.example/owner/repo.git\n---\n'
    );
    await git(repository, ['init']);
    await git(repository, [
      'remote',
      'add',
      'origin',
      'https://configured.example/owner/repo.git',
    ]);

    const output = await captureProcessOutput(async () => {
      await createProgram({ cwd: repository }).parseAsync([
        'node',
        'tickets',
        '--workspace',
        workspace,
        'status',
        'list',
      ]);
    });
    expect(output).toEqual({
      stdout: `todo\t${statusPath}\n`,
      stderr: '',
      exitCode: undefined,
    });
  });

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
  }, 15_000);

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

describe('resource creation commands', () => {
  test('creates default and custom projects and reports only their paths', async () => {
    const workspace = join(temporaryDirectory, 'create-projects');
    const defaultPath = join(workspace, 'default-project');
    const customPath = join(workspace, 'custom-project');

    expect(
      await run([
        'bun',
        'src/cli.ts',
        '--workspace',
        workspace,
        'project',
        'create',
        'default-project',
      ])
    ).toEqual({ stdout: `${defaultPath}\n`, stderr: '', exitCode: 0 });
    expect(
      await run([
        'bun',
        'src/cli.ts',
        '--workspace',
        workspace,
        'project',
        'create',
        'custom-project',
        '--default-status',
        'backlog',
      ])
    ).toEqual({ stdout: `${customPath}\n`, stderr: '', exitCode: 0 });
    expect(await readFile(join(customPath, 'project.md'), 'utf8')).toBe(
      '---\nDefault-Status: backlog\nGit-Repo:\n---\n'
    );
  });

  test('creates a status and fully populated ticket in an explicit project', async () => {
    const workspace = join(temporaryDirectory, 'create-resources');
    const projectPath = join(workspace, 'alpha-project');
    await run([
      'bun',
      'src/cli.ts',
      '--workspace',
      workspace,
      'project',
      'create',
      'alpha-project',
    ]);

    const statusPath = join(projectPath, 'review');
    expect(
      await run([
        'bun',
        'src/cli.ts',
        '--workspace',
        workspace,
        '--project',
        'alpha-project',
        'status',
        'create',
        'review',
      ])
    ).toEqual({ stdout: `${statusPath}\n`, stderr: '', exitCode: 0 });

    const ticketPath = join(statusPath, '001-add-resource.md');
    expect(
      await run([
        'bun',
        'src/cli.ts',
        '--workspace',
        workspace,
        '--project',
        'alpha-project',
        'create',
        'add-resource',
        '--status',
        'review',
        '--assign',
        'agent-one',
        '--tag',
        'feature',
        'cli',
        '--parent',
        'other-project/001-parent',
        '--blocked-by',
        '002-blocker',
        'other-project/003-blocker',
      ])
    ).toEqual({ stdout: `${ticketPath}\n`, stderr: '', exitCode: 0 });
    expect(await readFile(ticketPath, 'utf8')).toBe(
      [
        '---',
        'Assigned-To: agent-one',
        'Tags:',
        '  - feature',
        '  - cli',
        'Parent: other-project/001-parent',
        'Blocked-By:',
        '  - 002-blocker',
        '  - other-project/003-blocker',
        '---',
        '',
      ].join('\n')
    );
  });

  test('discovers the project from Git for status and ticket creation', async () => {
    const workspace = join(temporaryDirectory, 'discovered-creation');
    const projectPath = join(workspace, 'discovered-project');
    const repository = join(temporaryDirectory, 'creation-repository');
    await run([
      'bun',
      'src/cli.ts',
      '--workspace',
      workspace,
      'project',
      'create',
      'discovered-project',
    ]);
    await writeFile(
      join(projectPath, 'project.md'),
      '---\nDefault-Status: todo\nGit-Repo: https://example.com/owner/repo.git\n---\n'
    );
    await mkdir(repository);
    expect(await run(['git', 'init'], { cwd: repository })).toMatchObject({
      exitCode: 0,
    });
    expect(
      await run(
        ['git', 'remote', 'add', 'origin', 'git@example.com:owner/repo.git'],
        { cwd: repository }
      )
    ).toMatchObject({ exitCode: 0 });

    const cli = ['bun', resolve(repositoryRoot, 'src/cli.ts'), '--workspace'];
    expect(
      await run([...cli, workspace, 'status', 'create', 'review'], {
        cwd: repository,
      })
    ).toEqual({
      stdout: `${join(projectPath, 'review')}\n`,
      stderr: '',
      exitCode: 0,
    });
    expect(
      await run([...cli, workspace, 'create', 'discovered-ticket'], {
        cwd: repository,
      })
    ).toEqual({
      stdout: `${join(projectPath, 'todo', '001-discovered-ticket.md')}\n`,
      stderr: '',
      exitCode: 0,
    });
  });

  test('creation failures emit no stdout and exit 2 without overwriting', async () => {
    const workspace = join(temporaryDirectory, 'create-failures');
    const command = [
      'bun',
      'src/cli.ts',
      '--workspace',
      workspace,
      'project',
      'create',
      'alpha-project',
    ];
    expect((await run(command)).exitCode).toBe(0);
    const original = await readFile(
      join(workspace, 'alpha-project', 'project.md'),
      'utf8'
    );

    expect(await run(command)).toEqual({
      stdout: '',
      stderr: `Resource already exists: ${join(workspace, 'alpha-project')}\n`,
      exitCode: 2,
    });
    expect(
      await readFile(join(workspace, 'alpha-project', 'project.md'), 'utf8')
    ).toBe(original);

    expect(
      await run(
        [
          'bun',
          resolve(repositoryRoot, 'src/cli.ts'),
          '--workspace',
          workspace,
          'create',
          'missing-selection',
        ],
        { cwd: temporaryDirectory }
      )
    ).toEqual({
      stdout: '',
      stderr:
        'Cannot discover a project: the current directory is not in a Git worktree; use --project.\n',
      exitCode: 2,
    });

    expect(
      await run([
        'bun',
        'src/cli.ts',
        '--workspace',
        workspace,
        '--project',
        'alpha-project',
        'create',
        'bad-status',
        '--status',
        'missing',
      ])
    ).toEqual({
      stdout: '',
      stderr: 'Status not found: missing\n',
      exitCode: 2,
    });
  });
});

describe.each([
  ['Bun entry point', () => ['bun', 'tests/fixtures/interactive-cli.ts']],
  ['native executable', () => [interactiveExecutablePath]],
])('%s interactive prompt', (_name, getCommand) => {
  test('a decline preserves the skill and exits successfully', async () => {
    const target = join(temporaryDirectory, `${_name}-decline`, 'tickets');
    const installedPath = join(target, 'SKILL.md');
    await mkdir(target, { recursive: true });
    await writeFile(installedPath, 'keep me');

    expect(
      await run([...getCommand(), 'skill', 'install', '--target', target], {
        stdin: '\n',
      })
    ).toEqual({
      stdout: '',
      stderr: `${installedPath} already exists. Overwrite? [y/N] `,
      exitCode: 0,
    });
    expect(await readFile(installedPath, 'utf8')).toBe('keep me');
  });

  test('a confirmation replaces the skill', async () => {
    const target = join(temporaryDirectory, `${_name}-confirm`, 'tickets');
    const installedPath = join(target, 'SKILL.md');
    await mkdir(target, { recursive: true });
    await writeFile(installedPath, 'old skill');

    expect(
      await run([...getCommand(), 'skill', 'install', '--target', target], {
        stdin: 'yes\n',
      })
    ).toEqual({
      stdout: `${installedPath}\n`,
      stderr: `${installedPath} already exists. Overwrite? [y/N] `,
      exitCode: 0,
    });
    expect(await readFile(installedPath)).toEqual(await readFile(assetPath));
  });
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

describe('ticket mutation commands', () => {
  test('renames cross-workspace references and shares idempotent completion between done and move', async () => {
    const workspace = join(temporaryDirectory, 'mutation-cli-workspace');
    const alphaTodo = join(workspace, 'alpha-project', 'todo');
    const betaTodo = join(workspace, 'beta-project', 'todo');
    await Promise.all([
      mkdir(alphaTodo, { recursive: true }),
      mkdir(betaTodo, { recursive: true }),
    ]);
    await writeFile(
      join(alphaTodo, '001-original.md'),
      '---\nAssigned-To: pi\nBlocked-By: [999-recorded]\n---\nTarget\r\n'
    );
    await writeFile(
      join(betaTodo, '001-dependent.md'),
      '---\nParent: alpha-project/001-original\nBlocked-By: [alpha-project/001-original]\n---\n'
    );
    const base = ['bun', 'src/cli.ts', '--workspace', workspace];
    const renamedPath = join(alphaTodo, '001-renamed.md');

    expect(
      await run([
        ...base,
        '--project',
        'alpha-project',
        'rename',
        '001-original',
        'renamed',
      ])
    ).toEqual({ stdout: `${renamedPath}\n`, stderr: '', exitCode: 0 });
    expect(await readFile(join(betaTodo, '001-dependent.md'), 'utf8')).toBe(
      '---\nParent: alpha-project/001-renamed\nBlocked-By:\n  - alpha-project/001-renamed\n---\n'
    );

    const donePath = join(workspace, 'alpha-project', 'done', '001-renamed.md');
    expect(await run([...base, 'done', 'alpha-project/001-renamed'])).toEqual({
      stdout: `${donePath}\n`,
      stderr: '',
      exitCode: 0,
    });
    expect(await readFile(donePath, 'utf8')).toBe(
      '---\nAssigned-To: pi\nBlocked-By: [999-recorded]\n---\nTarget\r\n'
    );
    expect(await readFile(join(betaTodo, '001-dependent.md'), 'utf8')).toBe(
      '---\nParent: alpha-project/001-renamed\nBlocked-By: []\n---\n'
    );

    await writeFile(
      join(betaTodo, '002-late.md'),
      '---\nBlocked-By: [alpha-project/001-renamed]\n---\n'
    );
    expect(
      await run([...base, 'move', 'alpha-project/001-renamed', 'done'])
    ).toEqual({ stdout: `${donePath}\n`, stderr: '', exitCode: 0 });
    expect(await readFile(join(betaTodo, '002-late.md'), 'utf8')).toBe(
      '---\nBlocked-By: []\n---\n'
    );

    expect(
      await run([...base, 'move', 'alpha-project/001-renamed', 'todo'])
    ).toEqual({
      stdout: `${join(alphaTodo, '001-renamed.md')}\n`,
      stderr: '',
      exitCode: 0,
    });
    expect(await readFile(join(betaTodo, '002-late.md'), 'utf8')).toBe(
      '---\nBlocked-By: []\n---\n'
    );
  });

  test('reports sorted cleanup failures with no stdout and keeps successful changes', async () => {
    const workspace = join(temporaryDirectory, 'mutation-cli-partial');
    const todo = join(workspace, 'alpha-project', 'todo');
    await mkdir(todo, { recursive: true });
    await writeFile(join(todo, '001-old.md'), '---\nBlocked-By: []\n---\n');
    await writeFile(
      join(todo, '002-updated.md'),
      '---\nParent: 001-old\nBlocked-By: []\n---\n'
    );
    const malformed = join(todo, '003-malformed.md');
    await writeFile(malformed, 'malformed\n');

    expect(
      await run([
        'bun',
        'src/cli.ts',
        '--workspace',
        workspace,
        '--project',
        'alpha-project',
        'rename',
        '001-old',
        'new-name',
      ])
    ).toEqual({
      stdout: '',
      stderr: `${malformed}\tYAML front matter is missing or not delimited correctly\n`,
      exitCode: 2,
    });
    expect(await Bun.file(join(todo, '001-new-name.md')).exists()).toBe(true);
    expect(await readFile(join(todo, '002-updated.md'), 'utf8')).toBe(
      '---\nParent: 001-new-name\nBlocked-By: []\n---\n'
    );
  });

  test('reports completion cleanup failures after preserving visible partial changes', async () => {
    const workspace = join(temporaryDirectory, 'completion-cli-partial');
    const todo = join(workspace, 'alpha-project', 'todo');
    await mkdir(todo, { recursive: true });
    const source = '---\nAssigned-To: pi\nBlocked-By: []\n---\nExact\r\n';
    await writeFile(join(todo, '001-finish.md'), source);
    await writeFile(
      join(todo, '002-dependent.md'),
      '---\nBlocked-By: [001-finish]\n---\n'
    );
    const malformed = join(todo, '003-malformed.md');
    await writeFile(malformed, 'malformed\n');

    expect(
      await run([
        'bun',
        'src/cli.ts',
        '--workspace',
        workspace,
        '--project',
        'alpha-project',
        'done',
        '001-finish',
      ])
    ).toEqual({
      stdout: '',
      stderr: `${malformed}\tYAML front matter is missing or not delimited correctly\n`,
      exitCode: 2,
    });
    expect(
      await readFile(
        join(workspace, 'alpha-project', 'done', '001-finish.md'),
        'utf8'
      )
    ).toBe(source);
    expect(await readFile(join(todo, '002-dependent.md'), 'utf8')).toBe(
      '---\nBlocked-By: []\n---\n'
    );
  });

  test('rejects invalid mutation arguments with deterministic CLI failures', async () => {
    expect(await run(['bun', 'src/cli.ts', 'done', 'BAD'])).toEqual({
      stdout: '',
      stderr: 'Invalid ticket reference: BAD\n',
      exitCode: 2,
    });
    expect(
      await run(['bun', 'src/cli.ts', 'rename', '001-valid', 'Not-valid'])
    ).toEqual({
      stdout: '',
      stderr: 'Invalid ticket description name: Not-valid\n',
      exitCode: 2,
    });
  });
});
