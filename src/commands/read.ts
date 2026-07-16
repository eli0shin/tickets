import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from '@commander-js/extra-typings';
import type {
  ProjectRepository,
  ProjectSelection,
  SelectProjectOptions,
} from '../git.ts';
import {
  formatProjectSelectionFailure,
  writeDiagnostic,
  writeDiagnostics,
  writeProjectList,
  writeRaw,
  writeStatusList,
  writeTicketQuery,
} from '../output.ts';
import {
  createTracker,
  isNormalizedName,
  isTicketReference,
  type QueryResult,
  type SearchCriteria,
  type Tracker,
} from '../tracker/index.ts';

type GlobalOptions = {
  readonly workspace?: string;
  readonly project?: string;
};

type RootCommand = Command<[], GlobalOptions, Record<string, never>>;
type SelectProjectForCli = (
  options: SelectProjectOptions
) => Promise<ProjectSelection>;

type SelectedTracker = {
  readonly project: string;
  readonly tracker: Tracker;
};

export function addReadOnlyCommands(
  program: RootCommand,
  selectProject: SelectProjectForCli
): void {
  const project = program.command('project').description('manage projects');
  project
    .command('list')
    .description('list projects')
    .option('--json', 'emit JSON output')
    .action(async (options: { json?: boolean }) => {
      const tracker = trackerFor(program);
      const result = await tracker.discoverProjects();
      if (result.diagnostics.length > 0) {
        fail(result.diagnostics[0]?.message ?? 'Could not list projects');
        return;
      }
      writeProjectList(result.entries, Boolean(options.json));
    });

  const status = program.command('status').description('manage statuses');
  status
    .command('list')
    .description('list statuses')
    .option('--json', 'emit JSON output')
    .action(async (options: { json?: boolean }) => {
      const selected = await selectedTracker(program, selectProject);
      if (selected === null) return;
      const result = await selected.tracker.discoverStatuses(selected.project);
      if (result.diagnostics.length > 0) {
        fail(result.diagnostics[0]?.message ?? 'Could not list statuses');
        return;
      }
      writeStatusList(selected.project, result.entries, Boolean(options.json));
    });

  program
    .command('show')
    .description('show a complete ticket document')
    .argument('<reference>')
    .action(async (reference: string) => {
      if (!validReference(reference)) return;
      const projectSeparator = reference.indexOf('/');
      const selected =
        projectSeparator === -1
          ? await selectedTracker(program, selectProject)
          : {
              project: reference.slice(0, projectSeparator),
              tracker: trackerFor(program),
            };
      if (selected === null) return;
      const result = await selected.tracker.showTicket(
        selected.project,
        reference
      );
      if (!result.ok) {
        fail(result.diagnostic.message);
        return;
      }
      writeRaw(result.value);
    });

  program
    .command('list')
    .description('list tickets in one status')
    .argument('<status>')
    .option('--json', 'emit JSON output')
    .action(async (statusName: string, options: { json?: boolean }) => {
      if (!validName('status', statusName)) return;
      const selected = await selectedTracker(program, selectProject);
      if (selected === null) return;
      const result = await selected.tracker.listTickets(
        selected.project,
        statusName
      );
      if (queryFailed(result)) return;
      writeTicketQuery(result, Boolean(options.json));
      partialFailure(result.diagnostics);
    });

  program
    .command('search')
    .description('search tickets using structured criteria')
    .option('--status <status>', 'match every status', collect, [])
    .option('--tag <tag>', 'match every tag', collect, [])
    .option('--assigned-to <assignee>', 'match every assignee', collect, [])
    .option('--unassigned', 'match unassigned tickets')
    .option('--parent <reference>', 'match every parent reference', collect, [])
    .option(
      '--blocked-by <reference>',
      'match every blocker reference',
      collect,
      []
    )
    .option('--unblocked', 'match tickets without blockers')
    .option('--json', 'emit JSON output')
    .action(
      async (options: {
        status?: string[];
        tag?: string[];
        assignedTo?: string[];
        unassigned?: boolean;
        parent?: string[];
        blockedBy?: string[];
        unblocked?: boolean;
        json?: boolean;
      }) => {
        if ((options.assignedTo?.length ?? 0) > 0 && options.unassigned) {
          fail('--assigned-to and --unassigned cannot be used together');
          return;
        }
        if ((options.blockedBy?.length ?? 0) > 0 && options.unblocked) {
          fail('--blocked-by and --unblocked cannot be used together');
          return;
        }
        if (!validCriteria(options)) return;
        const selected = await selectedTracker(program, selectProject);
        if (selected === null) return;
        const criteria = {
          statuses: nonEmpty(options.status),
          tags: nonEmpty(options.tag),
          assignedTo: nonEmpty(options.assignedTo),
          unassigned: options.unassigned,
          parents: nonEmpty(options.parent),
          blockedBy: nonEmpty(options.blockedBy),
          unblocked: options.unblocked,
        } satisfies SearchCriteria;
        const result = await selected.tracker.searchTickets(
          selected.project,
          criteria
        );
        if (queryFailed(result)) return;
        writeTicketQuery(result, Boolean(options.json));
        partialFailure(result.diagnostics);
      }
    );
}

function validCriteria(options: {
  readonly status?: readonly string[];
  readonly tag?: readonly string[];
  readonly assignedTo?: readonly string[];
  readonly parent?: readonly string[];
  readonly blockedBy?: readonly string[];
}): boolean {
  if (!validNames('status', options.status)) return false;
  if (!validNames('tag', options.tag)) return false;
  if (!validNames('assignee', options.assignedTo)) return false;
  if (options.parent !== undefined) {
    for (const reference of options.parent) {
      if (!validReference(reference)) return false;
    }
  }
  if (options.blockedBy !== undefined) {
    for (const reference of options.blockedBy) {
      if (!validReference(reference)) return false;
    }
  }
  return true;
}

function validNames(
  kind: string,
  values: readonly string[] | undefined
): boolean {
  if (values === undefined) return true;
  for (const value of values) if (!validName(kind, value)) return false;
  return true;
}

function validName(kind: string, value: string): boolean {
  if (isNormalizedName(value)) return true;
  fail(`Invalid ${kind} name: ${value}`);
  return false;
}

function validReference(value: string): boolean {
  if (isTicketReference(value)) return true;
  fail(`Invalid ticket reference: ${value}`);
  return false;
}

function queryFailed(result: QueryResult): boolean {
  if (!result.fatal) return false;
  fail(result.diagnostics[0]?.message ?? 'Query failed');
  return true;
}

function nonEmpty(values: readonly string[] | undefined) {
  return values?.length === 0 ? undefined : values;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function trackerFor(program: RootCommand) {
  const options = program.opts();
  return createTracker(
    options.workspace ?? join(homedir(), '.local', 'state', 'tickets')
  );
}

async function selectedTracker(
  program: RootCommand,
  selectProject: SelectProjectForCli
): Promise<SelectedTracker | null> {
  const tracker = trackerFor(program);
  const explicitProject = program.opts().project;
  if (explicitProject !== undefined && !validName('project', explicitProject)) {
    return null;
  }

  const selection = await selectProjectSafely(selectProject, {
    cwd: process.cwd(),
    explicitProject,
    loadProjects: () => loadProjectRepositories(tracker),
  });
  if (selection === null) return null;
  if (!selection.ok) {
    fail(formatProjectSelectionFailure(selection));
    return null;
  }
  return { project: selection.project, tracker };
}

async function selectProjectSafely(
  selectProject: SelectProjectForCli,
  options: SelectProjectOptions
): Promise<ProjectSelection | null> {
  try {
    return await selectProject(options);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return null;
  }
}

async function loadProjectRepositories(
  tracker: Tracker
): Promise<readonly ProjectRepository[]> {
  const discovery = await tracker.discoverProjects();
  if (discovery.diagnostics.length > 0) {
    throw new Error(
      discovery.diagnostics[0]?.message ?? 'Could not discover projects'
    );
  }

  return await Promise.all(
    discovery.entries.map(async (project) => {
      const document = await tracker.readProject(project.name);
      if (!document.ok) return { name: project.name };
      const gitRepo = document.value.metadata['Git-Repo'];
      return {
        name: project.name,
        gitRepo: typeof gitRepo === 'string' ? gitRepo : undefined,
      };
    })
  );
}

function partialFailure(
  diagnostics: Parameters<typeof writeDiagnostics>[0]
): void {
  if (diagnostics.length === 0) return;
  writeDiagnostics(diagnostics);
  process.exitCode = 2;
}

function fail(message: string): void {
  writeDiagnostic(message);
  process.exitCode = 2;
}
