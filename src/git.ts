import { spawn } from 'node:child_process';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

export type ProjectRepository = {
  name: string;
  gitRepo?: string | null;
};

export type GitOriginInspection =
  | { ok: true; origin: string }
  | { ok: false; reason: 'not-a-worktree' | 'missing-origin' }
  | {
      ok: false;
      reason: 'git-error';
      operation: 'inspect-worktree' | 'read-origin';
      detail: string;
    }
  | { ok: false; reason: 'invalid-origin' };

export type ProjectSelection =
  | { ok: true; project: string }
  | Exclude<GitOriginInspection, { ok: true }>
  | { ok: false; reason: 'no-match'; origin: string }
  | {
      ok: false;
      reason: 'ambiguous';
      origin: string;
      projects: string[];
    };

export type SelectProjectOptions = {
  cwd: string;
  explicitProject?: string;
  loadProjects: () => Promise<readonly ProjectRepository[]>;
};

const repositoryOverrideVariables = new Set([
  'GIT_CEILING_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_DIR',
  'GIT_WORK_TREE',
]);

const defaultPorts = new Map([
  ['ftp', '21'],
  ['ftps', '990'],
  ['git', '9418'],
  ['http', '80'],
  ['https', '443'],
  ['ssh', '22'],
]);

/** Normalize a host-based Git remote without making hosting-provider assumptions. */
export function normalizeRemote(remote: string): string | undefined {
  const value = remote;
  if (value === '') return undefined;

  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(value)) {
    const uri = parseUri(value);
    return uri ? normalizeLocation(uri) : undefined;
  }

  const scp = /^(?:[^@/:\s]+@)?(\[[^\]]+\]|[^/:\s]+):(.+)$/u.exec(value);
  if (!scp) return undefined;

  return normalizeLocation({
    host: scp[1],
    path: encodeLiteralPercents(scp[2]),
  });
}

/** Inspect the containing worktree's origin fetch URL. */
export async function inspectGitOrigin(
  cwd: string
): Promise<GitOriginInspection> {
  const worktree = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (!worktree.ok) {
    return worktree.stderr.includes('not a git repository')
      ? { ok: false, reason: 'not-a-worktree' }
      : {
          ok: false,
          reason: 'git-error',
          operation: 'inspect-worktree',
          detail: worktree.stderr,
        };
  }
  if (worktree.stdout !== 'true') {
    return { ok: false, reason: 'not-a-worktree' };
  }

  const originResult = await runGit(cwd, ['remote', 'get-url', 'origin']);
  if (!originResult.ok) {
    return originResult.stderr.includes("No such remote 'origin'")
      ? { ok: false, reason: 'missing-origin' }
      : {
          ok: false,
          reason: 'git-error',
          operation: 'read-origin',
          detail: originResult.stderr,
        };
  }

  if (!normalizeRemote(originResult.stdout)) {
    return { ok: false, reason: 'invalid-origin' };
  }
  return { ok: true, origin: originResult.stdout };
}

/** Select an explicit project or discover one from the containing worktree's origin. */
export async function selectProject(
  options: SelectProjectOptions
): Promise<ProjectSelection> {
  if (options.explicitProject !== undefined) {
    return { ok: true, project: options.explicitProject };
  }

  const inspection = await inspectGitOrigin(options.cwd);
  if (!inspection.ok) return inspection;
  const normalizedOrigin = normalizeRemote(inspection.origin);
  if (!normalizedOrigin) return { ok: false, reason: 'invalid-origin' };

  const matches = (await options.loadProjects())
    .filter(
      (project) =>
        project.gitRepo !== null &&
        project.gitRepo !== undefined &&
        normalizeRemote(project.gitRepo) === normalizedOrigin
    )
    .map((project) => project.name)
    .sort((left, right) => left.localeCompare(right));

  if (matches.length === 0) {
    return { ok: false, reason: 'no-match', origin: normalizedOrigin };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      origin: normalizedOrigin,
      projects: matches,
    };
  }

  return { ok: true, project: matches[0] };
}

type Location = { host: string; path: string; port?: string };

function parseUri(value: string): Location | undefined {
  try {
    const url = new URL(value);
    if (url.hostname === '' || url.pathname === '' || url.search || url.hash) {
      return undefined;
    }

    const path = canonicalizeUriPath(url.pathname);
    if (path === undefined) return undefined;

    const scheme = url.protocol.slice(0, -1).toLowerCase();
    const port = url.port === defaultPorts.get(scheme) ? '' : url.port;
    return { host: url.hostname, path, port };
  } catch {
    return undefined;
  }
}

function canonicalizeUriPath(path: string): string | undefined {
  try {
    // Decode around encoded separators, then escape decoded literal percents so
    // `%2F` and `%252F` retain distinct normalized identities.
    return path
      .split(/(%2f)/giu)
      .map((part) =>
        /^%2f$/iu.test(part)
          ? '%2f'
          : encodeLiteralPercents(decodeURIComponent(part))
      )
      .join('');
  } catch {
    return undefined;
  }
}

function encodeLiteralPercents(path: string): string {
  return path.replaceAll('%', '%25');
}

function normalizeLocation(location: Location): string | undefined {
  const host = normalizeHost(location.host);
  let path = location.path.replace(/^\/+|\/+$/gu, '').toLowerCase();
  path = path.replace(/\.git$/u, '');
  if (host === '' || path === '') return undefined;

  return `${host}${location.port ? `:${location.port}` : ''}/${path}`;
}

function normalizeHost(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) {
    const address = host.slice(1, -1);
    return isIP(address) === 6
      ? new URL(`http://${host}`).hostname.toLowerCase()
      : '';
  }

  try {
    const forbiddenHostCharacters = /[%/\\?#@:\[\]\s]/u;
    const decodedHost = decodeURIComponent(host);
    if (forbiddenHostCharacters.test(decodedHost)) return '';

    const asciiHost = domainToASCII(decodedHost).toLowerCase();
    return forbiddenHostCharacters.test(asciiHost) ? '' : asciiHost;
  } catch {
    return '';
  }
}

type GitResult = { ok: true; stdout: string } | { ok: false; stderr: string };

async function runGit(cwd: string, arguments_: string[]): Promise<GitResult> {
  return await new Promise((resolve) => {
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !repositoryOverrideVariables.has(name.toUpperCase())
      )
    );

    const child = spawn('git', ['-C', cwd, ...arguments_], {
      env: { ...environment, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      resolve({ ok: false, stderr: error.message });
    });
    child.on('close', (code) => {
      resolve(
        code === 0
          ? { ok: true, stdout: stdout.replace(/\r?\n$/u, '') }
          : { ok: false, stderr: stderr.trim() }
      );
    });
  });
}
