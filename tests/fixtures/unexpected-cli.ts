import { CommanderError } from 'commander';
import { run } from '../../src/cli.ts';

const failure = process.env.TICKETS_TEST_UNEXPECTED;

if (failure === 'confirmation') {
  await run(process.argv, {
    interactive: true,
    confirmOverwrite: async () => {
      throw new Error('confirmation unavailable');
    },
  });
} else {
  await run(process.argv, {
    selectProject: async () => {
      if (failure === 'commander') {
        throw new CommanderError(17, 'injected.commander', 'command exploded');
      }
      throw new Error('command failed unexpectedly\nwith context');
    },
  });
}
