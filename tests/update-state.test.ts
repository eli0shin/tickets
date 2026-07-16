import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readUpdateState,
  writeUpdateState,
  shouldCheckForUpdate,
  getUpdateStatePath,
} from '../src/update-state.ts';

let testDirectory: string | undefined;

async function statePath(): Promise<string> {
  testDirectory = await mkdtemp(join(tmpdir(), 'tickets-update-state-'));
  return join(testDirectory, 'state');
}

afterEach(async () => {
  if (testDirectory !== undefined) {
    await rm(testDirectory, { recursive: true, force: true });
    testDirectory = undefined;
  }
});

describe('getUpdateStatePath', () => {
  test('returns the Tickets state path', () => {
    expect(getUpdateStatePath()).toMatch(/\.tickets-update-state$/);
  });
});

describe('readUpdateState', () => {
  test('returns null when the file is absent, invalid JSON, or malformed', async () => {
    const path = await statePath();
    expect(await readUpdateState(path)).toEqual({ success: true, data: null });

    await Bun.write(path, 'not valid json');
    expect(await readUpdateState(path)).toEqual({ success: true, data: null });

    await Bun.write(path, JSON.stringify({ other: 1 }));
    expect(await readUpdateState(path)).toEqual({ success: true, data: null });
  });

  test('returns persisted state including a pending notification', async () => {
    const path = await statePath();
    const state = {
      lastCheckedAt: 1_704_326_400_000,
      pendingNotification: '1.2.3',
    };
    await Bun.write(path, JSON.stringify(state));

    expect(await readUpdateState(path)).toEqual({ success: true, data: state });
  });
});

describe('writeUpdateState', () => {
  test('writes and overwrites state', async () => {
    const path = await statePath();
    expect(
      await writeUpdateState(path, { lastCheckedAt: 1_704_326_400_000 })
    ).toEqual({ success: true, data: undefined });
    expect(JSON.parse(await Bun.file(path).text())).toEqual({
      lastCheckedAt: 1_704_326_400_000,
    });

    const next = {
      lastCheckedAt: 1_704_326_500_000,
      pendingNotification: '2.0.0',
    };
    expect(await writeUpdateState(path, next)).toEqual({
      success: true,
      data: undefined,
    });
    expect(JSON.parse(await Bun.file(path).text())).toEqual(next);
  });
});

describe('shouldCheckForUpdate', () => {
  test('uses the 24-hour default and a configurable interval', () => {
    const now = Date.now();
    expect(shouldCheckForUpdate(null)).toBe(true);
    expect(shouldCheckForUpdate({ lastCheckedAt: now })).toBe(false);
    expect(
      shouldCheckForUpdate({ lastCheckedAt: now - 24 * 60 * 60 * 1000 - 1 })
    ).toBe(true);
    expect(
      shouldCheckForUpdate({ lastCheckedAt: now - 2 * 60 * 60 * 1000 }, 1)
    ).toBe(true);
    expect(
      shouldCheckForUpdate({ lastCheckedAt: now - 30 * 60 * 1000 }, 1)
    ).toBe(false);
  });
});
