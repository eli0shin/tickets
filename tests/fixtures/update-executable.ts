import { getTicketsExecutablePath } from '../../src/update.ts';

process.stdout.write(`${getTicketsExecutablePath() ?? 'source'}\n`);
