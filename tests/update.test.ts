import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { arch, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  updateCommand,
  type UpdateDependencies,
} from '../src/commands/update.ts';
import {
  downloadBinary,
  fetchLatestVersion,
  getBinaryName,
  getTicketsExecutablePath,
  isNewerVersion,
  replaceBinary,
} from '../src/update.ts';

const originalFetch = globalThis.fetch;
const temporaryDirectories: string[] = [];

function mockFetch(response: Response): typeof fetch {
  return Object.assign(
    mock(() => Promise.resolve(response)),
    {
      preconnect: originalFetch.preconnect,
    }
  );
}

function rejectedFetch(error: unknown): typeof fetch {
  return Object.assign(
    mock(() => Promise.reject(error)),
    {
      preconnect: originalFetch.preconnect,
    }
  );
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'tickets-update-'));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => {
      await rm(path, { recursive: true, force: true });
    })
  );
});

describe('native artifact selection', () => {
  test('maps every supported platform and architecture', () => {
    expect([
      getBinaryName('linux', 'x64'),
      getBinaryName('linux', 'arm64'),
      getBinaryName('darwin', 'x64'),
      getBinaryName('darwin', 'arm64'),
    ]).toEqual([
      'tickets-linux-x64',
      'tickets-linux-arm64',
      'tickets-darwin-x64',
      'tickets-darwin-arm64',
    ]);
  });

  test('builds the current platform download URL without real network access', async () => {
    globalThis.fetch = mockFetch(
      new Response(JSON.stringify({ tag_name: 'v1.2.3' }), { status: 200 })
    );
    const currentPlatform = platform() === 'darwin' ? 'darwin' : 'linux';
    const currentArchitecture = arch() === 'arm64' ? 'arm64' : 'x64';

    expect(await fetchLatestVersion()).toEqual({
      success: true,
      data: {
        version: '1.2.3',
        downloadUrl: `https://github.com/eli0shin/tickets/releases/latest/download/tickets-${currentPlatform}-${currentArchitecture}`,
      },
    });
  });
});

describe('runtime executable selection', () => {
  test('does not treat the Bun runtime as the Tickets executable', () => {
    expect(getTicketsExecutablePath()).toBeUndefined();
  });
});

describe('version comparison', () => {
  test('compares major, minor, and patch versions', () => {
    expect([
      isNewerVersion('1.0.0', '2.0.0'),
      isNewerVersion('1.0.0', '1.1.0'),
      isNewerVersion('1.0.0', '1.0.1'),
      isNewerVersion('1.2.3', '1.2.3'),
      isNewerVersion('2.0.0', '1.9.9'),
      isNewerVersion('1.2.0', '1.1.9'),
      isNewerVersion('1.0.2', '1.0.1'),
    ]).toEqual([true, true, true, false, false, false, false]);
  });
});

describe('release and download diagnostics', () => {
  test('preserves latest-release API diagnostics', async () => {
    for (const [response, expected] of [
      [new Response('', { status: 404 }), 'No releases found'],
      [new Response('', { status: 500 }), 'GitHub API error: 500'],
      [
        new Response(JSON.stringify({ name: 'missing tag' }), { status: 200 }),
        'Invalid response from GitHub API',
      ],
    ] as const) {
      globalThis.fetch = mockFetch(response);
      expect(await fetchLatestVersion()).toEqual({
        success: false,
        error: expected,
      });
    }
  });

  test('returns structured diagnostics for network failures', async () => {
    globalThis.fetch = rejectedFetch(new Error('offline'));
    expect(await fetchLatestVersion()).toEqual({
      success: false,
      error: 'GitHub API request failed: offline',
    });

    globalThis.fetch = rejectedFetch(new Error('connection reset'));
    expect(
      await downloadBinary(
        'https://example.invalid/tickets',
        await temporaryDirectory()
      )
    ).toEqual({
      success: false,
      error: 'Download failed: connection reset',
    });
  });

  test('preserves missing-artifact and download diagnostics', async () => {
    const directory = await temporaryDirectory();
    for (const [status, expected] of [
      [404, 'Binary not found for this platform'],
      [503, 'Download failed: 503'],
    ] as const) {
      globalThis.fetch = mockFetch(new Response('', { status }));
      expect(
        await downloadBinary('https://example.invalid/tickets', directory)
      ).toEqual({ success: false, error: expected });
    }
  });
});

describe('update command', () => {
  test('rejects source invocations before checking for releases', async () => {
    const fetchRelease = mock(async () => ({
      success: false as const,
      error: 'must not run',
    }));
    const dependencies = {
      fetchLatestVersion: fetchRelease,
      isNewerVersion,
      downloadBinary: async () => ({ success: true as const, data: 'unused' }),
      replaceBinary: async () => ({
        success: true as const,
        data: undefined,
      }),
    } satisfies UpdateDependencies;

    expect(await updateCommand('1.2.3', undefined, dependencies)).toEqual({
      messages: [],
      outcome: {
        ok: false,
        failure: {
          kind: 'message',
          message:
            'Cannot update from a source invocation; use the compiled Tickets executable',
        },
      },
    });
    expect(fetchRelease).toHaveBeenCalledTimes(0);
  });

  test('does not download or replace an already-current version', async () => {
    const download = mock(async () => ({
      success: true as const,
      data: 'unused',
    }));
    const replace = mock(async () => ({
      success: true as const,
      data: undefined,
    }));
    const dependencies = {
      fetchLatestVersion: async () => ({
        success: true as const,
        data: { version: '1.2.3', downloadUrl: 'unused' },
      }),
      isNewerVersion,
      downloadBinary: download,
      replaceBinary: replace,
    } satisfies UpdateDependencies;

    expect(await updateCommand('1.2.3', '/tmp/tickets', dependencies)).toEqual({
      messages: [
        'Current version: 1.2.3',
        'Checking for updates...',
        'Already on latest version (v1.2.3)',
      ],
      outcome: { ok: true, value: undefined },
    });
    expect(download).toHaveBeenCalledTimes(0);
    expect(replace).toHaveBeenCalledTimes(0);
  });

  test('downloads beside and replaces the selected executable', async () => {
    const directory = await temporaryDirectory();
    const binaryPath = join(directory, 'tickets');
    await writeFile(binaryPath, 'old binary');
    const dependencies = {
      fetchLatestVersion: async () => ({
        success: true as const,
        data: { version: '1.2.4', downloadUrl: 'mock://tickets' },
      }),
      isNewerVersion,
      downloadBinary: async (url, targetDirectory) => {
        expect({ url, targetDirectory }).toEqual({
          url: 'mock://tickets',
          targetDirectory: directory,
        });
        const temporaryPath = join(targetDirectory, '.tickets-update-test');
        await writeFile(temporaryPath, 'new binary');
        await chmod(temporaryPath, 0o755);
        return { success: true, data: temporaryPath };
      },
      replaceBinary,
    } satisfies UpdateDependencies;

    expect(await updateCommand('1.2.3', binaryPath, dependencies)).toEqual({
      messages: [
        'Current version: 1.2.3',
        'Checking for updates...',
        'Updating to v1.2.4...',
        'Updated to v1.2.4',
      ],
      outcome: { ok: true, value: undefined },
    });
    expect(await readFile(binaryPath, 'utf8')).toBe('new binary');
    expect((await stat(binaryPath)).mode & 0o777).toBe(0o755);
  });

  test('cleans a failed replacement and preserves the existing target', async () => {
    const directory = await temporaryDirectory();
    const temporaryPath = join(directory, '.tickets-update-failed');
    const targetPath = join(directory, 'tickets');
    await writeFile(temporaryPath, 'new binary');
    await mkdir(targetPath);
    await writeFile(join(targetPath, 'existing'), 'old binary');

    const result = await replaceBinary(temporaryPath, targetPath);

    expect(result.success).toBe(false);
    const error = result.success ? '' : result.error;
    expect(error).toMatch(/^Failed to replace binary: /);
    expect(await Bun.file(temporaryPath).exists()).toBe(false);
    expect(await readFile(join(targetPath, 'existing'), 'utf8')).toBe(
      'old binary'
    );
  });
});
