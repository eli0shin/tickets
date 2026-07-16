import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repositoryRoot = join(import.meta.dir, '..');
const installerPath = join(repositoryRoot, 'install.sh');
const temporaryDirectories: string[] = [];

type RunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

async function fixture(
  os: string,
  architecture: string
): Promise<{
  home: string;
  path: string;
  curlPath: string;
  mvPath: string;
  downloadedUrlPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'tickets-installer-'));
  temporaryDirectories.push(root);
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  const downloadedUrlPath = join(root, 'downloaded-url');
  const curlPath = join(bin, 'curl');
  const mvPath = join(bin, 'mv');
  await mkdir(bin);

  await Bun.write(
    join(bin, 'uname'),
    `#!/bin/sh\ncase "$1" in\n  -s) printf '%s\\n' '${os}' ;;\n  -m) printf '%s\\n' '${architecture}' ;;\nesac\n`
  );
  await Bun.write(
    curlPath,
    `#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  case "$1" in\n    -o) output="$2"; shift 2 ;;\n    *) url="$1"; shift ;;\n  esac\ndone\nprintf 'native tickets binary' > "$output"\nprintf '%s' "$url" > '${downloadedUrlPath}'\n`
  );
  await Promise.all([chmod(join(bin, 'uname'), 0o755), chmod(curlPath, 0o755)]);

  return {
    home,
    path: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    curlPath,
    mvPath,
    downloadedUrlPath,
  };
}

async function runInstaller(home: string, path: string): Promise<RunResult> {
  const child = Bun.spawn(['bash', installerPath], {
    cwd: repositoryRoot,
    env: { ...process.env, HOME: home, PATH: path },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe('binary installer', () => {
  for (const [system, machine, artifact] of [
    ['Linux', 'x86_64', 'tickets-linux-x64'],
    ['Linux', 'aarch64', 'tickets-linux-arm64'],
    ['Darwin', 'x86_64', 'tickets-darwin-x64'],
    ['Darwin', 'arm64', 'tickets-darwin-arm64'],
  ] as const) {
    test(`installs ${artifact} as the only payload`, async () => {
      const { home, path, downloadedUrlPath } = await fixture(system, machine);
      const installedPath = join(home, '.local/bin/tickets');

      expect(await runInstaller(home, path)).toEqual({
        stdout: `Installed tickets to ${installedPath}\n\nAdd this to your shell profile to use tickets:\n  export PATH="$HOME/.local/bin:$PATH"\n`,
        stderr: '',
        exitCode: 0,
      });
      expect(await readFile(downloadedUrlPath, 'utf8')).toBe(
        `https://github.com/eli0shin/tickets/releases/latest/download/${artifact}`
      );
      expect(await readFile(installedPath, 'utf8')).toBe(
        'native tickets binary'
      );
      expect((await stat(installedPath)).mode & 0o111).not.toBe(0);
      expect(await readdir(join(home, '.local/bin'))).toEqual(['tickets']);
    });
  }

  for (const destinationKind of ['directory', 'symlink to a directory']) {
    test(`rejects a ${destinationKind} at the binary destination`, async () => {
      const { home, path, downloadedUrlPath } = await fixture(
        'Linux',
        'x86_64'
      );
      const installDirectory = join(home, '.local/bin');
      const installedPath = join(installDirectory, 'tickets');
      await mkdir(installDirectory, { recursive: true });

      if (destinationKind === 'directory') {
        await mkdir(installedPath);
      } else {
        const directoryTarget = join(home, 'existing-directory');
        await mkdir(directoryTarget);
        await symlink(directoryTarget, installedPath, 'dir');
      }

      expect(await runInstaller(home, path)).toEqual({
        stdout: '',
        stderr: `Cannot install tickets: ${installedPath} is a directory\n`,
        exitCode: 1,
      });
      expect(await Bun.file(downloadedUrlPath).exists()).toBe(false);
    });
  }

  test('rejects a destination that becomes a directory during download', async () => {
    const { home, path, curlPath } = await fixture('Linux', 'x86_64');
    const installDirectory = join(home, '.local/bin');
    const installedPath = join(installDirectory, 'tickets');
    await writeFile(curlPath, `#!/bin/sh\nmkdir '${installedPath}'\nexit 0\n`);
    await chmod(curlPath, 0o755);

    expect(await runInstaller(home, path)).toEqual({
      stdout: '',
      stderr: `Cannot install tickets: ${installedPath} is a directory\n`,
      exitCode: 1,
    });
    expect(await readdir(installDirectory)).toEqual(['tickets']);
  });

  test('rejects a destination that becomes a directory during the move', async () => {
    const { home, path, mvPath } = await fixture('Linux', 'x86_64');
    const installDirectory = join(home, '.local/bin');
    const installedPath = join(installDirectory, 'tickets');
    await writeFile(
      mvPath,
      '#!/bin/sh\nmkdir "$3"\nexec /bin/mv -f "$2" "$3"\n'
    );
    await chmod(mvPath, 0o755);

    expect(await runInstaller(home, path)).toEqual({
      stdout: '',
      stderr: `Cannot install tickets: ${installedPath} is a directory\n`,
      exitCode: 1,
    });
    expect(await readdir(installedPath)).toEqual([]);
  });

  test('preserves an existing binary when a download fails', async () => {
    const { home, path, curlPath } = await fixture('Linux', 'x86_64');
    const installDirectory = join(home, '.local/bin');
    const installedPath = join(installDirectory, 'tickets');
    await mkdir(installDirectory, { recursive: true });
    await writeFile(installedPath, 'working tickets binary');
    await writeFile(
      curlPath,
      '#!/bin/sh\nwhile [ "$1" != "-o" ]; do shift; done\nprintf partial > "$2"\nexit 22\n'
    );
    await chmod(curlPath, 0o755);

    expect(await runInstaller(home, path)).toEqual({
      stdout: '',
      stderr: '',
      exitCode: 22,
    });
    expect(await readFile(installedPath, 'utf8')).toBe(
      'working tickets binary'
    );
    expect(await readdir(installDirectory)).toEqual(['tickets']);
  });

  test('omits PATH guidance when the installation directory is already available', async () => {
    const { home, path } = await fixture('Linux', 'x86_64');
    const installedPath = join(home, '.local/bin/tickets');

    expect(
      await runInstaller(home, `${join(home, '.local/bin')}:${path}`)
    ).toEqual({
      stdout: `Installed tickets to ${installedPath}\n`,
      stderr: '',
      exitCode: 0,
    });
  });

  test('rejects an unsupported OS before downloading', async () => {
    const { home, path, downloadedUrlPath } = await fixture(
      'Windows_NT',
      'x86_64'
    );

    expect(await runInstaller(home, path)).toEqual({
      stdout: 'Unsupported OS: windows_nt\n',
      stderr: '',
      exitCode: 1,
    });
    expect(await Bun.file(downloadedUrlPath).exists()).toBe(false);
  });

  test('rejects an unsupported architecture before downloading', async () => {
    const { home, path, downloadedUrlPath } = await fixture('Linux', 'riscv64');

    expect(await runInstaller(home, path)).toEqual({
      stdout: 'Unsupported architecture: riscv64\n',
      stderr: '',
      exitCode: 1,
    });
    expect(await Bun.file(downloadedUrlPath).exists()).toBe(false);
  });
});
