#!/usr/bin/env bun
import { Command } from '@commander-js/extra-typings';
import { CommanderError } from 'commander';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { version } from '../package.json';
import { lintProject } from './commands/lint.ts';
import { addReadOnlyCommands } from './commands/read.ts';
import {
  selectProject,
  type ProjectRepository,
  type ProjectSelection,
  type SelectProjectOptions,
} from './git.ts';
import {
  formatProjectSelectionFailure,
  writeDiagnostic,
  writeLint,
  writeSuccess,
} from './output.ts';
import { createTracker, type DocumentDiagnostic } from './tracker/index.ts';
import {
  confirmOverwrite,
  installSkill,
  type ConfirmOverwrite,
} from './skill.ts';

type ProjectRepositoriesOutcome =
  | { readonly ok: true; readonly value: readonly ProjectRepository[] }
  | { readonly ok: false; readonly diagnostic: DocumentDiagnostic };

type CliDependencies = {
  confirmOverwrite?: ConfirmOverwrite;
  interactive?: boolean;
  cwd?: string;
};

export function createProgram({
  confirmOverwrite: confirm = confirmOverwrite,
  interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY),
  cwd = process.cwd(),
}: CliDependencies = {}): Command {
  const program = new Command()
    .exitOverride()
    .showSuggestionAfterError(false)
    .name('tickets')
    .description('Manage tickets in a local filesystem tracker')
    .version(version, '-v, --version')
    .option(
      '--workspace <path>',
      'override the default ~/.local/state/tickets workspace'
    )
    .option('--project <name>', 'select a project by name');

  addReadOnlyCommands(program);

  const skill = program.command('skill').description('manage agent skills');

  program
    .command('lint')
    .description('validate the selected project')
    .option('--json', 'emit JSON output')
    .action(async (options, command) => {
      const globals = command.optsWithGlobals();
      const workspace = resolve(
        globals.workspace ?? join(homedir(), '.local/state/tickets')
      );
      let repositoryFailure: DocumentDiagnostic | undefined;
      const selection = await selectProject({
        cwd,
        explicitProject: globals.project,
        loadProjects: async () => {
          const repositories = await loadProjectRepositories(workspace);
          if (repositories.ok) return repositories.value;
          repositoryFailure = repositories.diagnostic;
          return [];
        },
      });
      if (repositoryFailure !== undefined) {
        writeDiagnostic(repositoryFailure.message);
        process.exitCode = 2;
        return;
      }
      if (!selection.ok) {
        writeDiagnostic(formatProjectSelectionFailure(selection));
        process.exitCode = 2;
        return;
      }
      const project = selection.project;
      const result = await lintProject(workspace, project);
      if (!result.ok) {
        writeDiagnostic(result.diagnostic.message);
        process.exitCode = 2;
        return;
      }
      writeLint(project, result.violations, options.json ?? false);
      if (result.violations.length > 0) process.exitCode = 1;
    });

  skill
    .command('install')
    .description('install the bundled Tickets skill')
    .option('--target <path>', 'exact skill directory to install into')
    .option('--force', 'overwrite an existing SKILL.md without prompting')
    .action(async ({ target, force }) => {
      const result = await installSkill({
        target,
        force,
        interactive,
        confirmOverwrite: confirm,
      });

      if (result.status === 'installed') {
        writeSuccess(result.path);
      } else if (result.status === 'error') {
        writeDiagnostic(result.message);
        process.exitCode = 2;
      }
    });

  return program;
}

/** Compose CLI options and tracker-provided metadata with Git discovery. */
export async function selectProjectForCli(
  options: SelectProjectOptions
): Promise<ProjectSelection> {
  return await selectProject(options);
}

async function loadProjectRepositories(
  workspace: string
): Promise<ProjectRepositoriesOutcome> {
  const tracker = createTracker(workspace);
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

export async function run(argv: string[] = process.argv): Promise<void> {
  try {
    await createProgram().parseAsync(argv);
  } catch (error) {
    if (!(error instanceof CommanderError)) {
      throw error;
    }

    if (error.exitCode !== 0) {
      process.exitCode = 2;
    }
  }
}

if (import.meta.main) {
  await run();
}
