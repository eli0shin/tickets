import { createProgram } from '../../src/cli.ts';

await createProgram({ interactive: true }).parseAsync(process.argv);
