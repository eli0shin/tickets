#!/usr/bin/env bun
import { Command } from '@commander-js/extra-typings';
import { CommanderError } from 'commander';
import { version } from '../package.json';
import {
  selectProject,
  type ProjectRepository,
  type ProjectSelection,
} from './git.ts';
import { writeDiagnostic, writeSuccess } from './output.ts';
import {
  confirmOverwrite,
  installSkill,
  type ConfirmOverwrite,
} from './skill.ts';

type CliDependencies = {
  confirmOverwrite?: ConfirmOverwrite;
  interactive?: boolean;
};

type CliProjectSelectionOptions = {
  cwd: string;
  explicitProject?: string;
  loadProjects: () => Promise<readonly ProjectRepository[]>;
};

export function createProgram({
  confirmOverwrite: confirm = confirmOverwrite,
  interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY),
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

  const skill = program.command('skill').description('manage agent skills');

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
  options: CliProjectSelectionOptions
): Promise<ProjectSelection> {
  return await selectProject(options);
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
