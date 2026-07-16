import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectProjectForCli } from '../src/cli.ts';
import {
  normalizeRemote,
  selectProject,
  type ProjectRepository,
} from '../src/git.ts';
import { formatProjectSelectionFailure } from '../src/output.ts';

let temporaryDirectory: string;
let repository: string;

async function git(arguments_: string[], cwd = repository): Promise<string> {
  const process = Bun.spawn(['git', '-C', cwd, ...arguments_], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout.trim();
}

async function setOrigin(remote: string): Promise<void> {
  await git(['remote', 'add', 'origin', remote]);
}

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'tickets-git-'));
  repository = join(temporaryDirectory, 'worktree');
  await mkdir(repository);
  await git(['init']);
});

afterEach(async () => {
  await rm(temporaryDirectory, { force: true, recursive: true });
});

describe('remote normalization', () => {
  const normalizationCases: [string, string][] = [
    ['https://user@example.com/Owner/Repo.git', 'example.com/owner/repo'],
    ['ssh://git@example.com/Owner/Repo', 'example.com/owner/repo'],
    ['git@example.com:Owner/Repo.git', 'example.com/owner/repo'],
    ['HTTPS://EXAMPLE.COM//Owner/Repo.git/', 'example.com/owner/repo'],
    ['ssh://git@example.com:22/Owner/Repo.git', 'example.com/owner/repo'],
    ['git://example.com:9418/Owner/Repo.git', 'example.com/owner/repo'],
    [
      'ssh://git@example.com:2222/Owner/Repo.git',
      'example.com:2222/owner/repo',
    ],
    ['https://example.com:8443/Owner/Repo', 'example.com:8443/owner/repo'],
    ['git@example.com:Owner/Repo ', 'example.com/owner/repo '],
  ];
  for (const [remote, expected] of normalizationCases) {
    test(`normalizes ${remote}`, () => {
      expect(normalizeRemote(remote)).toBe(expected);
    });
  }

  const invalidRemotes = [
    '',
    '/home/user/repo',
    'example.com/owner/repo',
    'file:///home/user/repo',
    'https://example.com',
    'https://example.com/.git',
    'https://example.com/owner/repo?ref=main',
  ];
  for (const remote of invalidRemotes) {
    test(`rejects invalid host/path remote ${remote}`, () => {
      expect(normalizeRemote(remote)).toBeUndefined();
    });
  }
});

describe('project selection', () => {
  const discoverableOrigins = [
    'https://user@example.com/Owner/Repo.git',
    'ssh://git@example.com/Owner/Repo',
    'git@example.com:Owner/Repo.git',
  ];
  for (const origin of discoverableOrigins) {
    test(`discovers a project from a real ${origin} origin`, async () => {
      await setOrigin(origin);
      const nestedDirectory = join(repository, 'packages', 'example');
      await mkdir(nestedDirectory, { recursive: true });

      expect(
        await selectProject({
          cwd: nestedDirectory,
          projects: [
            { name: 'other', gitRepo: 'https://elsewhere.test/owner/repo' },
            {
              name: 'selected',
              gitRepo: 'https://example.com/owner/repo.git',
            },
          ],
        })
      ).toEqual({ ok: true, project: 'selected' });
    });
  }

  test('uses only the origin fetch URL', async () => {
    await git([
      'remote',
      'add',
      'upstream',
      'https://example.com/owner/repo.git',
    ]);

    expect(
      await selectProject({
        cwd: repository,
        projects: [
          { name: 'project', gitRepo: 'https://example.com/owner/repo.git' },
        ],
      })
    ).toEqual({ ok: false, reason: 'missing-origin' });
  });

  test('CLI composition discovers from tracker-provided metadata', async () => {
    await setOrigin('https://example.com/owner/repo.git');

    expect(
      await selectProjectForCli({
        cwd: repository,
        loadProjects: async () => [
          { name: 'selected', gitRepo: 'git@example.com:OWNER/REPO.git' },
        ],
      })
    ).toEqual({ ok: true, project: 'selected' });
  });

  test('an explicit CLI project bypasses Git and project metadata loading', async () => {
    expect(
      await selectProjectForCli({
        cwd: join(temporaryDirectory, 'does-not-exist'),
        explicitProject: 'chosen-project',
        loadProjects: () => {
          throw new Error('Project metadata must not be loaded');
        },
      })
    ).toEqual({ ok: true, project: 'chosen-project' });
  });

  test('does not conflate an SCP repository path ending in whitespace', async () => {
    await setOrigin('git@example.com:owner/repo ');

    expect(
      await selectProject({
        cwd: repository,
        projects: [
          { name: 'without-space', gitRepo: 'git@example.com:owner/repo' },
          { name: 'with-space', gitRepo: 'git@example.com:owner/repo ' },
        ],
      })
    ).toEqual({ ok: true, project: 'with-space' });
  });

  test('supports a worktree path ending in whitespace', async () => {
    const spacedRepository = join(temporaryDirectory, 'worktree-with-space ');
    await mkdir(spacedRepository);
    await git(['init'], spacedRepository);
    await git(
      ['remote', 'add', 'origin', 'https://example.com/owner/repo.git'],
      spacedRepository
    );

    expect(
      await selectProject({
        cwd: spacedRepository,
        projects: [
          { name: 'selected', gitRepo: 'https://example.com/owner/repo' },
        ],
      })
    ).toEqual({ ok: true, project: 'selected' });
  });

  test('reports an operational Git inspection error on one line', async () => {
    const missingDirectory = join(temporaryDirectory, 'does-not-exist');
    const detail = `fatal: cannot change to '${missingDirectory}': No such file or directory`;
    const outcome = await selectProject({
      cwd: missingDirectory,
      projects: [],
    });

    expect(outcome).toEqual({
      ok: false,
      reason: 'git-error',
      operation: 'inspect-worktree',
      detail,
    });
    if (outcome.ok) throw new Error('Expected project discovery to fail');
    expect(formatProjectSelectionFailure(outcome)).toBe(
      `Cannot discover a project: Git could not inspect the current worktree (${JSON.stringify(detail)}); use --project.`
    );
  });

  test('fails clearly in a bare repository because it has no worktree', async () => {
    const bareRepository = join(temporaryDirectory, 'bare.git');
    await mkdir(bareRepository);
    await git(['init', '--bare'], bareRepository);
    const outcome = await selectProject({ cwd: bareRepository, projects: [] });

    expect(outcome).toEqual({ ok: false, reason: 'not-a-worktree' });
    if (outcome.ok) throw new Error('Expected project discovery to fail');
    expect(formatProjectSelectionFailure(outcome)).toBe(
      'Cannot discover a project: the current directory is not in a Git worktree; use --project.'
    );
  });

  test('fails outside a worktree and directs the caller to --project', async () => {
    const outside = join(temporaryDirectory, 'outside');
    await mkdir(outside);
    const outcome = await selectProject({ cwd: outside, projects: [] });

    expect(outcome).toEqual({ ok: false, reason: 'not-a-worktree' });
    if (outcome.ok) throw new Error('Expected project discovery to fail');
    expect(formatProjectSelectionFailure(outcome)).toBe(
      'Cannot discover a project: the current directory is not in a Git worktree; use --project.'
    );
  });

  test('fails when the worktree has no origin', async () => {
    const outcome = await selectProject({ cwd: repository, projects: [] });

    expect(outcome).toEqual({ ok: false, reason: 'missing-origin' });
    if (outcome.ok) throw new Error('Expected project discovery to fail');
    expect(formatProjectSelectionFailure(outcome)).toBe(
      'Cannot discover a project: the Git worktree has no origin fetch URL; use --project.'
    );
  });

  test('fails when origin is not a valid remote', async () => {
    await setOrigin('not-a-remote');
    const outcome = await selectProject({ cwd: repository, projects: [] });

    expect(outcome).toEqual({
      ok: false,
      reason: 'invalid-origin',
      origin: 'not-a-remote',
    });
    if (outcome.ok) throw new Error('Expected project discovery to fail');
    expect(formatProjectSelectionFailure(outcome)).toBe(
      'Cannot discover a project: origin has an invalid remote ("not-a-remote"); use --project.'
    );
  });

  test('fails when no valid project remote matches', async () => {
    await setOrigin('https://example.com/owner/repo.git');
    const projects: ProjectRepository[] = [
      { name: 'missing-metadata' },
      { name: 'invalid-metadata', gitRepo: 'not-a-remote' },
      { name: 'different', gitRepo: 'https://example.com/owner/other.git' },
    ];
    const outcome = await selectProject({ cwd: repository, projects });

    expect(outcome).toEqual({
      ok: false,
      reason: 'no-match',
      origin: 'example.com/owner/repo',
    });
    if (outcome.ok) throw new Error('Expected project discovery to fail');
    expect(formatProjectSelectionFailure(outcome)).toBe(
      'Cannot discover a project: no project matches origin "example.com/owner/repo"; use --project.'
    );
  });

  test('fails on ambiguity and names every matching project', async () => {
    await setOrigin('git@example.com:Owner/Repo.git');
    const outcome = await selectProject({
      cwd: repository,
      projects: [
        { name: 'zulu', gitRepo: 'ssh://git@example.com/owner/repo' },
        { name: 'alpha', gitRepo: 'https://example.com/OWNER/REPO.git' },
      ],
    });

    expect(outcome).toEqual({
      ok: false,
      reason: 'ambiguous',
      origin: 'example.com/owner/repo',
      projects: ['alpha', 'zulu'],
    });
    if (outcome.ok) throw new Error('Expected project discovery to fail');
    expect(formatProjectSelectionFailure(outcome)).toBe(
      'Cannot discover a project: origin "example.com/owner/repo" matches multiple projects (alpha, zulu); use --project.'
    );
  });
});
