import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getUpdateBehavior,
  getUpdateCheckInterval,
  readConfig,
} from '../src/config.ts';

let directory: string | undefined;

async function configPath(): Promise<string> {
  directory = await mkdtemp(join(tmpdir(), 'tickets-config-'));
  return join(directory, 'config.json');
}

afterEach(async () => {
  if (directory !== undefined) {
    await rm(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

describe('update configuration', () => {
  test('defaults to automatic checks every 24 hours', async () => {
    const result = await readConfig(await configPath());
    expect(result).toEqual({ success: true, data: {} });
    if (!result.success) throw new Error(result.error);
    expect({
      behavior: getUpdateBehavior(result.data),
      interval: getUpdateCheckInterval(result.data),
    }).toEqual({ behavior: 'auto', interval: 24 });
  });

  test('reads notify, off, and custom interval settings', async () => {
    const path = await configPath();
    await Bun.write(
      path,
      JSON.stringify({
        config: {
          updateBehavior: 'notify',
          updateCheckIntervalHours: 6,
        },
      })
    );
    const result = await readConfig(path);
    expect(result).toEqual({
      success: true,
      data: {
        config: {
          updateBehavior: 'notify',
          updateCheckIntervalHours: 6,
        },
      },
    });
    if (!result.success) throw new Error(result.error);
    expect({
      behavior: getUpdateBehavior(result.data),
      interval: getUpdateCheckInterval(result.data),
    }).toEqual({ behavior: 'notify', interval: 6 });
    expect(getUpdateBehavior({ config: { updateBehavior: 'off' } })).toBe(
      'off'
    );
  });

  test('rejects invalid update settings', async () => {
    const path = await configPath();
    await Bun.write(
      path,
      JSON.stringify({ config: { updateBehavior: 'yes' } })
    );
    expect(await readConfig(path)).toEqual({
      success: false,
      error: 'Invalid config file format',
    });
  });
});
