import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { installSkill } from '../src/skill.ts';

const assetPath = join(import.meta.dir, '../assets/tickets/SKILL.md');
const temporaryDirectories: string[] = [];

async function temporaryTarget(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'tickets-skill-'));
  temporaryDirectories.push(directory);
  return join(directory, 'nested', 'tickets');
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe('skill installation', () => {
  test('creates an exact target and installs the bundled source bytes', async () => {
    const target = await temporaryTarget();

    expect(await installSkill({ target })).toEqual({
      status: 'installed',
      path: resolve(target, 'SKILL.md'),
    });
    expect(await readFile(join(target, 'SKILL.md'))).toEqual(
      await readFile(assetPath)
    );
  });

  test('asks for confirmation before replacing an existing skill', async () => {
    const target = await temporaryTarget();
    const installedPath = join(target, 'SKILL.md');
    await mkdir(target, { recursive: true });
    await writeFile(installedPath, 'old skill');
    const confirmOverwrite = mock(async () => true);

    expect(
      await installSkill({
        target,
        interactive: true,
        confirmOverwrite,
      })
    ).toEqual({ status: 'installed', path: installedPath });
    expect(confirmOverwrite).toHaveBeenCalledTimes(1);
    expect(confirmOverwrite).toHaveBeenCalledWith(installedPath);
    expect(await readFile(installedPath)).toEqual(await readFile(assetPath));
  });

  test('declining preserves the existing skill and succeeds without a write', async () => {
    const target = await temporaryTarget();
    const installedPath = join(target, 'SKILL.md');
    await mkdir(target, { recursive: true });
    await writeFile(installedPath, 'keep me');

    expect(
      await installSkill({
        target,
        interactive: true,
        confirmOverwrite: async () => false,
      })
    ).toEqual({ status: 'declined' });
    expect(await readFile(installedPath, 'utf8')).toBe('keep me');
  });

  test('fails non-interactively when the skill already exists', async () => {
    const target = await temporaryTarget();
    const installedPath = join(target, 'SKILL.md');
    await mkdir(target, { recursive: true });
    await writeFile(installedPath, 'keep me');

    expect(await installSkill({ target, interactive: false })).toEqual({
      status: 'error',
      message: `${installedPath} already exists; use --force to overwrite it`,
    });
    expect(await readFile(installedPath, 'utf8')).toBe('keep me');
  });

  test('--force replaces only SKILL.md without confirmation', async () => {
    const target = await temporaryTarget();
    const installedPath = join(target, 'SKILL.md');
    const unrelatedPath = join(target, 'notes.txt');
    await mkdir(target, { recursive: true });
    await writeFile(installedPath, 'old skill');
    await writeFile(unrelatedPath, 'preserve me');

    expect(
      await installSkill({
        target,
        force: true,
        confirmOverwrite: async () => {
          throw new Error('confirmation should not run');
        },
      })
    ).toEqual({ status: 'installed', path: installedPath });
    expect(await readFile(installedPath)).toEqual(await readFile(assetPath));
    expect(await readFile(unrelatedPath, 'utf8')).toBe('preserve me');
  });
});
