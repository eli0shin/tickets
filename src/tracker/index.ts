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
};

export { isNormalizedName, isTicketReference, parseTicketName };

export type Tracker = {
  readonly workspaceRoot: string;
  discoverProjects(): Promise<Discovery<Project>>;
  discoverStatuses(project: Project): Promise<Discovery<Status>>;
  discoverTickets(status: Status): Promise<Discovery<Ticket>>;
  readProject(project: Project): Promise<Outcome<TrackerDocument>>;
  readTicket(ticket: Ticket): Promise<Outcome<TrackerDocument>>;
  writeProject(
    project: Project,
    document: TrackerDocument
  ): Promise<Outcome<undefined>>;
  writeTicket(
    ticket: Ticket,
    document: TrackerDocument
  ): Promise<Outcome<undefined>>;
};

export function createTracker(workspaceRoot: string): Tracker {
  const absoluteRoot = resolve(workspaceRoot);

  return {
    workspaceRoot: absoluteRoot,
    discoverProjects: () => discoverProjects(absoluteRoot),
    discoverStatuses,
    discoverTickets,
    readProject: (project) =>
      readTrackerDocument(join(project.path, 'project.md'), 'project'),
    readTicket: (ticket) => readTrackerDocument(ticket.path, 'ticket'),
    writeProject: (project, document) =>
      writeTrackerDocument(join(project.path, 'project.md'), document),
    writeTicket: (ticket, document) =>
      writeTrackerDocument(ticket.path, document),
  };
}
