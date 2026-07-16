#!/usr/bin/env bun
import { Command } from '@commander-js/extra-typings';
import { version } from '../package.json';

const program = new Command()
  .name('tickets')
  .description('Manage tickets in a local filesystem tracker')
  .version(version, '-v, --version')
  .option(
    '--workspace <path>',
    'override the default ~/.local/state/tickets workspace'
  )
  .option('--project <name>', 'select a project by name');

program.parse();
