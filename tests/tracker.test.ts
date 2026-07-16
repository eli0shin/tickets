import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLintWorkspace } from './fixtures/lint-workspace.ts';
import {
  createTracker,
  isNormalizedName,
  isTicketReference,
  parseTicketName,
  type Project,
  type Ticket,
} from '../src/tracker/index.ts';

const temporaryDirectories: string[] = [];

async function temporaryWorkspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'tickets-tracker-'));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function discoverProject(
  workspaceRoot: string,
  name = 'alpha-project'
): Promise<{
  tracker: ReturnType<typeof createTracker>;
  project: Project;
}> {
  const tracker = createTracker(workspaceRoot);
  const discovery = await tracker.discoverProjects();
  const project = discovery.entries.find((entry) => entry.name === name);
  if (project === undefined) throw new Error(`Project ${name} was not found`);
  return { tracker, project };
}

async function discoverTicket(
  workspaceRoot: string,
  projectName = 'alpha-project',
  statusName = 'todo'
): Promise<{
  tracker: ReturnType<typeof createTracker>;
  project: Project;
  ticket: Ticket;
}> {
  const { tracker, project } = await discoverProject(
    workspaceRoot,
    projectName
  );
  const statuses = await tracker.discoverStatuses(project.name);
  const status = statuses.entries.find((entry) => entry.name === statusName);
  if (status === undefined)
    throw new Error(`Status ${statusName} was not found`);
  const tickets = await tracker.discoverTickets(project.name, status.name);
  const ticket = tickets.entries[0];
  return { tracker, project, ticket };
}

describe('tracker naming contract', () => {
  test('recognizes normalized resource names', () => {
    expect([
      isNormalizedName('tickets'),
      isNormalizedName('in-progress'),
      isNormalizedName('UPPER'),
      isNormalizedName('-leading'),
      isNormalizedName('two--hyphens'),
    ]).toEqual([true, true, false, false, false]);
  });

  test('parses positive, padded ticket names and references', () => {
    expect(parseTicketName('001-add-search')).toEqual({
      id: 1n,
      name: '001-add-search',
      description: 'add-search',
    });
    expect(parseTicketName('1000-grow-naturally')).toEqual({
      id: 1000n,
      name: '1000-grow-naturally',
      description: 'grow-naturally',
    });
    expect([
      parseTicketName('000-not-positive'),
      parseTicketName('01-too-short'),
      parseTicketName('001-Not-normalized'),
    ]).toEqual([null, null, null]);
    expect([
      isTicketReference('001-add-search'),
      isTicketReference('alpha-project/001-add-search'),
      isTicketReference('Alpha/001-add-search'),
      isTicketReference('alpha/todo/001-add-search'),
    ]).toEqual([true, true, false, false]);
  });
});

describe('tracker filesystem discovery', () => {
  test('discovers valid projects and ignores hidden and unexpected workspace entries', async () => {
    const workspaceRoot = await temporaryWorkspace();
    await Promise.all([
      mkdir(join(workspaceRoot, 'alpha-project')),
      mkdir(join(workspaceRoot, 'empty-project')),
      mkdir(join(workspaceRoot, '.hidden-project')),
      mkdir(join(workspaceRoot, 'Invalid_Project')),
      writeFile(join(workspaceRoot, 'loose-file'), ''),
    ]);

    const tracker = createTracker(workspaceRoot);
    expect(await tracker.discoverProjects()).toEqual({
      entries: [
        {
          name: 'alpha-project',
          path: join(workspaceRoot, 'alpha-project'),
        },
        {
          name: 'empty-project',
          path: join(workspaceRoot, 'empty-project'),
        },
      ],
      diagnostics: [],
    });
  });

  test('discovers empty statuses and ignores hidden and unexpected project entries', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const projectPath = join(workspaceRoot, 'alpha-project');
    await mkdir(join(projectPath, 'todo'), { recursive: true });
    await mkdir(join(projectPath, 'in-progress'));
    await mkdir(join(projectPath, '.hidden-status'));
    await mkdir(join(projectPath, 'Invalid_Status'));
    await writeFile(join(projectPath, 'project.md'), 'metadata');
    await writeFile(join(projectPath, 'unexpected.txt'), 'unexpected');

    const { tracker, project } = await discoverProject(workspaceRoot);
    expect(await tracker.discoverStatuses(project.name)).toEqual({
      entries: [
        {
          name: 'in-progress',
          path: join(projectPath, 'in-progress'),
          project,
        },
        {
          name: 'todo',
          path: join(projectPath, 'todo'),
          project,
        },
      ],
      diagnostics: [],
    });
  });

  test('discovers valid ticket files in ID order and ignores hidden and unexpected entries', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const statusPath = join(workspaceRoot, 'alpha-project', 'todo');
    await mkdir(statusPath, { recursive: true });
    await Promise.all([
      writeFile(join(statusPath, '010-later.md'), ''),
      writeFile(join(statusPath, '002-earlier.md'), ''),
      writeFile(join(statusPath, '1000-large-id.md'), ''),
      writeFile(join(statusPath, '9007199254740993-largest-id.md'), ''),
      writeFile(join(statusPath, '9007199254740992-larger-id.md'), ''),
      writeFile(join(statusPath, '.003-hidden.md'), ''),
      writeFile(join(statusPath, '01-short.md'), ''),
      writeFile(join(statusPath, '000-zero.md'), ''),
      writeFile(join(statusPath, '004-wrong-extension.txt'), ''),
      mkdir(join(statusPath, '005-directory.md')),
    ]);

    const { tracker, project } = await discoverProject(workspaceRoot);
    const statuses = await tracker.discoverStatuses(project.name);
    const status = statuses.entries[0];

    expect(await tracker.discoverTickets(project.name, status.name)).toEqual({
      entries: [
        {
          id: 2n,
          name: '002-earlier',
          description: 'earlier',
          path: join(statusPath, '002-earlier.md'),
          status,
        },
        {
          id: 10n,
          name: '010-later',
          description: 'later',
          path: join(statusPath, '010-later.md'),
          status,
        },
        {
          id: 1000n,
          name: '1000-large-id',
          description: 'large-id',
          path: join(statusPath, '1000-large-id.md'),
          status,
        },
        {
          id: 9007199254740992n,
          name: '9007199254740992-larger-id',
          description: 'larger-id',
          path: join(statusPath, '9007199254740992-larger-id.md'),
          status,
        },
        {
          id: 9007199254740993n,
          name: '9007199254740993-largest-id',
          description: 'largest-id',
          path: join(statusPath, '9007199254740993-largest-id.md'),
          status,
        },
      ],
      diagnostics: [],
    });
  });

  test('derives resource paths from validated names within its workspace', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const outsideRoot = await temporaryWorkspace();
    await writeFile(
      join(outsideRoot, 'project.md'),
      '---\nDefault-Status: todo\n---\nOutside\n'
    );
    const tracker = createTracker(workspaceRoot);
    const traversal = `../${basename(outsideRoot)}`;

    expect(await tracker.readProject(traversal)).toEqual({
      ok: false,
      diagnostic: {
        path: workspaceRoot,
        code: 'invalid-name',
        message: `Invalid project name: ${traversal}`,
      },
    });
    expect(await tracker.discoverStatuses('../outside')).toEqual({
      entries: [],
      diagnostics: [
        {
          path: workspaceRoot,
          code: 'invalid-name',
          message: 'Invalid project name: ../outside',
        },
      ],
    });
  });

  test('returns filesystem failures as structured discovery diagnostics', async () => {
    const workspaceRoot = join(await temporaryWorkspace(), 'missing');
    const tracker = createTracker(workspaceRoot);
    const outcome = await tracker.discoverProjects();

    expect(outcome.entries).toEqual([]);
    expect(outcome.diagnostics).toHaveLength(1);
    expect(outcome.diagnostics[0]?.path).toBe(workspaceRoot);
    expect(outcome.diagnostics[0]?.code).toBe('filesystem-error');
    expect(outcome.diagnostics[0]?.message.includes('ENOENT')).toBe(true);
  });
});

describe('tracker project lint', () => {
  test('reports the exact violation catalog through real workspace files', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const cases = await createLintWorkspace(workspaceRoot);
    const tracker = createTracker(workspaceRoot);
    let observedCodes = new Set<string>();
    const preservedPaths = [
      join(workspaceRoot, 'clean-project', 'todo', '001-clean.md'),
      join(workspaceRoot, 'ticket-errors', 'todo', '003-malformed.md'),
    ];
    const before = await Promise.all(
      preservedPaths.map((path) => readFile(path, 'utf8'))
    );

    for (const lintCase of cases) {
      const result = await tracker.lintProject(lintCase.project);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.diagnostic.message);
      const actualCodes = result.violations.map((violation) => violation.code);
      observedCodes = new Set([...observedCodes, ...actualCodes]);
      expect(actualCodes.toSorted()).toEqual([...lintCase.codes].toSorted());
      expect(
        result.violations.every((violation) =>
          violation.path.startsWith(join(workspaceRoot, lintCase.project))
        )
      ).toBe(true);
      expect(result.violations).toEqual(
        result.violations.toSorted(
          (left, right) =>
            left.path.localeCompare(right.path) ||
            left.code.localeCompare(right.code) ||
            left.message.localeCompare(right.message)
        )
      );
    }

    expect(
      await Promise.all(preservedPaths.map((path) => readFile(path, 'utf8')))
    ).toEqual(before);
    expect([...observedCodes].toSorted()).toEqual(
      [
        'unexpected-project-entry',
        'unexpected-status-entry',
        'missing-project-metadata',
        'malformed-project-yaml',
        'duplicate-project-key',
        'missing-default-status',
        'invalid-default-status',
        'missing-default-status-directory',
        'invalid-git-repo',
        'malformed-ticket-yaml',
        'duplicate-ticket-key',
        'invalid-assigned-to',
        'invalid-tags',
        'invalid-parent',
        'invalid-blocked-by',
        'duplicate-ticket-id',
        'broken-parent-reference',
        'broken-blocker-reference',
        'duplicate-git-repo',
      ].toSorted()
    );
  });

  test('reads symlinked project metadata and ignores unrelated symlinks', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const projectPath = join(workspaceRoot, 'symlinked-project');
    const metadataPath = join(workspaceRoot, 'project-metadata.md');
    await mkdir(join(projectPath, 'todo'), { recursive: true });
    await writeFile(
      metadataPath,
      '---\nDefault-Status: todo\nGit-Repo:\n---\n'
    );
    await Promise.all([
      symlink('../project-metadata.md', join(projectPath, 'project.md')),
      symlink(metadataPath, join(projectPath, 'unrelated-link')),
    ]);

    const result =
      await createTracker(workspaceRoot).lintProject('symlinked-project');

    expect(result).toEqual({ ok: true, violations: [] });
  });

  test('detects a duplicate repository in symlinked peer metadata', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const selectedPath = join(workspaceRoot, 'selected-project');
    const peerPath = join(workspaceRoot, 'peer-project');
    const peerMetadataPath = join(workspaceRoot, 'peer-metadata.md');
    const metadata =
      '---\nDefault-Status: todo\nGit-Repo: https://example.com/owner/repo.git\n---\n';
    await Promise.all([
      mkdir(join(selectedPath, 'todo'), { recursive: true }),
      mkdir(join(peerPath, 'todo'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(selectedPath, 'project.md'), metadata),
      writeFile(peerMetadataPath, metadata),
    ]);
    await symlink('../peer-metadata.md', join(peerPath, 'project.md'));

    const result =
      await createTracker(workspaceRoot).lintProject('selected-project');

    expect(result).toEqual({
      ok: true,
      violations: [
        {
          path: join(selectedPath, 'project.md'),
          code: 'duplicate-git-repo',
          message: 'Git-Repo is also declared by: peer-project',
        },
      ],
    });
  });

  test('returns invocation and filesystem failures outside the finding catalog', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const tracker = createTracker(workspaceRoot);

    expect(await tracker.lintProject('../outside')).toEqual({
      ok: false,
      diagnostic: {
        path: workspaceRoot,
        code: 'invalid-name',
        message: 'Invalid project name: ../outside',
      },
    });
    const missing = await tracker.lintProject('missing-project');
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error('Expected a filesystem failure');
    expect(missing.diagnostic.code).toBe('filesystem-error');
  });
});

describe('tracker read-only queries', () => {
  test('treats lint-clean quoted empty assignment and parent as absent', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const projectPath = join(workspaceRoot, 'alpha-project');
    const statusPath = join(projectPath, 'todo');
    const ticketPath = join(statusPath, '001-empty-values.md');
    await mkdir(statusPath, { recursive: true });
    await writeFile(
      join(projectPath, 'project.md'),
      '---\nDefault-Status: todo\nGit-Repo:\n---\n'
    );
    await writeFile(
      ticketPath,
      '---\nAssigned-To: ""\nTags: []\nParent: ""\nBlocked-By: []\n---\n'
    );

    const tracker = createTracker(workspaceRoot);
    expect(await tracker.lintProject('alpha-project')).toEqual({
      ok: true,
      violations: [],
    });
    expect(await tracker.listTickets('alpha-project', 'todo')).toEqual({
      project: 'alpha-project',
      tickets: [
        {
          id: 1n,
          name: '001-empty-values',
          status: 'todo',
          path: ticketPath,
          assignedTo: null,
          tags: [],
          parent: null,
          blockedBy: [],
        },
      ],
      diagnostics: [],
      fatal: false,
    });
  });

  test('lists and searches real ticket files with defaults, AND criteria, and ID ordering', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const projectPath = join(workspaceRoot, 'alpha-project');
    await mkdir(join(projectPath, 'todo'), { recursive: true });
    await mkdir(join(projectPath, 'done'));
    await writeFile(
      join(projectPath, 'todo', '010-later.md'),
      '---\nAssigned-To: pi\nTags: [task, urgent]\nParent: 001-parent\nBlocked-By: [002-first, 003-second]\n---\nLater\n'
    );
    await writeFile(
      join(projectPath, 'done', '002-earlier.md'),
      '---\nUnknown: retained\n---\nEarlier\n'
    );
    await writeFile(
      join(projectPath, 'todo', '003-middle.md'),
      '---\nAssigned-To:\nTags: [task]\nParent:\nBlocked-By: []\n---\nMiddle\n'
    );

    const tracker = createTracker(workspaceRoot);
    expect(await tracker.listTickets('alpha-project', 'todo')).toEqual({
      project: 'alpha-project',
      tickets: [
        {
          id: 3n,
          name: '003-middle',
          status: 'todo',
          path: join(projectPath, 'todo', '003-middle.md'),
          assignedTo: null,
          tags: ['task'],
          parent: null,
          blockedBy: [],
        },
        {
          id: 10n,
          name: '010-later',
          status: 'todo',
          path: join(projectPath, 'todo', '010-later.md'),
          assignedTo: 'pi',
          tags: ['task', 'urgent'],
          parent: '001-parent',
          blockedBy: ['002-first', '003-second'],
        },
      ],
      diagnostics: [],
      fatal: false,
    });

    const all = await tracker.searchTickets('alpha-project');
    expect(all.tickets.map((ticket) => ticket.name)).toEqual([
      '002-earlier',
      '003-middle',
      '010-later',
    ]);
    expect(all.tickets[0]).toEqual({
      id: 2n,
      name: '002-earlier',
      status: 'done',
      path: join(projectPath, 'done', '002-earlier.md'),
      assignedTo: null,
      tags: [],
      parent: null,
      blockedBy: [],
    });
    expect(
      (
        await tracker.searchTickets('alpha-project', {
          statuses: ['todo'],
          tags: ['task', 'urgent'],
          assignedTo: ['pi'],
          parents: ['001-parent'],
          blockedBy: ['002-first', '003-second'],
        })
      ).tickets.map((ticket) => ticket.name)
    ).toEqual(['010-later']);
    expect(
      (
        await tracker.searchTickets('alpha-project', {
          unassigned: true,
          unblocked: true,
        })
      ).tickets.map((ticket) => ticket.name)
    ).toEqual(['002-earlier', '003-middle']);
    expect(
      (
        await tracker.searchTickets('alpha-project', {
          tags: ['task', 'missing'],
        })
      ).tickets
    ).toEqual([]);
  });

  test('retains valid results and deterministically reports malformed ticket files', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const statusPath = join(workspaceRoot, 'alpha-project', 'todo');
    await mkdir(statusPath, { recursive: true });
    await writeFile(join(statusPath, '001-valid.md'), '---\nTags: []\n---\n');
    await writeFile(
      join(statusPath, '002-invalid-field.md'),
      '---\nTags: not-an-array\n---\n'
    );
    await writeFile(
      join(statusPath, '003-malformed.md'),
      '---\nTags: [broken\n---\n'
    );

    const result = await createTracker(workspaceRoot).listTickets(
      'alpha-project',
      'todo'
    );
    expect(result.tickets.map((ticket) => ticket.name)).toEqual(['001-valid']);
    expect(
      result.diagnostics.map(({ path, code }) => ({ path, code }))
    ).toEqual([
      {
        path: join(statusPath, '002-invalid-field.md'),
        code: 'invalid-ticket-metadata',
      },
      {
        path: join(statusPath, '003-malformed.md'),
        code: 'malformed-ticket-yaml',
      },
    ]);
  });

  test('shows unchanged local and cross-project tickets and rejects ambiguous references', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const source = '---\r\nTags: []\r\n---\r\nExact body\r\n';
    await mkdir(join(workspaceRoot, 'alpha-project', 'todo'), {
      recursive: true,
    });
    await mkdir(join(workspaceRoot, 'beta-project', 'done'), {
      recursive: true,
    });
    await writeFile(
      join(workspaceRoot, 'beta-project', 'done', '001-exact.md'),
      source
    );
    const tracker = createTracker(workspaceRoot);
    expect(await tracker.showTicket('../outside', '001-exact')).toEqual({
      ok: false,
      diagnostic: {
        path: workspaceRoot,
        code: 'invalid-name',
        message: 'Invalid project name: ../outside',
      },
    });
    expect(
      await tracker.showTicket('alpha-project', 'beta-project/001-exact')
    ).toEqual({ ok: true, value: source });

    await mkdir(join(workspaceRoot, 'beta-project', 'todo'));
    await writeFile(
      join(workspaceRoot, 'beta-project', 'todo', '001-exact.md'),
      source
    );
    const ambiguous = await tracker.showTicket('beta-project', '001-exact');
    expect(ambiguous.ok).toBe(false);
    if (ambiguous.ok) throw new Error('Expected ambiguous reference');
    expect(ambiguous.diagnostic.message).toBe(
      'Ticket reference is ambiguous: 001-exact'
    );
  });
});

describe('tracker resource creation', () => {
  test('creates projects with default and overridden status layouts', async () => {
    const workspaceRoot = join(await temporaryWorkspace(), 'new-workspace');
    const tracker = createTracker(workspaceRoot);

    const defaultProject = await tracker.createProject('default-project');
    const customProject = await tracker.createProject('custom-project', {
      defaultStatus: 'backlog',
    });
    expect(defaultProject).toEqual({
      ok: true,
      value: {
        name: 'default-project',
        path: join(workspaceRoot, 'default-project'),
      },
    });
    expect(customProject.ok).toBe(true);
    expect(
      (await tracker.discoverStatuses('default-project')).entries.map(
        ({ name }) => name
      )
    ).toEqual(['done', 'in-progress', 'todo']);
    expect(
      (await tracker.discoverStatuses('custom-project')).entries.map(
        ({ name }) => name
      )
    ).toEqual(['backlog', 'done', 'in-progress']);
    expect(await tracker.readProject('custom-project')).toEqual({
      ok: true,
      value: {
        metadata: { 'Default-Status': 'backlog', 'Git-Repo': null },
        body: '',
      },
    });
  });

  test('deduplicates built-in project statuses and refuses invalid names and collisions', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const tracker = createTracker(workspaceRoot);
    expect(
      await tracker.createProject('active-project', {
        defaultStatus: 'in-progress',
      })
    ).toEqual({
      ok: true,
      value: {
        name: 'active-project',
        path: join(workspaceRoot, 'active-project'),
      },
    });
    expect(
      (await tracker.discoverStatuses('active-project')).entries.map(
        ({ name }) => name
      )
    ).toEqual(['done', 'in-progress']);

    const original = await readFile(
      join(workspaceRoot, 'active-project', 'project.md'),
      'utf8'
    );
    const collision = await tracker.createProject('active-project');
    expect(collision.ok).toBe(false);
    if (collision.ok) throw new Error('Expected project collision');
    expect(collision.diagnostic).toEqual({
      path: join(workspaceRoot, 'active-project'),
      code: 'resource-exists',
      message: `Resource already exists: ${join(
        workspaceRoot,
        'active-project'
      )}`,
    });
    expect(
      await readFile(
        join(workspaceRoot, 'active-project', 'project.md'),
        'utf8'
      )
    ).toBe(original);

    for (const [name, options] of [
      ['Invalid', undefined],
      ['valid-project', { defaultStatus: 'Not-Normal' }],
    ] as const) {
      const outcome = await tracker.createProject(name, options);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('Expected invalid project input');
      expect(outcome.diagnostic.code).toBe('invalid-name');
    }
  });

  test('cleans up failed project creation so it can be retried', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const tracker = createTracker(workspaceRoot);
    const projectName = 'retry-project';

    const failed = await tracker.createProject(projectName, {
      defaultStatus: 'a'.repeat(256),
    });
    expect(failed.ok).toBe(false);
    expect(await readdir(workspaceRoot)).toEqual([]);

    const retried = await tracker.createProject(projectName);
    expect(retried.ok).toBe(true);
    expect(
      (await tracker.discoverStatuses(projectName)).entries.map(
        ({ name }) => name
      )
    ).toEqual(['done', 'in-progress', 'todo']);
  });

  test('creates statuses only in existing projects and never overwrites', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const tracker = createTracker(workspaceRoot);
    await tracker.createProject('alpha-project');

    const created = await tracker.createStatus('alpha-project', 'review');
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.diagnostic.message);
    await writeFile(join(created.value.path, 'keep.txt'), 'keep');

    for (const outcome of [
      await tracker.createStatus('alpha-project', 'review'),
      await tracker.createStatus('alpha-project', 'Not-Normal'),
      await tracker.createStatus('missing-project', 'review'),
    ]) {
      expect(outcome.ok).toBe(false);
    }
    expect(await readFile(join(created.value.path, 'keep.txt'), 'utf8')).toBe(
      'keep'
    );
  });

  test('allocates across statuses without filling ID gaps and writes all metadata', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const tracker = createTracker(workspaceRoot);
    await tracker.createProject('alpha-project', { defaultStatus: 'backlog' });
    await writeFile(
      join(workspaceRoot, 'alpha-project', 'done', '003-old.md'),
      '---\n---\n'
    );
    await writeFile(
      join(workspaceRoot, 'alpha-project', 'backlog', '001-gap.md'),
      '---\n---\n'
    );
    await writeFile(
      join(workspaceRoot, 'alpha-project', '.ticket-id-999-claim'),
      ''
    );

    const created = await tracker.createTicket('alpha-project', {
      description: 'implement-creation',
      assignee: 'agent-one',
      tags: ['feature', 'filesystem'],
      parent: 'other-project/001-parent',
      blockedBy: ['002-local', 'other-project/004-remote'],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.diagnostic.message);
    expect(created.value).toEqual({
      id: 4n,
      name: '004-implement-creation',
      description: 'implement-creation',
      path: join(
        workspaceRoot,
        'alpha-project',
        'backlog',
        '004-implement-creation.md'
      ),
      status: {
        name: 'backlog',
        path: join(workspaceRoot, 'alpha-project', 'backlog'),
        project: {
          name: 'alpha-project',
          path: join(workspaceRoot, 'alpha-project'),
        },
      },
    });
    expect(await readFile(created.value.path, 'utf8')).toBe(
      [
        '---',
        'Assigned-To: agent-one',
        'Tags:',
        '  - feature',
        '  - filesystem',
        'Parent: other-project/001-parent',
        'Blocked-By:',
        '  - 002-local',
        '  - other-project/004-remote',
        '---',
        '',
      ].join('\n')
    );
  });

  test('supports status overrides and empty standard ticket metadata', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const tracker = createTracker(workspaceRoot);
    await tracker.createProject('alpha-project');

    const created = await tracker.createTicket('alpha-project', {
      description: 'empty-metadata',
      status: 'in-progress',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.diagnostic.message);
    expect(created.value.status.name).toBe('in-progress');
    expect(await readFile(created.value.path, 'utf8')).toBe(
      '---\nAssigned-To:\nTags: []\nParent:\nBlocked-By: []\n---\n'
    );
  });

  test('rejects invalid ticket inputs, missing statuses, and malformed project defaults', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const tracker = createTracker(workspaceRoot);
    await tracker.createProject('alpha-project');

    const acceptedValidationCodes = new Set([
      'invalid-name',
      'invalid-reference',
    ]);
    const inputs = [
      { description: 'Invalid' },
      { description: 'valid', status: 'Not-Normal' },
      { description: 'valid', assignee: 'Not-Normal' },
      { description: 'valid', tags: ['Not-Normal'] },
      { description: 'valid', parent: 'bad/reference/shape' },
      { description: 'valid', blockedBy: ['not-a-ticket'] },
    ];
    for (const input of inputs) {
      const outcome = await tracker.createTicket('alpha-project', input);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('Expected invalid ticket input');
      expect(acceptedValidationCodes.has(outcome.diagnostic.code)).toBe(true);
    }

    const missing = await tracker.createTicket('alpha-project', {
      description: 'missing-status',
      status: 'review',
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error('Expected missing status');
    expect(missing.diagnostic.code).toBe('status-not-found');

    await writeFile(
      join(workspaceRoot, 'alpha-project', 'project.md'),
      '---\nDefault-Status: Not-Normal\n---\n'
    );
    const malformedDefault = await tracker.createTicket('alpha-project', {
      description: 'bad-default',
    });
    expect(malformedDefault.ok).toBe(false);
    if (malformedDefault.ok) throw new Error('Expected invalid default status');
    expect(malformedDefault.diagnostic.code).toBe('invalid-status');
  });

  test('does not overwrite a colliding ticket destination', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const tracker = createTracker(workspaceRoot);
    await tracker.createProject('alpha-project');
    const collisionPath = join(
      workspaceRoot,
      'alpha-project',
      'todo',
      '001-collision.md'
    );
    await mkdir(collisionPath);

    const outcome = await tracker.createTicket('alpha-project', {
      description: 'collision',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('Expected ticket collision');
    expect(outcome.diagnostic).toEqual({
      path: collisionPath,
      code: 'resource-exists',
      message: `Resource already exists: ${collisionPath}`,
    });
  });

  test('recovers a stale ticket creation lock after an interrupted process', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const tracker = createTracker(workspaceRoot);
    await tracker.createProject('alpha-project');
    const projectPath = join(workspaceRoot, 'alpha-project');
    const lockPath = join(projectPath, '.ticket-creation-lock');
    await mkdir(lockPath);
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(lockPath, staleTime, staleTime);

    const outcome = await tracker.createTicket('alpha-project', {
      description: 'after-interruption',
    });
    expect(outcome.ok).toBe(true);
    expect((await readdir(projectPath)).toSorted()).toEqual([
      'done',
      'in-progress',
      'project.md',
      'todo',
    ]);
    expect(
      (await tracker.discoverTickets('alpha-project', 'todo')).entries.map(
        ({ id }) => id
      )
    ).toEqual([1n]);
  });

  test('requires a valid declared default status even with an override', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const tracker = createTracker(workspaceRoot);
    await tracker.createProject('alpha-project');
    await writeFile(
      join(workspaceRoot, 'alpha-project', 'project.md'),
      '---\nGit-Repo:\n---\n'
    );

    for (const outcome of [
      await tracker.createStatus('alpha-project', 'review'),
      await tracker.createTicket('alpha-project', {
        description: 'explicit-status',
        status: 'todo',
      }),
    ]) {
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('Expected invalid project metadata');
      expect(outcome.diagnostic.code).toBe('invalid-status');
    }
  });
});

describe('tracker document parsing and canonical writing', () => {
  test('parses project metadata and retains optional and unknown fields semantically', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const projectPath = join(workspaceRoot, 'alpha-project');
    await mkdir(projectPath);
    await writeFile(
      join(projectPath, 'project.md'),
      [
        '---',
        'Default-Status: todo',
        'Git-Repo:',
        'Unknown:',
        '  nested: true',
        '---',
        '# Alpha',
        '',
      ].join('\n')
    );

    const { tracker, project } = await discoverProject(workspaceRoot);
    expect(await tracker.readProject(project.name)).toEqual({
      ok: true,
      value: {
        metadata: {
          'Default-Status': 'todo',
          'Git-Repo': null,
          Unknown: { nested: true },
        },
        body: '# Alpha\n',
      },
    });
  });

  test('reports malformed and duplicate project YAML distinctly', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const malformedPath = join(workspaceRoot, 'malformed', 'project.md');
    const duplicatePath = join(workspaceRoot, 'duplicate', 'project.md');
    await mkdir(join(workspaceRoot, 'malformed'), { recursive: true });
    await mkdir(join(workspaceRoot, 'duplicate'));
    await writeFile(malformedPath, 'Default-Status: todo\n');
    await writeFile(
      duplicatePath,
      '---\nDefault-Status: todo\nDefault-Status: done\n---\n'
    );

    const tracker = createTracker(workspaceRoot);
    const projects = await tracker.discoverProjects();
    const malformed = projects.entries.find(
      (entry) => entry.name === 'malformed'
    );
    const duplicate = projects.entries.find(
      (entry) => entry.name === 'duplicate'
    );
    if (malformed === undefined || duplicate === undefined) {
      throw new Error('Projects were not found');
    }

    expect(await tracker.readProject(malformed.name)).toEqual({
      ok: false,
      diagnostic: {
        path: malformedPath,
        code: 'malformed-project-yaml',
        message: 'YAML front matter is missing or not delimited correctly',
      },
    });
    const duplicateOutcome = await tracker.readProject(duplicate.name);
    expect(duplicateOutcome.ok).toBe(false);
    if (duplicateOutcome.ok) throw new Error('Expected duplicate key failure');
    expect(duplicateOutcome.diagnostic.path).toBe(duplicatePath);
    expect(duplicateOutcome.diagnostic.code).toBe('duplicate-project-key');
    expect(
      duplicateOutcome.diagnostic.message.includes('Map keys must be unique')
    ).toBe(true);
  });

  test('accepts and rewrites comment-only empty ticket metadata', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const statusPath = join(workspaceRoot, 'alpha-project', 'todo');
    const ticketPath = join(statusPath, '001-empty.md');
    await mkdir(statusPath, { recursive: true });
    await writeFile(ticketPath, '---\n# draft\n---\nBody\n');

    const { tracker, ticket } = await discoverTicket(workspaceRoot);
    const outcome = await tracker.readTicket(
      ticket.status.project.name,
      ticket.status.name,
      ticket.name
    );
    expect(outcome).toEqual({
      ok: true,
      value: { metadata: {}, body: 'Body\n' },
    });
    if (!outcome.ok) throw new Error(outcome.diagnostic.message);
    expect(
      await tracker.writeTicket(
        ticket.status.project.name,
        ticket.status.name,
        ticket.name,
        outcome.value
      )
    ).toEqual({ ok: true, value: undefined });
    expect(await readFile(ticketPath, 'utf8')).toBe('---\n{}\n---\nBody\n');
  });

  test('round-trips semantically valid unknown metadata fields', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const statusPath = join(workspaceRoot, 'alpha-project', 'todo');
    const ticketPath = join(statusPath, '001-unknown-fields.md');
    await mkdir(statusPath, { recursive: true });
    await writeFile(
      ticketPath,
      [
        '---',
        'Unknown:',
        '  nested:',
        '    enabled: true',
        '    explicit-float: !!float 1.0',
        '    integer-float: 1.0',
        '    large: 9007199254740993',
        '    negative-zero: -0.0',
        '    values: [one, 2, null]',
        '---',
        'Body',
        '',
      ].join('\n')
    );

    const { tracker, ticket } = await discoverTicket(workspaceRoot);
    const firstRead = await tracker.readTicket(
      ticket.status.project.name,
      ticket.status.name,
      ticket.name
    );
    if (!firstRead.ok) throw new Error(firstRead.diagnostic.message);
    expect(firstRead.value.metadata).toEqual({
      Unknown: {
        nested: {
          enabled: true,
          'explicit-float': 1,
          'integer-float': 1,
          large: 9007199254740993n,
          'negative-zero': -0,
          values: ['one', 2n, null],
        },
      },
    });
    expect(
      await tracker.writeTicket(
        ticket.status.project.name,
        ticket.status.name,
        ticket.name,
        firstRead.value
      )
    ).toEqual({ ok: true, value: undefined });
    expect(
      await tracker.readTicket(
        ticket.status.project.name,
        ticket.status.name,
        ticket.name
      )
    ).toEqual(firstRead);
    const canonical = await readFile(ticketPath, 'utf8');
    expect(canonical.includes('explicit-float: !!float 1.0')).toBe(true);
    expect(canonical.includes('integer-float: 1.0')).toBe(true);
    expect(canonical.includes('negative-zero: -0.0')).toBe(true);
  });

  test('persists in-place nested edits and immutable copies of parsed metadata', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const statusPath = join(workspaceRoot, 'alpha-project', 'todo');
    await mkdir(statusPath, { recursive: true });
    await writeFile(
      join(statusPath, '001-ordinary.md'),
      '---\nUnknown: {nested: {enabled: true}}\n---\n'
    );
    await writeFile(
      join(statusPath, '002-complex.md'),
      [
        '---',
        'Tags: []',
        'Nested: {? [one, two]: value}',
        'Pairs: !!pairs [one: 1]',
        'When: !!timestamp 2002-12-14',
        '---',
        '',
      ].join('\n')
    );

    const tracker = createTracker(workspaceRoot);
    const ordinary = await tracker.readTicket(
      'alpha-project',
      'todo',
      '001-ordinary'
    );
    if (!ordinary.ok) throw new Error(ordinary.diagnostic.message);
    const unknown = ordinary.value.metadata.Unknown;
    if (unknown === null || typeof unknown !== 'object') {
      throw new Error('Expected unknown metadata map');
    }
    const nested: unknown = Reflect.get(unknown, 'nested');
    if (nested === null || typeof nested !== 'object') {
      throw new Error('Expected nested metadata map');
    }
    Reflect.set(nested, 'enabled', false);
    expect(
      await tracker.writeTicket(
        'alpha-project',
        'todo',
        '001-ordinary',
        ordinary.value
      )
    ).toEqual({ ok: true, value: undefined });
    const rewrittenOrdinary = await tracker.readTicket(
      'alpha-project',
      'todo',
      '001-ordinary'
    );
    if (!rewrittenOrdinary.ok) {
      throw new Error(rewrittenOrdinary.diagnostic.message);
    }
    expect(rewrittenOrdinary.value.metadata.Unknown).toEqual({
      nested: { enabled: false },
    });

    const complex = await tracker.readTicket(
      'alpha-project',
      'todo',
      '002-complex'
    );
    if (!complex.ok) throw new Error(complex.diagnostic.message);
    const pairs = complex.value.metadata.Pairs;
    if (!Array.isArray(pairs) || !(pairs[0] instanceof Map)) {
      throw new Error('Expected YAML pairs metadata');
    }
    pairs[0].set('one', 2n);
    const copied = {
      ...complex.value,
      metadata: { ...complex.value.metadata, Tags: ['updated'] },
    };
    expect(
      await tracker.writeTicket('alpha-project', 'todo', '002-complex', copied)
    ).toEqual({ ok: true, value: undefined });
    const rewrittenComplex = await tracker.readTicket(
      'alpha-project',
      'todo',
      '002-complex'
    );
    if (!rewrittenComplex.ok) {
      throw new Error(rewrittenComplex.diagnostic.message);
    }
    expect(rewrittenComplex.value.metadata.Tags).toEqual(['updated']);
    expect(rewrittenComplex.value.metadata.Pairs).toEqual([
      new Map([['one', 2n]]),
    ]);
    expect(rewrittenComplex.value.metadata.When).toEqual(
      new Date('2002-12-14T00:00:00.000Z')
    );
  });

  test('rejects unsupported own properties throughout parsed metadata', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const statusPath = join(workspaceRoot, 'alpha-project', 'todo');
    await mkdir(statusPath, { recursive: true });
    const source =
      '---\nWhen: !!timestamp 2002-12-14\nNested: {value: retained}\n---\n';
    const variants = [
      'root-hidden',
      'root-symbol',
      'root-accessor',
      'nested-hidden',
      'nested-symbol',
      'nested-accessor',
    ];
    const tracker = createTracker(workspaceRoot);

    for (const [index, variant] of variants.entries()) {
      const name = `${String(index + 1).padStart(3, '0')}-${variant}`;
      const ticketPath = join(statusPath, `${name}.md`);
      await writeFile(ticketPath, source);
      const document = await tracker.readTicket('alpha-project', 'todo', name);
      if (!document.ok) throw new Error(document.diagnostic.message);

      const nested = document.value.metadata.Nested;
      if (nested === null || typeof nested !== 'object') {
        throw new Error('Expected nested metadata map');
      }
      const target = variant.startsWith('root-')
        ? document.value.metadata
        : nested;
      if (variant.endsWith('-hidden')) {
        Object.defineProperty(target, 'Unsupported', {
          enumerable: false,
          value: 'not-yaml-metadata',
        });
      } else if (variant.endsWith('-symbol')) {
        Object.defineProperty(target, Symbol('unsupported'), {
          enumerable: true,
          value: 'not-yaml-metadata',
        });
      } else {
        Object.defineProperty(target, 'Unsupported', {
          enumerable: true,
          get: () => {
            throw new Error('Accessor must not be invoked');
          },
        });
      }

      const outcome = await tracker.writeTicket(
        'alpha-project',
        'todo',
        name,
        document.value
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('Expected serialization to be refused');
      expect(outcome.diagnostic).toEqual({
        path: ticketPath,
        code: 'serialization-error',
        message: 'YAML front matter contains an unsupported value',
      });
      expect(await readFile(ticketPath, 'utf8')).toBe(source);
    }

    const collectionName = '007-collection-accessor';
    const collectionPath = join(statusPath, `${collectionName}.md`);
    const collectionSource = '---\nNested: {? [one, two]: retained}\n---\n';
    await writeFile(collectionPath, collectionSource);
    const collectionDocument = await tracker.readTicket(
      'alpha-project',
      'todo',
      collectionName
    );
    if (!collectionDocument.ok) {
      throw new Error(collectionDocument.diagnostic.message);
    }
    const collection = collectionDocument.value.metadata.Nested;
    if (!(collection instanceof Map)) {
      throw new Error('Expected nested metadata Map');
    }
    Object.defineProperty(collection, Symbol.iterator, {
      get: () => {
        throw new Error('Collection iterator accessor must not be invoked');
      },
    });
    const copiedDocument = {
      ...collectionDocument.value,
      metadata: { ...collectionDocument.value.metadata },
    };
    const collectionOutcome = await tracker.writeTicket(
      'alpha-project',
      'todo',
      collectionName,
      copiedDocument
    );
    expect(collectionOutcome.ok).toBe(false);
    if (collectionOutcome.ok) {
      throw new Error('Expected collection serialization to be refused');
    }
    expect(collectionOutcome.diagnostic).toEqual({
      path: collectionPath,
      code: 'serialization-error',
      message: 'YAML front matter contains an unsupported value',
    });
    expect(await readFile(collectionPath, 'utf8')).toBe(collectionSource);
  });

  test('leaves aliased fields untouched when a deep edit cannot preserve shared identity', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const statusPath = join(workspaceRoot, 'alpha-project', 'todo');
    const ticketPath = join(statusPath, '001-aliased.md');
    await mkdir(statusPath, { recursive: true });
    const source = '---\nA: &shared {value: 1}\nB: *shared\n---\n';
    await writeFile(ticketPath, source);

    const tracker = createTracker(workspaceRoot);
    const document = await tracker.readTicket(
      'alpha-project',
      'todo',
      '001-aliased'
    );
    if (!document.ok) throw new Error(document.diagnostic.message);
    const first = document.value.metadata.A;
    if (first === null || typeof first !== 'object') {
      throw new Error('Expected aliased metadata map');
    }
    Reflect.set(first, 'value', 2n);
    const outcome = await tracker.writeTicket(
      'alpha-project',
      'todo',
      '001-aliased',
      document.value
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('Expected serialization to be refused');
    expect(outcome.diagnostic.code).toBe('serialization-error');
    expect(await readFile(ticketPath, 'utf8')).toBe(source);

    const unchanged = await tracker.readTicket(
      'alpha-project',
      'todo',
      '001-aliased'
    );
    if (!unchanged.ok) throw new Error(unchanged.diagnostic.message);
    expect(unchanged.value.metadata.A).toBe(unchanged.value.metadata.B);
    expect(unchanged.value.metadata.A).toEqual({ value: 1n });
  });

  test('accepts every supported standard YAML tag and preserves complex values', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const statusPath = join(workspaceRoot, 'alpha-project', 'todo');
    const ticketPath = join(statusPath, '001-standard-values.md');
    await mkdir(statusPath, { recursive: true });
    await writeFile(
      ticketPath,
      [
        '---',
        '&root',
        'Top-Defaults: &top-defaults {Top-Merged: value}',
        '<<: *top-defaults',
        '"__proto__": retained',
        'Nested:',
        '  outer:',
        '    ? [one, two]',
        '    : collection',
        'Cycle: &cycle {self: *cycle}',
        'Alias: *cycle',
        'Defaults: &defaults {enabled: true}',
        'Merged: {<<: *defaults, own: value}',
        'Binary: !!binary SGk=',
        'Ordered: !!omap [one: 1]',
        'Pairs: !!pairs [one: 1, two]',
        'Set: !!set {one: null}',
        'Date: !!timestamp 2002-12-14',
        'Date-Time: !!timestamp 2001-12-15T02:59:43.1Z',
        'Explicit-Map: !!map {one: !!int 1}',
        'Explicit-Sequence: !!seq [!!str one, !!bool true, !!float 1.0, !!null null]',
        'Self: *root',
        '---',
        'Body',
        '',
      ].join('\n')
    );

    const { tracker, ticket } = await discoverTicket(workspaceRoot);
    const first = await tracker.readTicket(
      ticket.status.project.name,
      ticket.status.name,
      ticket.name
    );
    if (!first.ok) throw new Error(first.diagnostic.message);

    expect(first.value.metadata.Self).toBe(first.value.metadata);
    expect(Object.hasOwn(first.value.metadata, '__proto__')).toBe(true);
    expect(first.value.metadata.__proto__).toBe('retained');
    expect(first.value.metadata['Top-Merged']).toBe('value');
    const nested = first.value.metadata.Nested;
    if (!(nested instanceof Map)) throw new Error('Expected a nested map');
    const outer: unknown = nested.get('outer');
    if (!(outer instanceof Map)) throw new Error('Expected an outer map');
    expect([...outer].at(0)).toEqual([['one', 'two'], 'collection']);
    const cycle = first.value.metadata.Cycle;
    if (!(cycle instanceof Map)) throw new Error('Expected a cyclic mapping');
    expect(cycle.get('self')).toBe(cycle);
    expect(first.value.metadata.Alias).toBe(cycle);
    expect(first.value.metadata.Merged).toEqual(
      new Map<unknown, unknown>([
        ['enabled', true],
        ['own', 'value'],
      ])
    );
    expect(first.value.metadata.Binary).toEqual(Buffer.from('Hi'));
    expect(first.value.metadata.Ordered).toEqual(new Map([['one', 1n]]));
    expect(first.value.metadata.Pairs).toEqual([
      new Map([['one', 1n]]),
      new Map([['two', null]]),
    ]);
    expect(first.value.metadata.Set).toEqual(new Set(['one']));
    expect(first.value.metadata.Date).toEqual(
      new Date('2002-12-14T00:00:00.000Z')
    );
    expect(first.value.metadata['Date-Time']).toEqual(
      new Date('2001-12-15T02:59:43.100Z')
    );
    expect(first.value.metadata['Explicit-Map']).toEqual(
      new Map([['one', 1n]])
    );
    expect(first.value.metadata['Explicit-Sequence']).toEqual([
      'one',
      true,
      1,
      null,
    ]);

    expect(
      await tracker.writeTicket(
        ticket.status.project.name,
        ticket.status.name,
        ticket.name,
        first.value
      )
    ).toEqual({ ok: true, value: undefined });
    const canonical = await readFile(ticketPath, 'utf8');
    for (const tag of [
      '!!binary',
      '!!omap',
      '!!pairs',
      '!!set',
      '!!timestamp',
      '!!map',
      '!!seq',
      '!!str',
      '!!bool',
      '!!float',
      '!!null',
    ]) {
      expect(canonical.includes(tag)).toBe(true);
    }

    const second = await tracker.readTicket(
      ticket.status.project.name,
      ticket.status.name,
      ticket.name
    );
    if (!second.ok) throw new Error(second.diagnostic.message);
    expect(second.value.metadata.Self).toBe(second.value.metadata);
    expect(Object.hasOwn(second.value.metadata, '__proto__')).toBe(true);
    expect(second.value.metadata.__proto__).toBe('retained');
    const secondCycle = second.value.metadata.Cycle;
    if (!(secondCycle instanceof Map)) {
      throw new Error('Expected a cyclic mapping');
    }
    expect(secondCycle.get('self')).toBe(secondCycle);
    expect(second.value.metadata.Pairs).toEqual(first.value.metadata.Pairs);
    expect(second.value.metadata['Date-Time']).toEqual(
      first.value.metadata['Date-Time']
    );
    expect(await readFile(ticketPath, 'utf8')).toContain('Body\n');
  });

  test('leaves a document untouched when a merge-provided field cannot be removed safely', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const statusPath = join(workspaceRoot, 'alpha-project', 'todo');
    const ticketPath = join(statusPath, '001-merged.md');
    await mkdir(statusPath, { recursive: true });
    const source =
      '---\nDefaults: &defaults {Unknown: value}\n<<: *defaults\n---\nBody\n';
    await writeFile(ticketPath, source);

    const { tracker, ticket } = await discoverTicket(workspaceRoot);
    const document = await tracker.readTicket(
      ticket.status.project.name,
      ticket.status.name,
      ticket.name
    );
    if (!document.ok) throw new Error(document.diagnostic.message);
    Reflect.deleteProperty(document.value.metadata, 'Unknown');
    const outcome = await tracker.writeTicket(
      ticket.status.project.name,
      ticket.status.name,
      ticket.name,
      document.value
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('Expected serialization to be refused');
    expect(outcome.diagnostic.code).toBe('serialization-error');
    expect(await readFile(ticketPath, 'utf8')).toBe(source);
  });

  test('rejects invalid top-level keys, unsupported tags, and invalid standard tag payloads without parser output', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const statusPath = join(workspaceRoot, 'alpha-project', 'todo');
    await mkdir(statusPath, { recursive: true });
    const sources = new Map([
      ['001-colliding-keys.md', '---\n1: numeric\n"1": string\n---\nBody\n'],
      ['002-collection-key.md', '---\n? [one, two]\n: collection\n---\nBody\n'],
      ['003-unsupported-tag.md', '---\nUnknown: !foo value\n---\nBody\n'],
      [
        '004-invalid-pairs.md',
        '---\nUnknown: !!pairs [{one: 1, two: 2}]\n---\nBody\n',
      ],
      [
        '005-invalid-timestamp.md',
        '---\nUnknown: !!timestamp not-a-date\n---\nBody\n',
      ],
    ]);
    await Promise.all(
      [...sources].map(([name, source]) =>
        writeFile(join(statusPath, name), source)
      )
    );

    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    const { tracker, project } = await discoverProject(workspaceRoot);
    const tickets = await tracker.discoverTickets(project.name, 'todo');
    const outcomes = await Promise.all(
      tickets.entries.map((ticket) =>
        tracker.readTicket(project.name, 'todo', ticket.name)
      )
    );

    expect(
      outcomes.map((outcome) =>
        outcome.ok ? 'success' : outcome.diagnostic.code
      )
    ).toEqual([
      'malformed-ticket-yaml',
      'malformed-ticket-yaml',
      'malformed-ticket-yaml',
      'malformed-ticket-yaml',
      'malformed-ticket-yaml',
    ]);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    for (const [name, source] of sources) {
      expect(await readFile(join(statusPath, name), 'utf8')).toBe(source);
    }
    warn.mockRestore();
    error.mockRestore();
  });

  test('classifies unresolved YAML aliases as malformed metadata for mapping and sequence roots', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const statusPath = join(workspaceRoot, 'alpha-project', 'todo');
    await mkdir(statusPath, { recursive: true });
    const paths = [
      join(statusPath, '001-mapping-alias.md'),
      join(statusPath, '002-sequence-alias.md'),
    ];
    await Promise.all([
      writeFile(paths[0], '---\nUnknown: *missing\n---\n'),
      writeFile(paths[1], '---\n- *missing\n---\n'),
    ]);

    const { tracker, project } = await discoverProject(workspaceRoot);
    const tickets = await tracker.discoverTickets(project.name, 'todo');
    const outcomes = await Promise.all(
      tickets.entries.map((ticket) =>
        tracker.readTicket(project.name, 'todo', ticket.name)
      )
    );
    for (const [index, outcome] of outcomes.entries()) {
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('Expected malformed alias failure');
      expect(outcome.diagnostic.path).toBe(paths[index]);
      expect(outcome.diagnostic.code).toBe('malformed-ticket-yaml');
      expect(outcome.diagnostic.message.includes('Unresolved alias')).toBe(
        true
      );
    }
  });

  test('reports malformed and duplicate ticket YAML while other tickets remain readable', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const statusPath = join(workspaceRoot, 'alpha-project', 'todo');
    await mkdir(statusPath, { recursive: true });
    const validPath = join(statusPath, '001-valid.md');
    const malformedPath = join(statusPath, '002-malformed.md');
    const duplicatePath = join(statusPath, '003-duplicate.md');
    await writeFile(
      validPath,
      '---\nAssigned-To:\nTags: []\nParent:\nBlocked-By: []\nExtra: value\n---\nBody\n'
    );
    await writeFile(malformedPath, '---\nTags: [unterminated\n---\n');
    await writeFile(
      duplicatePath,
      '---\nAssigned-To: first\nAssigned-To: second\n---\n'
    );

    const { tracker, project } = await discoverProject(workspaceRoot);
    const statuses = await tracker.discoverStatuses(project.name);
    const status = statuses.entries[0];
    const tickets = await tracker.discoverTickets(project.name, status.name);

    expect(tickets.entries.map((ticket) => ticket.name)).toEqual([
      '001-valid',
      '002-malformed',
      '003-duplicate',
    ]);
    const outcomes = await Promise.all(
      tickets.entries.map((entry) =>
        tracker.readTicket(project.name, status.name, entry.name)
      )
    );
    expect(outcomes[0]).toEqual({
      ok: true,
      value: {
        metadata: {
          'Assigned-To': null,
          Tags: [],
          Parent: null,
          'Blocked-By': [],
          Extra: 'value',
        },
        body: 'Body\n',
      },
    });
    expect(outcomes[1]?.ok).toBe(false);
    expect(outcomes[2]?.ok).toBe(false);
    if (outcomes[1]?.ok !== false || outcomes[2]?.ok !== false) {
      throw new Error('Expected parser failures');
    }
    expect(outcomes[1].diagnostic.code).toBe('malformed-ticket-yaml');
    expect(outcomes[2].diagnostic.code).toBe('duplicate-ticket-key');
  });

  test('canonically rewrites UTF-8 documents while preserving body content', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const statusPath = join(workspaceRoot, 'alpha-project', 'todo');
    const ticketPath = join(statusPath, '001-canonical.md');
    await mkdir(statusPath, { recursive: true });
    await writeFile(
      ticketPath,
      '---\r\nAssigned-To:\r\nTags: []\r\nParent:\r\nBlocked-By: []\r\nUnknown: yes\r\n---\r\n# Body\r\n\r\nText\r\n'
    );

    const { tracker, ticket } = await discoverTicket(workspaceRoot);
    const readOutcome = await tracker.readTicket(
      ticket.status.project.name,
      ticket.status.name,
      ticket.name
    );
    if (!readOutcome.ok) throw new Error(readOutcome.diagnostic.message);
    const writeOutcome = await tracker.writeTicket(
      ticket.status.project.name,
      ticket.status.name,
      ticket.name,
      {
        metadata: {
          ...readOutcome.value.metadata,
          Tags: ['one-tag'],
        },
        body: readOutcome.value.body,
      }
    );

    expect(writeOutcome).toEqual({ ok: true, value: undefined });
    const bytes = await readFile(ticketPath);
    expect(bytes[0]).not.toBe(0xef);
    expect(bytes.toString('utf8')).toBe(
      [
        '---',
        'Assigned-To:',
        'Tags:',
        '  - one-tag',
        'Parent:',
        'Blocked-By: []',
        'Unknown: yes',
        '---',
        '# Body',
        '',
        'Text',
        '',
      ].join('\n')
    );
  });

  test('returns metadata serialization failures as structured outcomes', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const statusPath = join(workspaceRoot, 'alpha-project', 'todo');
    const ticketPath = join(statusPath, '001-invalid-value.md');
    const original = '---\nUnknown: original\n---\nBody\n';
    await mkdir(statusPath, { recursive: true });
    await writeFile(ticketPath, original);

    const { tracker, ticket } = await discoverTicket(workspaceRoot);
    const unsupported = [
      Symbol('unsupported'),
      new Date('2026-01-01T00:00:00Z'),
      new Map([['key', 'value']]),
      new Set(['value']),
      new Uint8Array([1, 2]),
    ];
    const outcomes = await Promise.all(
      unsupported.map((value) =>
        tracker.writeTicket(
          ticket.status.project.name,
          ticket.status.name,
          ticket.name,
          {
            metadata: { Unknown: value },
            body: 'Changed\n',
          }
        )
      )
    );

    expect(
      outcomes.map((outcome) =>
        outcome.ok ? 'success' : outcome.diagnostic.code
      )
    ).toEqual([
      'serialization-error',
      'serialization-error',
      'serialization-error',
      'serialization-error',
      'serialization-error',
    ]);
    expect(await readFile(ticketPath, 'utf8')).toBe(original);
  });

  test('returns missing document and failed canonical writes as structured outcomes', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const projectPath = join(workspaceRoot, 'alpha-project');
    await mkdir(projectPath);
    const { tracker, project } = await discoverProject(workspaceRoot);

    const readOutcome = await tracker.readProject(project.name);
    expect(readOutcome.ok).toBe(false);
    if (readOutcome.ok) throw new Error('Expected read failure');
    expect(readOutcome.diagnostic.code).toBe('filesystem-error');
    expect(readOutcome.diagnostic.path).toBe(join(projectPath, 'project.md'));

    await rm(projectPath, { recursive: true });
    const writeOutcome = await tracker.writeProject(project.name, {
      metadata: { 'Default-Status': 'todo' },
      body: '',
    });
    expect(writeOutcome.ok).toBe(false);
    if (writeOutcome.ok) throw new Error('Expected write failure');
    expect(writeOutcome.diagnostic.code).toBe('filesystem-error');
    expect(writeOutcome.diagnostic.path).toBe(join(projectPath, 'project.md'));
  });
});

describe('tracker ticket mutations', () => {
  test('renames with the original ID and rewrites local and cross-project relationships', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const alphaTodo = join(workspaceRoot, 'alpha-project', 'todo');
    const betaTodo = join(workspaceRoot, 'beta-project', 'todo');
    await Promise.all([
      mkdir(alphaTodo, { recursive: true }),
      mkdir(betaTodo, { recursive: true }),
    ]);
    const targetSource =
      '---\nAssigned-To: pi\nTags: []\nParent:\nBlocked-By: []\n---\nTarget\n';
    await writeFile(join(alphaTodo, '001-old-name.md'), targetSource);
    await writeFile(
      join(alphaTodo, '002-local-child.md'),
      '---\nParent: 001-old-name\nBlocked-By: [001-old-name, alpha-project/001-old-name]\nUnknown: retained\n---\nLocal\n'
    );
    await writeFile(
      join(betaTodo, '001-cross-child.md'),
      '---\nParent: alpha-project/001-old-name\nBlocked-By: [alpha-project/001-old-name]\n---\nCross\n'
    );

    const tracker = createTracker(workspaceRoot);
    const renamedPath = join(alphaTodo, '001-new-name.md');
    expect(
      await tracker.renameTicket('alpha-project', '001-old-name', 'new-name')
    ).toEqual({
      ok: true,
      value: {
        id: 1n,
        name: '001-new-name',
        description: 'new-name',
        path: renamedPath,
        status: {
          name: 'todo',
          path: alphaTodo,
          project: {
            name: 'alpha-project',
            path: join(workspaceRoot, 'alpha-project'),
          },
        },
      },
    });
    expect(await Bun.file(join(alphaTodo, '001-old-name.md')).exists()).toBe(
      false
    );
    expect(await readFile(renamedPath, 'utf8')).toBe(targetSource);

    const local = await tracker.readTicket(
      'alpha-project',
      'todo',
      '002-local-child'
    );
    expect(local.ok).toBe(true);
    if (!local.ok) throw new Error(local.diagnostic.message);
    expect(local.value).toEqual({
      metadata: {
        Parent: '001-new-name',
        'Blocked-By': ['001-new-name', 'alpha-project/001-new-name'],
        Unknown: 'retained',
      },
      body: 'Local\n',
    });
    const cross = await tracker.readTicket(
      'beta-project',
      'todo',
      '001-cross-child'
    );
    expect(cross.ok).toBe(true);
    if (!cross.ok) throw new Error(cross.diagnostic.message);
    expect(cross.value.metadata).toEqual({
      Parent: 'alpha-project/001-new-name',
      'Blocked-By': ['alpha-project/001-new-name'],
    });
  });

  test('preserves complex unknown YAML values during relationship rewrites', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const todo = join(workspaceRoot, 'alpha-project', 'todo');
    await mkdir(todo, { recursive: true });
    await writeFile(join(todo, '001-old-name.md'), '---\n---\nTarget\n');
    const childPath = join(todo, '002-child.md');
    await writeFile(
      childPath,
      [
        '---',
        'Parent: &old-parent 001-old-name',
        'Blocked-By: &old-blockers [*old-parent]',
        'Echo: *old-parent',
        'Echo-Blocked: *old-blockers',
        'Nested: {? [one, two]: value}',
        'Cycle: &cycle {self: *cycle}',
        'Ordered: !!omap [one: 1]',
        'Pairs: !!pairs [one: 1, two]',
        'When: !!timestamp 2002-12-14',
        '---',
        'Child',
        '',
      ].join('\n')
    );

    const outcome = await createTracker(workspaceRoot).renameTicket(
      'alpha-project',
      '001-old-name',
      'new-name'
    );
    expect(outcome.ok).toBe(true);

    const rewritten = await readFile(childPath, 'utf8');
    expect(rewritten).toContain('Parent: 001-new-name');
    expect(rewritten).toContain('Echo: &old-parent-preserved 001-old-name');
    expect(rewritten).toContain('!!omap');
    expect(rewritten).toContain('!!pairs');
    expect(rewritten).toContain('!!timestamp');
    const child = await createTracker(workspaceRoot).readTicket(
      'alpha-project',
      'todo',
      '002-child'
    );
    if (!child.ok) throw new Error(child.diagnostic.message);
    expect(child.value.metadata.Parent).toBe('001-new-name');
    expect(child.value.metadata['Blocked-By']).toEqual(['001-new-name']);
    expect(child.value.metadata.Echo).toBe('001-old-name');
    expect(child.value.metadata['Echo-Blocked']).toEqual(['001-old-name']);
    const cycle = child.value.metadata.Cycle;
    if (!(cycle instanceof Map)) throw new Error('Expected a cyclic mapping');
    expect(cycle.get('self')).toBe(cycle);
    expect(child.value.metadata.Nested).toBeInstanceOf(Map);
    expect(child.value.metadata.Pairs).toEqual([
      new Map([['one', 1n]]),
      new Map([['two', null]]),
    ]);
  });

  test('moves are no-ops in place, reject collisions, and move successfully', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const projectPath = join(workspaceRoot, 'alpha-project');
    const todo = join(projectPath, 'todo');
    const active = join(projectPath, 'in-progress');
    await Promise.all([
      mkdir(todo, { recursive: true }),
      mkdir(active, { recursive: true }),
    ]);
    const source = '---\nBlocked-By: []\n---\nBytes stay exact\r\n';
    await writeFile(join(todo, '001-move-me.md'), source);
    const tracker = createTracker(workspaceRoot);

    const noOp = await tracker.moveTicket(
      'alpha-project',
      '001-move-me',
      'todo'
    );
    expect(noOp.ok).toBe(true);
    expect(await readFile(join(todo, '001-move-me.md'), 'utf8')).toBe(source);
    await mkdir(join(active, '001-move-me.md'));
    const collision = await tracker.moveTicket(
      'alpha-project',
      '001-move-me',
      'in-progress'
    );
    expect(collision).toEqual({
      ok: false,
      diagnostics: [
        {
          path: join(active, '001-move-me.md'),
          code: 'resource-exists',
          message: `Resource already exists: ${join(active, '001-move-me.md')}`,
        },
      ],
      partial: false,
    });
    expect(await readFile(join(todo, '001-move-me.md'), 'utf8')).toBe(source);
    await rm(join(active, '001-move-me.md'), { recursive: true });
    const moved = await tracker.moveTicket(
      'alpha-project',
      '001-move-me',
      'in-progress'
    );
    expect(moved.ok).toBe(true);
    if (!moved.ok) throw new Error(moved.diagnostics[0]?.message);
    expect(moved.value.path).toBe(join(active, '001-move-me.md'));
    expect(await readFile(moved.value.path, 'utf8')).toBe(source);
  });

  test('completion creates done, preserves the target, cleans blockers, and is idempotent', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const alphaTodo = join(workspaceRoot, 'alpha-project', 'todo');
    const betaTodo = join(workspaceRoot, 'beta-project', 'todo');
    await Promise.all([
      mkdir(alphaTodo, { recursive: true }),
      mkdir(betaTodo, { recursive: true }),
    ]);
    const completedSource =
      '---\nAssigned-To: pi\nBlocked-By: [999-still-recorded]\n---\nCompleted bytes\r\n';
    await writeFile(join(alphaTodo, '001-finish.md'), completedSource);
    await writeFile(
      join(alphaTodo, '002-local.md'),
      '---\nParent: 001-finish\nBlocked-By: [001-finish, 003-other]\n---\n'
    );
    await writeFile(
      join(betaTodo, '001-cross.md'),
      '---\nBlocked-By: [alpha-project/001-finish]\n---\n'
    );
    const tracker = createTracker(workspaceRoot);
    const completedPath = join(
      workspaceRoot,
      'alpha-project',
      'done',
      '001-finish.md'
    );

    const first = await tracker.completeTicket('alpha-project', '001-finish');
    expect(first.ok).toBe(true);
    expect(await readFile(completedPath, 'utf8')).toBe(completedSource);
    const local = await tracker.readTicket(
      'alpha-project',
      'todo',
      '002-local'
    );
    expect(local.ok).toBe(true);
    if (!local.ok) throw new Error(local.diagnostic.message);
    expect(local.value.metadata).toEqual({
      Parent: '001-finish',
      'Blocked-By': ['003-other'],
    });
    const cross = await tracker.readTicket('beta-project', 'todo', '001-cross');
    expect(cross.ok).toBe(true);
    if (!cross.ok) throw new Error(cross.diagnostic.message);
    expect(cross.value.metadata['Blocked-By']).toEqual([]);

    await writeFile(
      join(betaTodo, '002-late.md'),
      '---\nBlocked-By: [alpha-project/001-finish]\n---\n'
    );
    const second = await tracker.moveTicket(
      'alpha-project',
      '001-finish',
      'done'
    );
    expect(second.ok).toBe(true);
    expect(await readFile(completedPath, 'utf8')).toBe(completedSource);
    const late = await tracker.readTicket('beta-project', 'todo', '002-late');
    expect(late.ok).toBe(true);
    if (!late.ok) throw new Error(late.diagnostic.message);
    expect(late.value.metadata['Blocked-By']).toEqual([]);

    const movedOut = await tracker.moveTicket(
      'alpha-project',
      '001-finish',
      'todo'
    );
    expect(movedOut.ok).toBe(true);
    expect(await readFile(join(alphaTodo, '001-finish.md'), 'utf8')).toBe(
      completedSource
    );
    const stillClean = await tracker.readTicket(
      'beta-project',
      'todo',
      '002-late'
    );
    expect(stillClean.ok).toBe(true);
    if (!stillClean.ok) throw new Error(stillClean.diagnostic.message);
    expect(stillClean.value.metadata['Blocked-By']).toEqual([]);
  });

  test('reports the actual cross-status rename collision and preserves both files', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const projectPath = join(workspaceRoot, 'alpha-project');
    const todo = join(projectPath, 'todo');
    const done = join(projectPath, 'done');
    await Promise.all([
      mkdir(todo, { recursive: true }),
      mkdir(done, { recursive: true }),
    ]);
    const sourcePath = join(todo, '001-old.md');
    const collisionPath = join(done, '001-new.md');
    await writeFile(sourcePath, '---\n---\nsource');
    await writeFile(collisionPath, '---\n---\ncollision');

    expect(
      await createTracker(workspaceRoot).renameTicket(
        'alpha-project',
        '001-old',
        'new'
      )
    ).toEqual({
      ok: false,
      diagnostics: [
        {
          path: collisionPath,
          code: 'resource-exists',
          message: `Resource already exists: ${collisionPath}`,
        },
      ],
      partial: false,
    });
    expect(await readFile(sourcePath, 'utf8')).toBe('---\n---\nsource');
    expect(await readFile(collisionPath, 'utf8')).toBe('---\n---\ncollision');
  });

  test('completion collisions preserve the source without cleanup', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const projectPath = join(workspaceRoot, 'alpha-project');
    const todo = join(projectPath, 'todo');
    const done = join(projectPath, 'done');
    await Promise.all([
      mkdir(todo, { recursive: true }),
      mkdir(done, { recursive: true }),
    ]);
    const sourcePath = join(todo, '001-finish.md');
    const collisionPath = join(done, '001-finish.md');
    await writeFile(sourcePath, '---\n---\nsource');
    await mkdir(collisionPath);
    await writeFile(
      join(todo, '002-dependent.md'),
      '---\nBlocked-By: [001-finish]\n---\n'
    );

    const outcome = await createTracker(workspaceRoot).completeTicket(
      'alpha-project',
      '001-finish'
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('Expected collision');
    expect(outcome.partial).toBe(false);
    expect(outcome.diagnostics[0]?.path).toBe(collisionPath);
    expect(await readFile(sourcePath, 'utf8')).toBe('---\n---\nsource');
    expect(await readFile(join(todo, '002-dependent.md'), 'utf8')).toContain(
      '001-finish'
    );
  });

  test('retains successful cleanup when malformed files cause sorted partial failures', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const todo = join(workspaceRoot, 'alpha-project', 'todo');
    await mkdir(todo, { recursive: true });
    await writeFile(join(todo, '001-old.md'), '---\nBlocked-By: []\n---\n');
    await writeFile(
      join(todo, '002-updated.md'),
      '---\nParent: 001-old\nBlocked-By: [001-old]\n---\n'
    );
    const malformedA = join(todo, '003-malformed.md');
    const malformedB = join(todo, '004-duplicate.md');
    await writeFile(malformedA, 'not front matter\n');
    await writeFile(malformedB, '---\nParent: 001-old\nParent: 001-old\n---\n');

    const outcome = await createTracker(workspaceRoot).renameTicket(
      'alpha-project',
      '001-old',
      'renamed'
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('Expected partial failure');
    expect(outcome.partial).toBe(true);
    expect(outcome.diagnostics.map(({ path }) => path)).toEqual([
      malformedA,
      malformedB,
    ]);
    expect(outcome.diagnostics.map(({ code }) => code)).toEqual([
      'malformed-ticket-yaml',
      'duplicate-ticket-key',
    ]);
    expect(await readFile(join(todo, '001-renamed.md'), 'utf8')).toBe(
      '---\nBlocked-By: []\n---\n'
    );
    const updated = await createTracker(workspaceRoot).readTicket(
      'alpha-project',
      'todo',
      '002-updated'
    );
    expect(updated.ok).toBe(true);
    if (!updated.ok) throw new Error(updated.diagnostic.message);
    expect(updated.value.metadata).toEqual({
      Parent: '001-renamed',
      'Blocked-By': ['001-renamed'],
    });
  });

  test('completion keeps its move and successful cleanup after malformed-file failures', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const todo = join(workspaceRoot, 'alpha-project', 'todo');
    await mkdir(todo, { recursive: true });
    const source = '---\nAssigned-To: pi\nBlocked-By: []\n---\nExact\r\n';
    await writeFile(join(todo, '001-finish.md'), source);
    await writeFile(
      join(todo, '002-dependent.md'),
      '---\nBlocked-By: [001-finish]\n---\n'
    );
    const malformed = join(todo, '003-malformed.md');
    await writeFile(malformed, 'malformed\n');

    const outcome = await createTracker(workspaceRoot).completeTicket(
      'alpha-project',
      '001-finish'
    );
    expect(outcome).toEqual({
      ok: false,
      diagnostics: [
        {
          path: malformed,
          code: 'malformed-ticket-yaml',
          message: 'YAML front matter is missing or not delimited correctly',
        },
      ],
      partial: true,
    });
    expect(
      await readFile(
        join(workspaceRoot, 'alpha-project', 'done', '001-finish.md'),
        'utf8'
      )
    ).toBe(source);
    const dependent = await createTracker(workspaceRoot).readTicket(
      'alpha-project',
      'todo',
      '002-dependent'
    );
    expect(dependent.ok).toBe(true);
    if (!dependent.ok) throw new Error(dependent.diagnostic.message);
    expect(dependent.value.metadata['Blocked-By']).toEqual([]);
  });
});
