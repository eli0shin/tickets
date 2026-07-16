import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from '@commander-js/extra-typings';
import {
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
} from '../tracker/index.ts';

type GlobalOptions = {
  readonly workspace?: string;
  readonly project?: string;
};

type RootCommand = Command<[], GlobalOptions, Record<string, never>>;

export function addReadOnlyCommands(program: RootCommand): void {
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
      const selected = selectedProject(program);
      if (selected === null) return;
      const tracker = trackerFor(program);
      const result = await tracker.discoverStatuses(selected);
      if (result.diagnostics.length > 0) {
        fail(result.diagnostics[0]?.message ?? 'Could not list statuses');
        return;
      }
      writeStatusList(selected, result.entries, Boolean(options.json));
    });

  program
    .command('show')
    .description('show a complete ticket document')
    .argument('<reference>')
    .action(async (reference: string) => {
      const selected = selectedProject(program);
      if (selected === null) return;
      const result = await trackerFor(program).showTicket(selected, reference);
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
      const selected = selectedProject(program);
      if (selected === null || !validName('status', statusName)) return;
      const result = await trackerFor(program).listTickets(
        selected,
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
        const selected = selectedProject(program);
        if (selected === null || !validCriteria(options)) return;
        const criteria = {
          statuses: nonEmpty(options.status),
          tags: nonEmpty(options.tag),
          assignedTo: nonEmpty(options.assignedTo),
          unassigned: options.unassigned,
          parents: nonEmpty(options.parent),
          blockedBy: nonEmpty(options.blockedBy),
          unblocked: options.unblocked,
        } satisfies SearchCriteria;
        const result = await trackerFor(program).searchTickets(
          selected,
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

function selectedProject(program: RootCommand): string | null {
  const project = program.opts().project;
  if (project !== undefined)
    return validName('project', project) ? project : null;
  fail('Could not select a project; use --project <name>');
  return null;
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
