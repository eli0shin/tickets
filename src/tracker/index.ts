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
  };
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
