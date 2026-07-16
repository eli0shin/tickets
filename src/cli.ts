#!/usr/bin/env bun
import { Command } from '@commander-js/extra-typings';
import { homedir } from 'node:os';
import {
  getConfigPath,
  getUpdateBehavior,
  getUpdateCheckInterval,
  readConfig,
} from './config.ts';
import { handleAutoUpdate } from './auto-update.ts';
import { join, resolve } from 'node:path';
import { version } from '../package.json';
import {
  createProject,
  createStatus,
  createTicket,
} from './commands/create.ts';
import { lintProject } from './commands/lint.ts';
import { completeTicket, moveTicket, renameTicket } from './commands/mutate.ts';
import {
  listProjects,
  listStatuses,
  listTickets,
  searchTickets,
  showTicket,
  validateProject,
  validateReference,
  validateSearchInput,
  validateStatus,
  type SearchInput,
} from './commands/read.ts';
import { installSkill } from './commands/skill.ts';
import { updateCommand, type UpdateDependencies } from './commands/update.ts';
import {
  selectProject,
  type ProjectRepository,
  type ProjectSelection,
  type SelectProjectOptions,
} from './git.ts';
import {
  assignUsageExitCode,
  confirmOverwrite,
  writeCommandFailure,
  writeCommandOutcome,
  writeLintOutcome,
  writeMutation,
  writeProjectList,
  writeRaw,
  writeSkillInstallation,
  writeStatusList,
  writeStderr,
  writeStdout,
  writeTicketMutation,
  writeTicketQueryResult,
  writeUnexpectedFailure,
  writeUpdateMessage,
  writeUpdateOutcome,
} from './output.ts';
import {
  createTracker,
  isNormalizedName,
  isTicketReference,
  type DocumentDiagnostic,
  type Tracker,
} from './tracker/index.ts';
import type { ConfirmOverwrite } from './skill.ts';
import type { CommandOutcome, UpdateBehavior } from './types.ts';
import { getTicketsExecutablePath } from './update.ts';
import { runUpdaterWorker } from './updater-worker.ts';

type GlobalOptions = {
  readonly workspace?: string;
  readonly project?: string;
};

type RootCommand = Command<[], GlobalOptions, Record<string, never>>;

type ProjectRepositoriesOutcome =
  | { readonly ok: true; readonly value: readonly ProjectRepository[] }
  | { readonly ok: false; readonly diagnostic: DocumentDiagnostic };

const commanderExitMarker = Symbol('expected Commander exit');

type ExpectedCommanderExit = {
  readonly [commanderExitMarker]: true;
  readonly exitCode: number;
};

type SelectProjectForCli = (
  options: SelectProjectOptions
) => Promise<ProjectSelection>;

type CliDependencies = {
  confirmOverwrite?: ConfirmOverwrite;
  selectProject?: SelectProjectForCli;
  update?: UpdateDependencies;
  interactive?: boolean;
  cwd?: string;
  executablePath?: string;
  currentVersion?: string;
  updateMessage?: string;
};

type SearchOptions = SearchInput & { readonly json?: boolean };

export function createProgram({
  confirmOverwrite: confirm = confirmOverwrite,
  selectProject: select = selectProjectForCli,
  update,
  interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY),
  cwd = process.cwd(),
  executablePath = getTicketsExecutablePath(),
  currentVersion = version,
  updateMessage,
}: CliDependencies = {}): RootCommand {
  let pendingUpdateMessage = updateMessage;
  const program = new Command()
    .configureOutput({ writeOut: writeStdout, writeErr: writeStderr })
    .exitOverride((error) => commanderExit(error.exitCode))
    .showSuggestionAfterError(false)
    .name('tickets')
    .description('Manage tickets in a local filesystem tracker')
    .version(version)
    .option(
      '--workspace <path>',
      'override the default ~/.local/state/tickets workspace'
    )
    .option('--project <name>', 'select a project by name');

  const project = program.command('project').description('manage projects');
  project
    .command('list')
    .description('list projects')
    .option('--json', 'emit JSON output')
    .action(async ({ json }) => {
      const tracker = trackerFor(program.opts().workspace);
      writeCommandOutcome(await listProjects(tracker), (projects) => {
        writeProjectList(projects, Boolean(json));
      });
    });
  project
    .command('create')
    .description('create a project')
    .argument('<name>', 'normalized project name')
    .option('--default-status <status>', 'default status (replaces todo)')
    .action(async (name, { defaultStatus }) => {
      writeMutation(
        await createProject(
          trackerFor(program.opts().workspace),
          name,
          defaultStatus
        )
      );
    });

  const status = program.command('status').description('manage statuses');
  status
    .command('list')
    .description('list statuses')
    .option('--json', 'emit JSON output')
    .action(async ({ json }) => {
      const selected = await selectedTracker(program, cwd, select, true);
      if (!selected.ok) return writeCommandFailure(selected.failure);
      writeCommandOutcome(
        await listStatuses(selected.value.tracker, selected.value.project),
        (statuses) => {
          writeStatusList(selected.value.project, statuses, Boolean(json));
        }
      );
    });
  status
    .command('create')
    .description('create a status in the selected project')
    .argument('<name>', 'normalized status name')
    .action(async (name) => {
      const selected = await selectedTracker(program, cwd, select);
      if (!selected.ok) return writeCommandFailure(selected.failure);
      writeMutation(
        await createStatus(selected.value.tracker, selected.value.project, name)
      );
    });

  program
    .command('show')
    .description('show a complete ticket document')
    .argument('<reference>')
    .action(async (reference) => {
      const validation = validateReference(reference);
      if (!validation.ok) return writeCommandFailure(validation.failure);
      const separator = reference.indexOf('/');
      const selected =
        separator === -1
          ? await selectedTracker(program, cwd, select, true)
          : successfulSelection(
              trackerFor(program.opts().workspace),
              reference.slice(0, separator)
            );
      if (!selected.ok) return writeCommandFailure(selected.failure);
      writeCommandOutcome(
        await showTicket(
          selected.value.tracker,
          selected.value.project,
          reference
        ),
        writeRaw
      );
    });

  program
    .command('list')
    .description('list tickets in one status')
    .argument('<status>')
    .option('--json', 'emit JSON output')
    .action(async (statusName, { json }) => {
      const validation = validateStatus(statusName);
      if (!validation.ok) return writeCommandFailure(validation.failure);
      const selected = await selectedTracker(program, cwd, select, true);
      if (!selected.ok) return writeCommandFailure(selected.failure);
      writeCommandOutcome(
        await listTickets(
          selected.value.tracker,
          selected.value.project,
          statusName
        ),
        (result) => {
          writeTicketQueryResult(result, Boolean(json));
        }
      );
    });

  program
    .command('search')
    .description('search tickets using structured criteria')
    .option(
      '--status <status>',
      'match tickets in this status (repeatable)',
      collect,
      []
    )
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
    .action(async (options: SearchOptions) => {
      const validation = validateSearchInput(options);
      if (!validation.ok) return writeCommandFailure(validation.failure);
      const selected = await selectedTracker(program, cwd, select, true);
      if (!selected.ok) return writeCommandFailure(selected.failure);
      writeCommandOutcome(
        await searchTickets(
          selected.value.tracker,
          selected.value.project,
          options
        ),
        (result) => {
          writeTicketQueryResult(result, Boolean(options.json));
        }
      );
    });

  program
    .command('create')
    .description('create a ticket in the selected project')
    .argument(
      '<description>',
      'human-readable text; normalized to lowercase kebab-case'
    )
    .option('--status <status>', 'status for the new ticket')
    .option('--assign <assignee>', 'assignee for the new ticket')
    .option('--tag <tag...>', 'one or more tags')
    .option('--parent <reference>', 'parent ticket reference')
    .option('--blocked-by <reference...>', 'one or more blocking references')
    .action(async (description, options) => {
      const selected = await selectedTracker(program, cwd, select);
      if (!selected.ok) return writeCommandFailure(selected.failure);
      writeMutation(
        await createTicket(selected.value.tracker, selected.value.project, {
          description,
          status: options.status,
          assignee: options.assign,
          tags: options.tag,
          parent: options.parent,
          blockedBy: options.blockedBy,
        })
      );
    });

  program
    .command('rename')
    .description('rename a ticket and update workspace references')
    .argument('<reference>', 'ticket reference')
    .argument(
      '<description>',
      'human-readable text; normalized to lowercase kebab-case'
    )
    .action(async (reference, description) => {
      if (!validMutationReference(reference)) return;
      const selected = await mutationTracker(program, cwd, select, reference);
      if (!selected.ok) return writeCommandFailure(selected.failure);
      writeTicketMutation(
        await renameTicket(
          selected.value.tracker,
          selected.value.project,
          reference,
          description
        )
      );
    });

  program
    .command('move')
    .description('move a ticket to another status')
    .argument('<reference>', 'ticket reference')
    .argument('<status>', 'destination status')
    .action(async (reference, statusName) => {
      if (!validMutationReference(reference)) return;
      if (!isNormalizedName(statusName)) {
        return writeCommandFailure({
          kind: 'message',
          message: `Invalid status name: ${statusName}`,
        });
      }
      const selected = await mutationTracker(program, cwd, select, reference);
      if (!selected.ok) return writeCommandFailure(selected.failure);
      writeTicketMutation(
        await moveTicket(
          selected.value.tracker,
          selected.value.project,
          reference,
          statusName
        )
      );
    });

  program
    .command('done')
    .description('complete a ticket')
    .argument('<reference>', 'ticket reference')
    .action(async (reference) => {
      if (!validMutationReference(reference)) return;
      const selected = await mutationTracker(program, cwd, select, reference);
      if (!selected.ok) return writeCommandFailure(selected.failure);
      writeTicketMutation(
        await completeTicket(
          selected.value.tracker,
          selected.value.project,
          reference
        )
      );
    });

  program
    .command('update')
    .description('update Tickets CLI to latest version')
    .action(async () => {
      const result = await updateCommand(
        currentVersion,
        executablePath,
        update
      );
      writeUpdateOutcome(result);
      if (result.outcome.ok) pendingUpdateMessage = undefined;
    });

  const skill = program.command('skill').description('manage agent skills');
  skill
    .command('install')
    .description('install the bundled Tickets skill')
    .option('--target <path>', 'exact skill directory to install into')
    .option('--force', 'overwrite an existing SKILL.md without prompting')
    .action(async ({ target, force }) => {
      writeSkillInstallation(
        await installSkill(
          { target, force },
          { interactive, confirmOverwrite: confirm }
        )
      );
    });

  program
    .command('lint')
    .description('validate the selected project')
    .option('--json', 'emit JSON output')
    .action(async ({ json }) => {
      const selected = await selectedTracker(program, cwd, select);
      if (!selected.ok) return writeCommandFailure(selected.failure);
      writeLintOutcome(
        selected.value.project,
        await lintProject(selected.value.tracker, selected.value.project),
        Boolean(json)
      );
    });

  program.hook('postAction', () => {
    writeUpdateMessage(pendingUpdateMessage);
  });

  return program;
}

type UpdateConfig = {
  readonly behavior: UpdateBehavior;
  readonly checkIntervalHours: number;
};

export async function getUpdateConfigFromFile(): Promise<UpdateConfig> {
  const result = await readConfig(getConfigPath());
  if (!result.success) {
    return { behavior: 'auto', checkIntervalHours: 24 };
  }
  return {
    behavior: getUpdateBehavior(result.data),
    checkIntervalHours: getUpdateCheckInterval(result.data),
  };
}

/** Compose CLI options and tracker-provided metadata with Git discovery. */
export async function selectProjectForCli(
  options: SelectProjectOptions
): Promise<ProjectSelection> {
  return await selectProject(options);
}

async function selectedTracker(
  program: RootCommand,
  cwd: string,
  select: SelectProjectForCli,
  validateExplicit = false
): Promise<
  CommandOutcome<{ readonly tracker: Tracker; readonly project: string }>
> {
  const globals = program.opts();
  const tracker = trackerFor(globals.workspace);
  if (validateExplicit) {
    const validation = validateProject(globals.project);
    if (!validation.ok) return validation;
  }
  const selected = await selectedProject(tracker, cwd, globals.project, select);
  return selected.ok ? successfulSelection(tracker, selected.value) : selected;
}

async function selectedProject(
  tracker: Tracker,
  cwd: string,
  explicitProject: string | undefined,
  select: SelectProjectForCli
): Promise<CommandOutcome<string>> {
  let repositoryFailure: DocumentDiagnostic | undefined;
  const selection = await select({
    cwd,
    explicitProject,
    loadProjects: async () => {
      const repositories = await loadProjectRepositories(tracker);
      if (repositories.ok) return repositories.value;
      repositoryFailure = repositories.diagnostic;
      return [];
    },
  });
  if (repositoryFailure !== undefined) {
    return {
      ok: false,
      failure: { kind: 'diagnostic', diagnostic: repositoryFailure },
    };
  }
  return selection.ok
    ? { ok: true, value: selection.project }
    : {
        ok: false,
        failure: { kind: 'project-selection', failure: selection },
      };
}

async function loadProjectRepositories(
  tracker: Tracker
): Promise<ProjectRepositoriesOutcome> {
  const projects = await tracker.discoverProjects();
  const discoveryFailure = projects.diagnostics.at(0);
  if (discoveryFailure !== undefined) {
    return { ok: false, diagnostic: discoveryFailure };
  }

  const repositories: ProjectRepository[] = [];
  for (const project of projects.entries) {
    const document = await tracker.readProject(project.name);
    if (!document.ok) continue;
    const gitRepo = document.value.metadata['Git-Repo'];
    if (
      gitRepo === null ||
      gitRepo === undefined ||
      typeof gitRepo === 'string'
    ) {
      repositories.push({ name: project.name, gitRepo });
    }
  }
  return { ok: true, value: repositories };
}

async function mutationTracker(
  program: RootCommand,
  cwd: string,
  select: SelectProjectForCli,
  reference: string
): Promise<
  CommandOutcome<{ readonly tracker: Tracker; readonly project: string }>
> {
  const tracker = trackerFor(program.opts().workspace);
  const separator = reference.indexOf('/');
  if (separator !== -1) {
    return successfulSelection(tracker, reference.slice(0, separator));
  }
  return selectedTracker(program, cwd, select);
}

function successfulSelection(
  tracker: Tracker,
  project: string
): CommandOutcome<{ readonly tracker: Tracker; readonly project: string }> {
  return { ok: true, value: { tracker, project } };
}

function validMutationReference(reference: string): boolean {
  if (isTicketReference(reference)) return true;
  writeCommandFailure({
    kind: 'message',
    message: `Invalid ticket reference: ${reference}`,
  });
  return false;
}

function trackerFor(workspace: string | undefined): Tracker {
  return createTracker(
    resolve(workspace ?? join(homedir(), '.local/state/tickets'))
  );
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export async function run(
  argv: string[] = process.argv,
  dependencies: CliDependencies = {}
): Promise<void> {
  const executablePath = getTicketsExecutablePath();
  if (argv[2] === '--update-worker') {
    if (executablePath !== undefined) await runUpdaterWorker();
    return;
  }

  const updateConfig = await getUpdateConfigFromFile();
  const autoUpdateResult =
    executablePath === undefined
      ? { message: undefined }
      : await handleAutoUpdate(
          version,
          updateConfig.behavior,
          updateConfig.checkIntervalHours
        ).catch(() => ({ message: undefined }));

  try {
    await createProgram({
      ...dependencies,
      executablePath: dependencies.executablePath ?? executablePath,
      updateMessage: dependencies.updateMessage ?? autoUpdateResult.message,
    }).parseAsync(argv);
  } catch (error) {
    if (isExpectedCommanderExit(error)) {
      assignUsageExitCode(error.exitCode);
      return;
    }
    writeUnexpectedFailure(error);
  }
}

function commanderExit(exitCode: number): never {
  throw {
    [commanderExitMarker]: true,
    exitCode,
  } satisfies ExpectedCommanderExit;
}

function isExpectedCommanderExit(
  error: unknown
): error is ExpectedCommanderExit {
  return (
    typeof error === 'object' && error !== null && commanderExitMarker in error
  );
}

if (import.meta.main) {
  await run();
}
