import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  discoverProjects,
  discoverStatuses,
  discoverTickets,
  type Discovery,
  type Project,
  type Status,
  type Ticket,
} from './internal/discovery.ts';
import {
  readTrackerDocument,
  writeTrackerDocument,
  type DocumentDiagnostic,
  type Metadata,
  type Outcome,
  type TrackerDocument,
} from './internal/documents.ts';
import {
  isNormalizedName,
  isTicketReference,
  parseTicketName,
  type ParsedTicketName,
} from './internal/names.ts';
import {
  lintProject,
  type LintCode,
  type LintResult,
  type LintViolation,
} from './internal/lint.ts';
import {
  summarizeTickets,
  type QueryResult,
  type SearchCriteria,
  type TicketSummary,
} from './internal/queries.ts';

export type {
  Discovery,
  DocumentDiagnostic,
  Metadata,
  Outcome,
  ParsedTicketName,
  Project,
  Status,
  Ticket,
  TrackerDocument,
  LintCode,
  LintResult,
  LintViolation,
  QueryResult,
  SearchCriteria,
  TicketSummary,
};

export { isNormalizedName, isTicketReference, parseTicketName };

export type Tracker = {
  readonly workspaceRoot: string;
  discoverProjects(): Promise<Discovery<Project>>;
  discoverStatuses(projectName: string): Promise<Discovery<Status>>;
  discoverTickets(
    projectName: string,
    statusName: string
  ): Promise<Discovery<Ticket>>;
  readProject(projectName: string): Promise<Outcome<TrackerDocument>>;
  readTicket(
    projectName: string,
    statusName: string,
    ticketName: string
  ): Promise<Outcome<TrackerDocument>>;
  lintProject(projectName: string): Promise<LintResult>;
  writeProject(
    projectName: string,
    document: TrackerDocument
  ): Promise<Outcome<undefined>>;
  writeTicket(
    projectName: string,
    statusName: string,
    ticketName: string,
    document: TrackerDocument
  ): Promise<Outcome<undefined>>;
  showTicket(projectName: string, reference: string): Promise<Outcome<string>>;
  listTickets(projectName: string, statusName: string): Promise<QueryResult>;
  searchTickets(
    projectName: string,
    criteria?: SearchCriteria
  ): Promise<QueryResult>;
};

export function createTracker(workspaceRoot: string): Tracker {
  const absoluteRoot = resolve(workspaceRoot);

  function projectAt(name: string): Project {
    return { name, path: join(absoluteRoot, name) };
  }

  function statusAt(projectName: string, name: string): Status {
    const project = projectAt(projectName);
    return { name, path: join(project.path, name), project };
  }

  function ticketAt(
    projectName: string,
    statusName: string,
    name: string
  ): Ticket | null {
    const parsed = parseTicketName(name);
    if (parsed === null) return null;
    const status = statusAt(projectName, statusName);
    return { ...parsed, path: join(status.path, `${name}.md`), status };
  }

  const readSummaryDocument = (
    projectName: string,
    statusName: string,
    ticketName: string
  ) =>
    readTrackerDocument(
      join(absoluteRoot, projectName, statusName, `${ticketName}.md`),
      'ticket'
    );

  return {
    workspaceRoot: absoluteRoot,
    discoverProjects: () => discoverProjects(absoluteRoot),
    discoverStatuses: (projectName) => {
      if (!isNormalizedName(projectName)) {
        return invalidDiscovery(absoluteRoot, 'project', projectName);
      }
      return discoverStatuses(projectAt(projectName));
    },
    discoverTickets: (projectName, statusName) => {
      if (!isNormalizedName(projectName)) {
        return invalidDiscovery(absoluteRoot, 'project', projectName);
      }
      if (!isNormalizedName(statusName)) {
        return invalidDiscovery(absoluteRoot, 'status', statusName);
      }
      return discoverTickets(statusAt(projectName, statusName));
    },
    readProject: (projectName) => {
      if (!isNormalizedName(projectName)) {
        return invalidOutcome(absoluteRoot, 'project', projectName);
      }
      return readTrackerDocument(
        join(absoluteRoot, projectName, 'project.md'),
        'project'
      );
    },
    readTicket: (projectName, statusName, ticketName) => {
      const ticket = validatedTicket(
        absoluteRoot,
        projectName,
        statusName,
        ticketName,
        ticketAt
      );
      if (!ticket.ok) return Promise.resolve(ticket);
      return readTrackerDocument(ticket.value.path, 'ticket');
    },
    lintProject: (projectName) => {
      if (!isNormalizedName(projectName)) {
        return Promise.resolve({
          ok: false,
          diagnostic: invalidDiagnostic(absoluteRoot, 'project', projectName),
        });
      }
      return lintProject(absoluteRoot, projectName);
    },
    writeProject: (projectName, document) => {
      if (!isNormalizedName(projectName)) {
        return invalidOutcome(absoluteRoot, 'project', projectName);
      }
      return writeTrackerDocument(
        join(absoluteRoot, projectName, 'project.md'),
        document
      );
    },
    writeTicket: (projectName, statusName, ticketName, document) => {
      const ticket = validatedTicket(
        absoluteRoot,
        projectName,
        statusName,
        ticketName,
        ticketAt
      );
      if (!ticket.ok) return Promise.resolve(ticket);
      return writeTrackerDocument(ticket.value.path, document);
    },
    showTicket: async (projectName, reference) => {
      if (!isNormalizedName(projectName)) {
        return invalidOutcome(absoluteRoot, 'project', projectName);
      }
      const resolved = splitReference(projectName, reference);
      if (resolved === null) {
        return invalidOutcome(absoluteRoot, 'ticket', reference);
      }
      const statuses = await discoverStatuses(projectAt(resolved.projectName));
      if (statuses.diagnostics.length > 0) {
        return { ok: false, diagnostic: statuses.diagnostics[0] };
      }
      const matches: Ticket[] = [];
      for (const status of statuses.entries) {
        const discovery = await discoverTickets(status);
        if (discovery.diagnostics.length > 0) {
          return { ok: false, diagnostic: discovery.diagnostics[0] };
        }
        matches.push(
          ...discovery.entries.filter(
            (ticket) => ticket.name === resolved.ticketName
          )
        );
      }
      if (matches.length !== 1) {
        return {
          ok: false,
          diagnostic: {
            path: projectAt(resolved.projectName).path,
            code: 'not-found',
            message:
              matches.length === 0
                ? `Ticket not found: ${reference}`
                : `Ticket reference is ambiguous: ${reference}`,
          },
        };
      }
      try {
        return { ok: true, value: await readFile(matches[0].path, 'utf8') };
      } catch (error) {
        return {
          ok: false,
          diagnostic: {
            path: matches[0].path,
            code: 'filesystem-error',
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
    listTickets: async (projectName, statusName) => {
      if (!isNormalizedName(projectName)) {
        return failedQuery(
          projectName,
          invalidDiagnostic(absoluteRoot, 'project', projectName)
        );
      }
      if (!isNormalizedName(statusName)) {
        return failedQuery(
          projectName,
          invalidDiagnostic(absoluteRoot, 'status', statusName)
        );
      }
      const discovery = await discoverTickets(
        statusAt(projectName, statusName)
      );
      if (discovery.diagnostics.length > 0) {
        return {
          project: projectName,
          tickets: [],
          diagnostics: discovery.diagnostics,
          fatal: true,
        };
      }
      return summarizeTickets(projectName, [discovery], readSummaryDocument);
    },
    searchTickets: async (projectName, criteria = {}) => {
      if (!isNormalizedName(projectName)) {
        return failedQuery(
          projectName,
          invalidDiagnostic(absoluteRoot, 'project', projectName)
        );
      }
      const invalidCriteria = validateSearchCriteria(absoluteRoot, criteria);
      if (invalidCriteria !== null) {
        return failedQuery(projectName, invalidCriteria);
      }
      const statuses = await discoverStatuses(projectAt(projectName));
      if (statuses.diagnostics.length > 0) {
        return {
          project: projectName,
          tickets: [],
          diagnostics: statuses.diagnostics,
          fatal: true,
        };
      }
      const discoveries = await Promise.all(
        statuses.entries.map(discoverTickets)
      );
      return summarizeTickets(
        projectName,
        discoveries,
        readSummaryDocument,
        criteria
      );
    },
  };
}

function validateSearchCriteria(
  workspaceRoot: string,
  criteria: SearchCriteria
): DocumentDiagnostic | null {
  const names: readonly [string, readonly string[] | undefined][] = [
    ['status', criteria.statuses],
    ['tag', criteria.tags],
    ['assignee', criteria.assignedTo],
  ];
  for (const [kind, values] of names) {
    if (values === undefined) continue;
    for (const value of values) {
      if (!isNormalizedName(value)) {
        return {
          path: workspaceRoot,
          code: 'invalid-name',
          message: `Invalid ${kind} name: ${value}`,
        };
      }
    }
  }
  const references = [
    ...(criteria.parents ?? []),
    ...(criteria.blockedBy ?? []),
  ];
  for (const reference of references) {
    if (!isTicketReference(reference)) {
      return {
        path: workspaceRoot,
        code: 'invalid-name',
        message: `Invalid ticket reference: ${reference}`,
      };
    }
  }
  if ((criteria.assignedTo?.length ?? 0) > 0 && criteria.unassigned) {
    return {
      path: workspaceRoot,
      code: 'invalid-name',
      message: 'Assigned and unassigned criteria cannot be combined',
    };
  }
  if ((criteria.blockedBy?.length ?? 0) > 0 && criteria.unblocked) {
    return {
      path: workspaceRoot,
      code: 'invalid-name',
      message: 'Blocked and unblocked criteria cannot be combined',
    };
  }
  return null;
}

function splitReference(
  selectedProject: string,
  reference: string
): { readonly projectName: string; readonly ticketName: string } | null {
  if (!isTicketReference(reference)) return null;
  const separator = reference.indexOf('/');
  return separator === -1
    ? { projectName: selectedProject, ticketName: reference }
    : {
        projectName: reference.slice(0, separator),
        ticketName: reference.slice(separator + 1),
      };
}

function failedQuery(
  project: string,
  diagnostic: DocumentDiagnostic
): QueryResult {
  return { project, tickets: [], diagnostics: [diagnostic], fatal: true };
}

function invalidDiagnostic(
  workspaceRoot: string,
  kind: 'project' | 'status' | 'ticket',
  value: string
): DocumentDiagnostic {
  return {
    path: workspaceRoot,
    code: 'invalid-name',
    message: `Invalid ${kind} name: ${value}`,
  };
}

function invalidDiscovery<T>(
  workspaceRoot: string,
  kind: 'project' | 'status' | 'ticket',
  value: string
): Promise<Discovery<T>> {
  return Promise.resolve({
    entries: [],
    diagnostics: [invalidDiagnostic(workspaceRoot, kind, value)],
  });
}

function invalidOutcome<T>(
  workspaceRoot: string,
  kind: 'project' | 'status' | 'ticket',
  value: string
): Promise<Outcome<T>> {
  return Promise.resolve({
    ok: false,
    diagnostic: invalidDiagnostic(workspaceRoot, kind, value),
  });
}

function validatedTicket(
  workspaceRoot: string,
  projectName: string,
  statusName: string,
  ticketName: string,
  ticketAt: (
    projectName: string,
    statusName: string,
    ticketName: string
  ) => Ticket | null
): Outcome<Ticket> {
  if (!isNormalizedName(projectName)) {
    return {
      ok: false,
      diagnostic: invalidDiagnostic(workspaceRoot, 'project', projectName),
    };
  }
  if (!isNormalizedName(statusName)) {
    return {
      ok: false,
      diagnostic: invalidDiagnostic(workspaceRoot, 'status', statusName),
    };
  }
  const ticket = ticketAt(projectName, statusName, ticketName);
  if (ticket === null) {
    return {
      ok: false,
      diagnostic: invalidDiagnostic(workspaceRoot, 'ticket', ticketName),
    };
  }
  return { ok: true, value: ticket };
}
