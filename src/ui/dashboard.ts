import { stat } from 'node:fs/promises';
import { discoverEmbeddedProject } from '../embedded.ts';
import { selectProject } from '../git.ts';
import {
  createEmbeddedTracker,
  createTracker,
  isNormalizedName,
  type DocumentDiagnostic,
  type Outcome,
  type Project,
  type SearchCriteria,
  type TicketSummary,
  type Tracker,
} from '../tracker/index.ts';
import { renderMarkdown, ticketTitle } from './markdown.ts';

export type DashboardOptions = {
  readonly workspaceRoot: string;
  readonly cwd: string;
  readonly includeEmbedded: boolean;
  readonly project?: string;
};

export type UiProject = Project & {
  readonly key: string;
  readonly scope: 'local' | 'global';
};

type CatalogEntry = {
  readonly project: UiProject;
  readonly tracker: Tracker;
};

export type BoardFilters = Pick<
  SearchCriteria,
  'tags' | 'unblocked' | 'blockedBy'
> & {
  readonly query?: string;
};

export type UiTicket = Omit<TicketSummary, 'id'> & {
  readonly id: string;
  readonly title: string;
};

export function createDashboard(options: DashboardOptions) {
  const globalTracker = createTracker(options.workspaceRoot);

  async function catalog(): Promise<Outcome<readonly CatalogEntry[]>> {
    let globals: readonly Project[] = [];
    // A missing workspace is an empty dashboard, not a reason to create files.
    if (!(await missing(options.workspaceRoot))) {
      const discovery = await globalTracker.discoverProjects();
      if (discovery.diagnostics[0]) {
        return { ok: false, diagnostic: discovery.diagnostics[0] };
      }
      globals = discovery.entries;
    }
    const entries: CatalogEntry[] = globals.map((project) => ({
      project: { ...project, key: `global/${project.name}`, scope: 'global' },
      tracker: globalTracker,
    }));
    if (options.includeEmbedded) {
      const embedded = await discoverEmbeddedProject(options.cwd);
      if (!embedded.ok) return embedded;
      if (embedded.project) {
        entries.unshift({
          project: {
            ...embedded.project,
            key: `local/${embedded.project.name}`,
            scope: 'local',
          },
          tracker: createEmbeddedTracker(
            embedded.project,
            options.workspaceRoot
          ),
        });
      }
    }
    return { ok: true, value: entries };
  }

  async function lookup(key: string): Promise<Outcome<CatalogEntry>> {
    const result = await catalog();
    if (!result.ok) return result;
    const entry = result.value.find((entry) => entry.project.key === key);
    return entry
      ? { ok: true, value: entry }
      : failure(key, 'not-found', 'Project not found');
  }

  return {
    async projects() {
      const result = await catalog();
      if (!result.ok) return result;
      const entries = result.value;
      let initial = entries[0]?.project.key ?? null;
      if (options.project !== undefined) {
        if (!isNormalizedName(options.project)) {
          return failure(
            options.project,
            'invalid-name',
            'Invalid project name'
          );
        }
        const explicit = entries.find(
          (entry) => entry.project.key === `global/${options.project}`
        );
        if (!explicit)
          return failure(options.project, 'not-found', 'Project not found');
        initial = explicit.project.key;
      } else if (!entries.some((entry) => entry.project.scope === 'local')) {
        const selection = await selectProject({
          cwd: options.cwd,
          loadProjects: async () => {
            const repositories = [];
            for (const entry of entries) {
              const document = await entry.tracker.readProject(
                entry.project.name
              );
              if (!document.ok) continue;
              const gitRepo = document.value.metadata['Git-Repo'];
              if (
                gitRepo === undefined ||
                gitRepo === null ||
                typeof gitRepo === 'string'
              ) {
                repositories.push({ name: entry.project.name, gitRepo });
              }
            }
            return repositories;
          },
        });
        if (selection.ok) initial = `global/${selection.project}`;
      }
      return {
        ok: true as const,
        value: {
          projects: entries.map((entry) => entry.project),
          initialProject: initial,
        },
      };
    },

    async board(key: string, filters: BoardFilters = {}) {
      const selected = await lookup(key);
      if (!selected.ok) return selected;
      const { project, tracker } = selected.value;
      const validation = await tracker.validateProject(project.name, {
        defaultStatus: false,
      });
      if (!validation.ok) return validation;
      const statuses = await tracker.discoverStatuses(project.name);
      const all = await tracker.searchTickets(project.name);
      if (all.fatal)
        return { ok: false as const, diagnostic: all.diagnostics[0] };
      const matching = await tracker.searchTickets(project.name, filters);
      if (matching.fatal)
        return { ok: false as const, diagnostic: matching.diagnostics[0] };
      const diagnostics = [
        ...statuses.diagnostics,
        ...all.diagnostics,
        ...matching.diagnostics,
      ];
      const query = filters.query?.trim().toLocaleLowerCase() ?? '';
      const tickets: UiTicket[] = [];
      for (const summary of matching.tickets) {
        const document = await tracker.readTicket(
          project.name,
          summary.status,
          summary.name
        );
        if (!document.ok) {
          diagnostics.push(document.diagnostic);
          continue;
        }
        const title = ticketTitle(
          document.value.body,
          titleFromName(summary.name)
        );
        if (
          query &&
          ![title, summary.name, document.value.body, ...summary.tags]
            .join(' ')
            .toLocaleLowerCase()
            .includes(query)
        )
          continue;
        tickets.push({ ...summary, id: summary.id.toString(), title });
      }
      // Status directories have no ordering contract. Give the default a useful
      // first position and done a conventional last position; sort the rest.
      const metadata = await tracker.readProject(project.name);
      const defaultStatus = metadata.ok
        ? metadata.value.metadata['Default-Status']
        : undefined;
      const ordered = statuses.entries
        .map((status) => status.name)
        .sort(
          (a, b) =>
            statusRank(a, defaultStatus) - statusRank(b, defaultStatus) ||
            a.localeCompare(b)
        );
      return {
        ok: true as const,
        value: {
          project,
          statuses: ordered,
          tickets,
          tags: [
            ...new Set(all.tickets.flatMap((ticket) => ticket.tags)),
          ].sort(),
          blockers: [
            ...new Set(all.tickets.flatMap((ticket) => ticket.blockedBy)),
          ].sort(),
          diagnostics: uniqueDiagnostics(diagnostics),
        },
      };
    },

    async ticket(key: string, status: string, name: string) {
      const selected = await lookup(key);
      if (!selected.ok) return selected;
      const { project, tracker } = selected.value;
      const document = await tracker.readTicket(project.name, status, name);
      if (!document.ok) return document;
      // Exact path selection keeps duplicate IDs/names in different statuses visible.
      const summaries = await tracker.listTickets(project.name, status);
      const summary = summaries.tickets.find((ticket) => ticket.name === name);
      if (!summary)
        return failure(
          name,
          'not-found',
          'Ticket unavailable; refresh the board'
        );
      return {
        ok: true as const,
        value: {
          ...summary,
          id: summary.id.toString(),
          title: ticketTitle(document.value.body, titleFromName(name)),
          body: document.value.body,
          html: renderMarkdown(document.value.body),
          metadata: document.value.metadata,
        },
      };
    },
  };
}

function titleFromName(name: string): string {
  return name.replace(/^\d+-/, '').replaceAll('-', ' ');
}

function statusRank(status: string, defaultStatus: unknown): number {
  if (status === 'done') return 2;
  return status === defaultStatus ? 0 : 1;
}

function uniqueDiagnostics(
  diagnostics: readonly DocumentDiagnostic[]
): readonly DocumentDiagnostic[] {
  return [
    ...new Map(
      diagnostics.map((d) => [`${d.path}:${d.code}:${d.message}`, d])
    ).values(),
  ];
}

function failure(
  path: string,
  code: DocumentDiagnostic['code'],
  message: string
): Outcome<never> {
  return { ok: false, diagnostic: { path, code, message } };
}

async function missing(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return true;
    throw error;
  }
}
