import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleAutoUpdate } from '../src/auto-update.ts';
import { writeUpdateState } from '../src/update-state.ts';

let testDirectory: string | undefined;

async function statePath(): Promise<string> {
  testDirectory = await mkdtemp(join(tmpdir(), 'tickets-auto-update-'));
  return join(testDirectory, 'state');
}

afterEach(async () => {
  if (testDirectory !== undefined) {
    await rm(testDirectory, { recursive: true, force: true });
    testDirectory = undefined;
  }
});

describe('handleAutoUpdate', () => {
  test('auto is silent and spawns the detached worker arguments when due', async () => {
    const path = await statePath();
    const spawn = mock((_arguments: string[]) => undefined);

    expect(await handleAutoUpdate('1.0.0', 'auto', 24, path, spawn)).toEqual({
      message: undefined,
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith([
      process.execPath,
      '--update-worker',
      '1.0.0',
      process.execPath,
      'auto',
    ]);
  });

  test('default spawning is detached, silences stdio, and unreferences the worker', async () => {
    const source = await readFile(
      join(import.meta.dir, '../src/auto-update.ts'),
      'utf8'
    );

    expect({
      detached: source.includes('detached: true'),
      ignoredStdio: source.includes("stdio: ['ignore', 'ignore', 'ignore']"),
      unreferenced: source.includes('proc.unref()'),
    }).toEqual({ detached: true, ignoredStdio: true, unreferenced: true });
  });

  test('notify returns a pending message and respects the cooldown', async () => {
    const path = await statePath();
    await writeUpdateState(path, {
      lastCheckedAt: Date.now(),
      pendingNotification: '2.0.0',
    });
    const spawn = mock((_arguments: string[]) => undefined);

    expect(await handleAutoUpdate('1.0.0', 'notify', 24, path, spawn)).toEqual({
      message: 'Update available: v2.0.0',
    });
    expect(spawn).toHaveBeenCalledTimes(0);
  });

  test('does not return a notification already satisfied by the current version', async () => {
    const path = await statePath();
    await writeUpdateState(path, {
      lastCheckedAt: Date.now(),
      pendingNotification: '1.0.0',
    });

    expect(await handleAutoUpdate('1.0.0', 'notify', 24, path)).toEqual({
      message: undefined,
    });
  });

  test('auto does not render pending notifications', async () => {
    const path = await statePath();
    await writeUpdateState(path, {
      lastCheckedAt: Date.now(),
      pendingNotification: '2.0.0',
    });

    expect(await handleAutoUpdate('1.0.0', 'auto', 24, path)).toEqual({
      message: undefined,
    });
  });

  test('off neither notifies nor spawns', async () => {
    const path = await statePath();
    const spawn = mock((_arguments: string[]) => undefined);

    expect(await handleAutoUpdate('1.0.0', 'off', 24, path, spawn)).toEqual({
      message: undefined,
    });
    expect(spawn).toHaveBeenCalledTimes(0);
  });

  test('uses the configured interval to decide when to spawn', async () => {
    const path = await statePath();
    await writeUpdateState(path, {
      lastCheckedAt: Date.now() - 2 * 60 * 60 * 1000,
    });
    const spawn = mock((_arguments: string[]) => undefined);

    expect(await handleAutoUpdate('1.0.0', 'auto', 1, path, spawn)).toEqual({
      message: undefined,
    });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith([
      process.execPath,
      '--update-worker',
      '1.0.0',
      process.execPath,
      'auto',
    ]);
  });
});
