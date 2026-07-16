import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runUpdaterWorker } from '../src/updater-worker.ts';
import { getUpdateStatePath, readUpdateState } from '../src/update-state.ts';

const originalArgv = process.argv;
const originalFetch = globalThis.fetch;
const originalStateHome = process.env.XDG_STATE_HOME;
let directory: string | undefined;

function responseFetch(...responses: Response[]): typeof fetch {
  const fallback = responses.at(-1);
  if (fallback === undefined) throw new Error('A response is required');
  let index = 0;
  return Object.assign(
    mock(() => Promise.resolve(responses[index++] ?? fallback)),
    { preconnect: originalFetch.preconnect }
  );
}

async function prepareWorker(
  behavior: 'auto' | 'notify' | 'off' = 'auto'
): Promise<string> {
  directory = await mkdtemp(join(tmpdir(), 'tickets-worker-'));
  process.env.XDG_STATE_HOME = directory;
  const binaryPath = join(directory, 'tickets');
  await writeFile(binaryPath, 'old binary');
  process.argv = [
    originalArgv[0] ?? 'bun',
    originalArgv[1] ?? 'test',
    '--update-worker',
    '1.0.0',
    binaryPath,
    behavior,
  ];
  return binaryPath;
}

afterEach(async () => {
  process.argv = originalArgv;
  globalThis.fetch = originalFetch;
  if (originalStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = originalStateHome;
  if (directory !== undefined) {
    await rm(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

describe('runUpdaterWorker', () => {
  test('persists a notify-mode pending version without downloading', async () => {
    await prepareWorker('notify');
    globalThis.fetch = responseFetch(
      new Response(JSON.stringify({ tag_name: 'v1.1.0' }), { status: 200 })
    );

    await runUpdaterWorker();

    const result = await readUpdateState();
    expect(result.success).toBe(true);
    if (!result.success || result.data === null) {
      throw new Error('Expected update state');
    }
    expect({
      pendingNotification: result.data.pendingNotification,
      recent: Date.now() - result.data.lastCheckedAt < 5_000,
    }).toEqual({ pendingNotification: '1.1.0', recent: true });
  });

  test('skips prereleases and records the completed check', async () => {
    await prepareWorker();
    globalThis.fetch = responseFetch(
      new Response(JSON.stringify({ tag_name: 'v2.0.0-beta.1' }), {
        status: 200,
      })
    );

    await runUpdaterWorker();

    const result = await readUpdateState();
    expect(result.success && result.data !== null).toBe(true);
  });

  test('silently installs a stable update and persists state', async () => {
    const binaryPath = await prepareWorker();
    globalThis.fetch = responseFetch(
      new Response(JSON.stringify({ tag_name: 'v1.1.0' }), { status: 200 }),
      new Response('new binary', { status: 200 })
    );

    await runUpdaterWorker();

    expect(await readFile(binaryPath, 'utf8')).toBe('new binary');
    const state = await readUpdateState();
    expect(state.success && state.data !== null).toBe(true);
  });

  test('leaves the timestamp absent after fetch exceptions so checks retry sooner', async () => {
    await prepareWorker();
    globalThis.fetch = Object.assign(
      mock(() => Promise.reject(new Error('offline'))),
      { preconnect: originalFetch.preconnect }
    );

    await expect(runUpdaterWorker()).resolves.toBeUndefined();
    expect(await Bun.file(getUpdateStatePath()).exists()).toBe(false);
  });

  test('records a completed check after download failure', async () => {
    await prepareWorker();
    globalThis.fetch = responseFetch(
      new Response(JSON.stringify({ tag_name: 'v1.1.0' }), { status: 200 }),
      new Response('', { status: 503 })
    );

    await runUpdaterWorker();

    const state = await readUpdateState();
    expect(state.success && state.data !== null).toBe(true);
  });
});
