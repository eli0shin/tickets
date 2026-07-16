import { createProgram } from '../../src/cli.ts';

await createProgram({
  interactive: true,
  confirmOverwrite: async () => process.env.TICKETS_TEST_CONFIRM === 'yes',
}).parseAsync(process.argv);
