#!/usr/bin/env bun
import { Command } from '@commander-js/extra-typings';
import { CommanderError } from 'commander';
import { version } from '../package.json';
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
