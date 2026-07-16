import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
  const statuses = await tracker.discoverStatuses(project);
  const status = statuses.entries.find((entry) => entry.name === statusName);
  if (status === undefined)
    throw new Error(`Status ${statusName} was not found`);
  const tickets = await tracker.discoverTickets(status);
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
      id: 1,
      name: '001-add-search',
      description: 'add-search',
    });
    expect(parseTicketName('1000-grow-naturally')).toEqual({
      id: 1000,
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
    expect(await tracker.discoverStatuses(project)).toEqual({
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
      writeFile(join(statusPath, '.003-hidden.md'), ''),
      writeFile(join(statusPath, '01-short.md'), ''),
      writeFile(join(statusPath, '000-zero.md'), ''),
      writeFile(join(statusPath, '004-wrong-extension.txt'), ''),
      mkdir(join(statusPath, '005-directory.md')),
    ]);

    const { tracker, project } = await discoverProject(workspaceRoot);
    const statuses = await tracker.discoverStatuses(project);
    const status = statuses.entries[0];

    expect(await tracker.discoverTickets(status)).toEqual({
      entries: [
        {
          id: 2,
          name: '002-earlier',
          description: 'earlier',
          path: join(statusPath, '002-earlier.md'),
          status,
        },
        {
          id: 10,
          name: '010-later',
          description: 'later',
          path: join(statusPath, '010-later.md'),
          status,
        },
        {
          id: 1000,
          name: '1000-large-id',
          description: 'large-id',
          path: join(statusPath, '1000-large-id.md'),
          status,
        },
      ],
      diagnostics: [],
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
    expect(await tracker.readProject(project)).toEqual({
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

    expect(await tracker.readProject(malformed)).toEqual({
      ok: false,
      diagnostic: {
        path: malformedPath,
        code: 'malformed-project-yaml',
        message: 'YAML front matter is missing or not delimited correctly',
      },
    });
    const duplicateOutcome = await tracker.readProject(duplicate);
    expect(duplicateOutcome.ok).toBe(false);
    if (duplicateOutcome.ok) throw new Error('Expected duplicate key failure');
    expect(duplicateOutcome.diagnostic.path).toBe(duplicatePath);
    expect(duplicateOutcome.diagnostic.code).toBe('duplicate-project-key');
    expect(
      duplicateOutcome.diagnostic.message.includes('Map keys must be unique')
    ).toBe(true);
  });

  test('accepts empty ticket metadata because every standard field is optional', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const statusPath = join(workspaceRoot, 'alpha-project', 'todo');
    await mkdir(statusPath, { recursive: true });
    await writeFile(join(statusPath, '001-empty.md'), '---\n---\nBody\n');

    const { tracker, ticket } = await discoverTicket(workspaceRoot);
    expect(await tracker.readTicket(ticket)).toEqual({
      ok: true,
      value: { metadata: {}, body: 'Body\n' },
    });
  });

  test('classifies unresolved YAML aliases as malformed metadata', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const statusPath = join(workspaceRoot, 'alpha-project', 'todo');
    const ticketPath = join(statusPath, '001-alias.md');
    await mkdir(statusPath, { recursive: true });
    await writeFile(ticketPath, '---\nUnknown: *missing\n---\n');

    const { tracker, ticket } = await discoverTicket(workspaceRoot);
    const outcome = await tracker.readTicket(ticket);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('Expected malformed alias failure');
    expect(outcome.diagnostic.path).toBe(ticketPath);
    expect(outcome.diagnostic.code).toBe('malformed-ticket-yaml');
    expect(outcome.diagnostic.message.includes('Unresolved alias')).toBe(true);
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
    const statuses = await tracker.discoverStatuses(project);
    const status = statuses.entries[0];
    const tickets = await tracker.discoverTickets(status);

    expect(tickets.entries.map((ticket) => ticket.name)).toEqual([
      '001-valid',
      '002-malformed',
      '003-duplicate',
    ]);
    const outcomes = await Promise.all(tickets.entries.map(tracker.readTicket));
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
    const readOutcome = await tracker.readTicket(ticket);
    if (!readOutcome.ok) throw new Error(readOutcome.diagnostic.message);
    const writeOutcome = await tracker.writeTicket(ticket, {
      metadata: {
        ...readOutcome.value.metadata,
        Tags: ['one-tag'],
      },
      body: readOutcome.value.body,
    });

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
    const outcome = await tracker.writeTicket(ticket, {
      metadata: { Unknown: Symbol('unsupported') },
      body: 'Changed\n',
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('Expected serialization failure');
    expect(outcome.diagnostic.path).toBe(ticketPath);
    expect(outcome.diagnostic.code).toBe('serialization-error');
    expect(outcome.diagnostic.message).toBe(
      'Tag not resolved for Symbol value'
    );
    expect(await readFile(ticketPath, 'utf8')).toBe(original);
  });

  test('returns missing document and failed canonical writes as structured outcomes', async () => {
    const workspaceRoot = await temporaryWorkspace();
    const projectPath = join(workspaceRoot, 'alpha-project');
    await mkdir(projectPath);
    const { tracker, project } = await discoverProject(workspaceRoot);

    const readOutcome = await tracker.readProject(project);
    expect(readOutcome.ok).toBe(false);
    if (readOutcome.ok) throw new Error('Expected read failure');
    expect(readOutcome.diagnostic.code).toBe('filesystem-error');
    expect(readOutcome.diagnostic.path).toBe(join(projectPath, 'project.md'));

    await rm(projectPath, { recursive: true });
    const writeOutcome = await tracker.writeProject(project, {
      metadata: { 'Default-Status': 'todo' },
      body: '',
    });
    expect(writeOutcome.ok).toBe(false);
    if (writeOutcome.ok) throw new Error('Expected write failure');
    expect(writeOutcome.diagnostic.code).toBe('filesystem-error');
    expect(writeOutcome.diagnostic.path).toBe(join(projectPath, 'project.md'));
  });
});
