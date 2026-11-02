import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTracker } from '../src/tracker/index.ts';
import { startUiServer } from '../src/ui/index.ts';
import type { createDashboard } from '../src/ui/dashboard.ts';

type Dashboard = ReturnType<typeof createDashboard>;
type Board = Extract<
  Awaited<ReturnType<Dashboard['board']>>,
  { ok: true }
>['value'];
type Catalog = Extract<
  Awaited<ReturnType<Dashboard['projects']>>,
  { ok: true }
>['value'];
type Detail = Extract<
  Awaited<ReturnType<Dashboard['ticket']>>,
  { ok: true }
>['value'];

function serverUrl(): URL {
  if (!server) throw new Error('Server is not running');
  return server.url;
}

async function json<T>(response: Response): Promise<T> {
  // Wire responses are checked by the integration assertions, not a second schema.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return response.json() as Promise<T>;
}

let root: string;
let workspace: string;
let server: Bun.Server<undefined> | undefined;
const repositoryRoot = join(import.meta.dir, '..');

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tickets-ui-'));
  workspace = join(root, 'workspace');
});
afterEach(async () => {
  await server?.stop(true);
  server = undefined;
  await rm(root, { recursive: true, force: true });
});

async function start(
  options: { cwd?: string; includeEmbedded?: boolean; project?: string } = {}
) {
  const result = await startUiServer({
    workspaceRoot: workspace,
    cwd: options.cwd ?? root,
    includeEmbedded: options.includeEmbedded ?? true,
    project: options.project,
  });
  if (!result.ok) throw new Error(result.diagnostic.message);
  server = result.value;
  return server.url.origin;
}

async function get(path: string) {
  if (!server) throw new Error('Server is not running');
  return fetch(new URL(path, server.url));
}

async function project(name = 'alpha') {
  const tracker = createTracker(workspace);
  expect((await tracker.createProject(name)).ok).toBe(true);
}

async function ticket(
  projectName: string,
  status: string,
  name: string,
  metadata = '',
  body = ''
) {
  const directory = join(workspace, projectName, status);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${name}.md`),
    `---\n${metadata}\n---\n${body}`
  );
}

async function fixture() {
  await project();
  await project('beta');
  await ticket(
    'alpha',
    'todo',
    '001-root',
    'Assigned-To: Pi\nTags: [design, cli]',
    '# **Human** title\n\nSearchable content.'
  );
  await ticket(
    'alpha',
    'todo',
    '002-child',
    'Tags: [design]\nBlocked-By: [001-root]',
    '# Child'
  );
  await ticket(
    'alpha',
    'in-progress',
    '003-cross',
    'Blocked-By: [beta/001-external]',
    '# Cross-project'
  );
  await ticket('alpha', 'done', '004-completed', '', '# Completed');
  await ticket(
    'alpha',
    'review',
    '005-fallback-name',
    '',
    '```md\n# Not the title\n```\nA body without an H1.'
  );
  await ticket('beta', 'todo', '001-external', '', '# External');
}

describe('local dashboard HTTP boundary', () => {
  test('catalog and board use the filesystem and retain empty/custom statuses', async () => {
    await fixture();
    await mkdir(join(workspace, 'alpha', 'waiting'));
    const origin = await start();
    expect(server?.hostname).toBe('127.0.0.1');
    expect(await (await get('/api/projects')).json()).toEqual({
      projects: [
        {
          name: 'alpha',
          key: 'global/alpha',
          path: join(workspace, 'alpha'),
          scope: 'global',
        },
        {
          name: 'beta',
          key: 'global/beta',
          path: join(workspace, 'beta'),
          scope: 'global',
        },
      ],
      initialProject: 'global/alpha',
    });
    const response = await get('/api/board?project=global/alpha');
    const body = await json<Board>(response);
    expect(body.statuses).toEqual([
      'todo',
      'in-progress',
      'review',
      'waiting',
      'done',
    ]);
    expect(
      body.tickets.map((t: { name: string; title: string }) => [
        t.name,
        t.title,
      ])
    ).toEqual([
      ['001-root', 'Human title'],
      ['002-child', 'Child'],
      ['003-cross', 'Cross-project'],
      ['004-completed', 'Completed'],
      ['005-fallback-name', 'fallback name'],
    ]);
    expect(body.tags).toEqual(['cli', 'design']);
    expect(body.blockers).toEqual(['001-root', 'beta/001-external']);
    expect(body.diagnostics).toEqual([]);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(origin).toBe(serverUrl().origin);
  });

  test('unblocked, tags, literal blocker selectors, and cross-project blockers match CLI semantics', async () => {
    await fixture();
    await start();
    for (const [query, ids] of [
      ['unblocked=true', ['1', '5']],
      ['unblocked=true&tag=design&tag=cli', ['1']],
      ['blockedBy=001', ['2']],
      ['blockedBy=beta/001', ['3']],
      ['q=searchable', ['1']],
      ['q=does-not-exist', []],
    ] as const) {
      const response = await get(`/api/board?project=global/alpha&${query}`);
      expect(response.status).toBe(200);
      const body = await json<Board>(response);
      expect(body.tickets.map((t: { id: string }) => t.id)).toEqual([...ids]);
      expect(body.statuses).toEqual(['todo', 'in-progress', 'review', 'done']);
    }
    const conflict = await get(
      '/api/board?project=global/alpha&unblocked=true&blockedBy=001'
    );
    expect(conflict.status).toBe(400);
    expect(
      (await json<{ error: { message: string } }>(conflict)).error.message
    ).toBe('Blocked and unblocked criteria cannot be combined');
  });

  test('embedded project from a nested launch directory coexists with a same-named global project', async () => {
    await project();
    const repo = join(root, 'alpha');
    const local = join(repo, '.tickets');
    await mkdir(join(local, 'todo'), { recursive: true });
    await writeFile(
      join(local, 'project.md'),
      '---\nDefault-Status: todo\n---\n'
    );
    await writeFile(
      join(local, 'todo/001-local.md'),
      '---\nBlocked-By: [alpha/001-global]\n---\n# Local'
    );
    await ticket('alpha', 'todo', '001-global', '', '# Global');
    const cwd = join(repo, 'src/deep');
    await mkdir(cwd, { recursive: true });
    await start({ cwd });
    expect(await (await get('/api/projects')).json()).toEqual({
      projects: [
        { name: 'alpha', key: 'local/alpha', path: local, scope: 'local' },
        {
          name: 'alpha',
          key: 'global/alpha',
          path: join(workspace, 'alpha'),
          scope: 'global',
        },
      ],
      initialProject: 'local/alpha',
    });
    const board = await json<Board>(
      await get('/api/board?project=local/alpha&blockedBy=alpha/001')
    );
    expect(board.tickets.map((t: { title: string }) => t.title)).toEqual([
      'Local',
    ]);
    expect(board.blockers).toEqual(['alpha/001-global']);
    const globals = await json<Board>(
      await get('/api/board?project=global/alpha')
    );
    expect(globals.tickets.map((t: { title: string }) => t.title)).toEqual([
      'Global',
    ]);
  });

  test('a Git-origin match selects the initial global project', async () => {
    await project('alpha');
    await project('beta');
    const repo = join(root, 'repo');
    await mkdir(repo);
    for (const args of [
      ['init'],
      ['remote', 'add', 'origin', 'git@example.com:owner/repo.git'],
    ]) {
      const child = Bun.spawn(['git', '-C', repo, ...args], {
        stdout: 'ignore',
        stderr: 'ignore',
      });
      expect(await child.exited).toBe(0);
    }
    await createTracker(workspace).writeProject('beta', {
      metadata: {
        'Default-Status': 'todo',
        'Git-Repo': 'https://example.com/owner/repo',
      },
      body: '',
    });
    await start({ cwd: repo });
    expect(
      (await json<Catalog>(await get('/api/projects'))).initialProject
    ).toBe('global/beta');
  });

  test('explicit workspace context suppresses embedded discovery', async () => {
    await project();
    await mkdir(join(root, '.tickets'), { recursive: true });
    await start({ includeEmbedded: false, project: 'alpha' });
    expect(
      (await json<Catalog>(await get('/api/projects'))).projects.map(
        (p: { key: string }) => p.key
      )
    ).toEqual(['global/alpha']);
  });

  test('empty workspace needs no writes and embedded projects work without a global workspace', async () => {
    await start();
    expect(await (await get('/api/projects')).json()).toEqual({
      projects: [],
      initialProject: null,
    });
    expect(await readdir(root)).toEqual([]);
    await mkdir(join(root, '.tickets', 'todo'), { recursive: true });
    await writeFile(
      join(root, '.tickets/project.md'),
      '---\nDefault-Status: todo\n---\n'
    );
    const catalog = await json<Catalog>(await get('/api/projects'));
    expect(catalog.projects).toHaveLength(1);
    expect(catalog.projects[0].scope).toBe('local');
    expect(
      (await get(`/api/board?project=${catalog.initialProject}`)).status
    ).toBe(200);
  });

  test('explicit invalid or missing project prevents startup', async () => {
    for (const name of ['../escape', 'absent']) {
      const result = await startUiServer({
        workspaceRoot: workspace,
        cwd: root,
        includeEmbedded: false,
        project: name,
      });
      expect(result.ok).toBe(false);
    }
  });

  test('partial scans expose diagnostics without hiding valid tickets', async () => {
    await fixture();
    await ticket('alpha', 'todo', '006-broken', 'Tags: [');
    await start();
    const response = await get('/api/board?project=global/alpha');
    const board = await json<Board>(response);
    expect(response.status).toBe(200);
    expect(board.tickets).toHaveLength(5);
    expect(board.diagnostics).toHaveLength(1);
    expect(board.diagnostics[0].code).toBe('malformed-ticket-yaml');
  });

  test('rereads changed bodies, moves, and added projects without caches', async () => {
    await fixture();
    await start();
    await ticket('alpha', 'todo', '001-root', '', '# Changed');
    await rename(
      join(workspace, 'alpha/todo/001-root.md'),
      join(workspace, 'alpha/in-progress/001-root.md')
    );
    await project('gamma');
    const board = await json<Board>(
      await get('/api/board?project=global/alpha')
    );
    expect(board.tickets[0].title).toBe('Changed');
    expect(board.tickets[0].status).toBe('in-progress');
    expect(
      (await json<Catalog>(await get('/api/projects'))).projects.map(
        (p: { name: string }) => p.name
      )
    ).toEqual(['alpha', 'beta', 'gamma']);
  });

  test('ticket details include complete body and unknown metadata, with safe Markdown', async () => {
    await project();
    const body =
      '# Hello\n\n<script>alert(1)</script>\n\n[bad](javascript:alert) [ok](https://example.com)\n\n![remote](https://example.com/tracker.png)\n\n```html\n<img src=x onerror=alert(1)>\n```\n';
    await ticket(
      'alpha',
      'todo',
      '001-hello',
      'Assigned-To: Eli Oshinsky\nExtra: 9007199254740993\nTags: [docs]',
      body
    );
    await start();
    const detail = await json<Detail>(
      await get('/api/ticket?project=global/alpha&status=todo&name=001-hello')
    );
    expect(detail.body).toBe(body);
    expect(detail.metadata).toEqual({
      'Assigned-To': 'Eli Oshinsky',
      Extra: '9007199254740993',
      Tags: ['docs'],
    });
    expect(detail.assignedTo).toBe('Eli Oshinsky');
    expect(detail.html).toContain('&lt;script&gt;');
    expect(detail.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(detail.html).not.toContain('&amp;lt;');
    expect(detail.html).not.toContain('<script');
    expect(detail.html).not.toContain('<img');
    expect(detail.html).not.toContain('href="javascript:');
    expect(detail.html).toContain('href="https://example.com"');
    expect(
      await readFile(join(workspace, 'alpha/todo/001-hello.md'), 'utf8')
    ).toBe(
      `---\nAssigned-To: Eli Oshinsky\nExtra: 9007199254740993\nTags: [docs]\n---\n${body}`
    );
  });

  test('valid cyclic YAML metadata does not prevent ticket details from loading', async () => {
    await project();
    await ticket(
      'alpha',
      'todo',
      '001-alias',
      'Extra: &item { self: *item }',
      '# Aliased metadata'
    );
    await start();
    const response = await get(
      '/api/ticket?project=global/alpha&status=todo&name=001-alias'
    );
    expect(response.status).toBe(200);
    const detail = await json<Detail>(response);
    expect(detail.body).toBe('# Aliased metadata');
    expect(detail.metadata).toEqual({
      Extra: { self: '[Repeated YAML reference]' },
    });
  });

  test('no arbitrary path reads, mutations, foreign hosts, or cross-origin API access', async () => {
    await fixture();
    await start();
    expect((await get('/api/board?project=../../etc')).status).toBe(404);
    expect(
      (
        await get(
          '/api/ticket?project=global/alpha&status=../../etc&name=passwd'
        )
      ).status
    ).toBe(400);
    expect(
      (
        await get(
          '/api/ticket?project=global/alpha&status=todo&name=../../project'
        )
      ).status
    ).toBe(400);
    expect((await get('/api/unknown')).status).toBe(404);
    expect((await get('/etc/passwd')).status).toBe(404);
    expect(
      (await fetch(new URL('/api/projects', serverUrl()), { method: 'POST' }))
        .status
    ).toBe(405);
    for (const [name, value] of [
      ['Host', 'evil.example'],
      ['Origin', 'https://evil.example'],
      ['Sec-Fetch-Site', 'cross-site'],
    ]) {
      expect(
        (
          await fetch(new URL('/api/projects', serverUrl()), {
            headers: { [name]: value },
          })
        ).status
      ).toBe(403);
    }
    const response = await get('/');
    expect(response.headers.get('content-security-policy')).toContain(
      "script-src 'self'"
    );
    expect(response.headers.get('content-security-policy')).not.toContain(
      'unsafe-inline'
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('serves a quiet dark board without prototype chrome or assignee filters', async () => {
    await start();
    const html = await (await get('/')).text();
    expect(html).toContain('name="color-scheme" content="dark"');
    expect(html).toContain('Unblocked');
    expect(html).toContain('Blocked by…');
    for (const unwanted of [
      'How projects are found',
      'Viewing',
      'All assignees',
      'Assigned to Eli',
      'prototype-dock',
      'result-count',
    ])
      expect(html).not.toContain(unwanted);
    expect(await (await get('/app.js')).text()).toContain('/api/board');
    expect((await get('/style.css')).headers.get('content-type')).toBe(
      'text/css; charset=utf-8'
    );
    const head = await fetch(new URL('/', serverUrl()), { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });
});

async function exerciseCli(command: string[], open = false) {
  const child = Bun.spawn(
    [
      ...command,
      '--workspace',
      workspace,
      'ui',
      ...(open ? [] : ['--no-open']),
    ],
    {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        HOME: root,
        PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`,
        XDG_CONFIG_HOME: join(root, '.config'),
      },
    }
  );
  try {
    const reader = child.stdout.getReader();
    let output = '';
    while (!output.includes('\n')) {
      const { value, done } = await reader.read();
      if (done) break;
      output += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    const url = output.trim();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(await (await fetch(url)).text()).toContain('id="unblocked"');
    expect(await (await fetch(new URL('app.js', url))).text()).toContain(
      '/api/board'
    );
    expect(
      (await json<Catalog>(await fetch(new URL('api/projects', url))))
        .initialProject
    ).toBe('global/alpha');
    if (open) {
      const capture = Bun.file(join(root, 'browser-url'));
      const deadline = Date.now() + 3000;
      while (!(await capture.exists())) {
        if (Date.now() > deadline)
          throw new Error('Browser launcher was not called');
        await Bun.sleep(10);
      }
      expect(await capture.text()).toBe(`${url}\n`);
    }
  } finally {
    child.kill('SIGTERM');
    await child.exited;
    expect(child.exitCode).toBe(0);
    expect(await new Response(child.stderr).text()).toBe('');
  }
}

test('source CLI starts, prints its URL, and shuts down on SIGTERM', async () => {
  await project();
  await exerciseCli(['bun', join(repositoryRoot, 'src/cli.ts')]);
}, 15000);

test('CLI opens the default browser with the server URL', async () => {
  await project();
  const bin = join(root, 'bin');
  await mkdir(bin);
  const launcher = join(
    bin,
    process.platform === 'darwin' ? 'open' : 'xdg-open'
  );
  await writeFile(
    launcher,
    '#!/bin/sh\nprintf "%s\\n" "$1" > "$HOME/browser-url"\n'
  );
  await chmod(launcher, 0o755);
  await exerciseCli(['bun', join(repositoryRoot, 'src/cli.ts')], true);
}, 15000);

test('compiled executable embeds all UI assets and runs outside the repository', async () => {
  await project();
  await mkdir(join(root, '.config/tickets'), { recursive: true });
  await writeFile(
    join(root, '.config/tickets/config.json'),
    '{"config":{"updateBehavior":"off"}}'
  );
  const executable = join(root, 'tickets');
  const build = Bun.spawn(
    [
      'bun',
      'build',
      join(repositoryRoot, 'src/cli.ts'),
      '--compile',
      '--outfile',
      executable,
    ],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' }
  );
  expect(await build.exited).toBe(0);
  await exerciseCli([executable]);
}, 30000);

test('CLI rejects invalid ports without starting a server', async () => {
  const child = Bun.spawn(
    ['bun', join(repositoryRoot, 'src/cli.ts'), 'ui', '--port', '65536'],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' }
  );
  expect(await child.exited).toBe(2);
  expect(await new Response(child.stdout).text()).toBe('');
  expect(await new Response(child.stderr).text()).toBe(
    'Port must be an integer between 0 and 65535\n'
  );
});
