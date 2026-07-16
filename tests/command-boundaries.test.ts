import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listProjects, validateReference } from '../src/commands/read.ts';
import { createTracker } from '../src/tracker/index.ts';

const sourceRoot = join(import.meta.dir, '../src');
let temporaryWorkspace: string | undefined;

afterEach(async () => {
  if (temporaryWorkspace !== undefined) {
    await rm(temporaryWorkspace, { recursive: true, force: true });
    temporaryWorkspace = undefined;
  }
});

describe('command module boundaries', () => {
  test('keeps Commander grammar, rendering, and process state out of command modules', async () => {
    const commandRoot = join(sourceRoot, 'commands');
    const commandFiles = (await readdir(commandRoot)).filter((path) =>
      path.endsWith('.ts')
    );

    for (const path of commandFiles) {
      const source = await readFile(join(commandRoot, path), 'utf8');
      expect(source).not.toMatch(/from\s+['"][^'"]*commander[^'"]*['"]/u);
      expect(source).not.toMatch(/from\s+['"][^'"]*output\.ts['"]/u);
      expect(source).not.toContain('createTracker');
      expect(source).not.toMatch(
        /(?:console\.|process\.(?:stdout|stderr|exit|exitCode)|Bun\.write)/u
      );
    }

    const cliSource = await readFile(join(sourceRoot, 'cli.ts'), 'utf8');
    expect(cliSource).toContain("from '@commander-js/extra-typings'");
    expect(cliSource).not.toContain('process.exitCode');

    const outputSource = await readFile(join(sourceRoot, 'output.ts'), 'utf8');
    expect(outputSource).toContain('process.exitCode');
  });

  test('returns structured read outcomes for success and validation failure', async () => {
    temporaryWorkspace = await mkdtemp(join(tmpdir(), 'tickets-commands-'));
    const tracker = createTracker(temporaryWorkspace);

    expect(await listProjects(tracker)).toEqual({ ok: true, value: [] });
    expect(validateReference('INVALID')).toEqual({
      ok: false,
      failure: {
        kind: 'message',
        message: 'Invalid ticket reference: INVALID',
      },
    });
  });
});
