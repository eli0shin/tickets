import html from '../../assets/ui/index.html.txt' with { type: 'text' };
import css from '../../assets/ui/style.css' with { type: 'text' };
import javascript from '../../assets/ui/app.js' with { type: 'text' };
import { createDashboard, type DashboardOptions } from './dashboard.ts';

export type UiOptions = DashboardOptions & { readonly port?: number };

const securityHeaders = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

/** The HTTP boundary exposes reads of known projects, never arbitrary paths. */
export async function startUiServer(options: UiOptions) {
  const dashboard = createDashboard(options);
  const initial = await dashboard.projects();
  if (!initial.ok) return initial;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: options.port ?? 0,
    idleTimeout: 30,
    async fetch(request, server) {
      const url = new URL(request.url);
      const origin = server.url.origin;
      if (
        request.headers.get('host') !== server.url.host ||
        (request.headers.has('origin') &&
          request.headers.get('origin') !== origin) ||
        (url.pathname.startsWith('/api/') &&
          request.headers.get('sec-fetch-site') === 'cross-site')
      ) {
        return respond('Forbidden', 403);
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return respond('Method not allowed', 405, { Allow: 'GET, HEAD' });
      }
      let body: string;
      let contentType: string;
      if (url.pathname === '/') {
        body = html;
        contentType = 'text/html; charset=utf-8';
      } else if (url.pathname === '/style.css') {
        body = css;
        contentType = 'text/css; charset=utf-8';
      } else if (url.pathname === '/app.js') {
        body = javascript;
        contentType = 'text/javascript; charset=utf-8';
      } else if (url.pathname.startsWith('/api/')) {
        const project = url.searchParams.get('project') ?? '';
        const result =
          url.pathname === '/api/projects'
            ? await dashboard.projects()
            : url.pathname === '/api/board'
              ? await dashboard.board(project, {
                  tags: url.searchParams.has('tag')
                    ? url.searchParams.getAll('tag')
                    : undefined,
                  unblocked: url.searchParams.get('unblocked') === 'true',
                  blockedBy: url.searchParams.has('blockedBy')
                    ? url.searchParams.getAll('blockedBy')
                    : undefined,
                  query: url.searchParams.get('q') ?? undefined,
                })
              : url.pathname === '/api/ticket'
                ? await dashboard.ticket(
                    project,
                    url.searchParams.get('status') ?? '',
                    url.searchParams.get('name') ?? ''
                  )
                : null;
        if (result === null) return respond('Not found', 404);
        const seen = new WeakSet<object>();
        body = JSON.stringify(
          result.ok ? result.value : { error: result.diagnostic },
          (_key: string, value: unknown) => {
            if (typeof value === 'bigint') return value.toString();
            if (typeof value === 'object' && value !== null) {
              if (seen.has(value)) return '[Repeated YAML reference]';
              seen.add(value);
            }
            return value;
          }
        );
        contentType = 'application/json; charset=utf-8';
        if (!result.ok)
          return respond(
            body,
            result.diagnostic.code === 'not-found' ? 404 : 400,
            { 'Content-Type': contentType }
          );
      } else {
        return respond('Not found', 404);
      }
      return respond(request.method === 'HEAD' ? null : body, 200, {
        'Content-Type': contentType,
      });
    },
    error() {
      return respond('Unable to read the dashboard. Try refreshing.', 500);
    },
  });
  return { ok: true as const, value: server };
}

function respond(
  body: string | null,
  status: number,
  headers: Record<string, string> = {}
): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      ...securityHeaders,
      ...headers,
    },
  });
}
