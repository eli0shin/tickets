import type { Discovery, Ticket } from './discovery.ts';
import type { DocumentDiagnostic, Metadata } from './documents.ts';
import {
  isAssigneeName,
  isNormalizedName,
  isTicketReference,
} from './names.ts';

export type TicketSummary = {
  readonly id: bigint;
  readonly name: string;
  readonly status: string;
  readonly path: string;
  readonly assignedTo: string | null;
  readonly tags: readonly string[];
  readonly parent: string | null;
  readonly blockedBy: readonly string[];
};

export type SearchCriteria = {
  readonly statuses?: readonly string[];
  readonly tags?: readonly string[];
  readonly assignedTo?: readonly string[];
  readonly unassigned?: boolean;
  readonly parents?: readonly string[];
  readonly blockedBy?: readonly string[];
  readonly unblocked?: boolean;
};

export type QueryResult = {
  readonly project: string;
  readonly tickets: readonly TicketSummary[];
  readonly diagnostics: readonly DocumentDiagnostic[];
  readonly fatal: boolean;
};

type ReadTicket = (
  projectName: string,
  statusName: string,
  ticketName: string
) => Promise<
  | { readonly ok: true; readonly value: { readonly metadata: Metadata } }
  | { readonly ok: false; readonly diagnostic: DocumentDiagnostic }
>;

export async function summarizeTickets(
  projectName: string,
  discoveries: readonly Discovery<Ticket>[],
  readTicket: ReadTicket,
  criteria: SearchCriteria = {}
): Promise<QueryResult> {
  const diagnostics = discoveries.flatMap((result) => result.diagnostics);
  const tickets = discoveries.flatMap((result) => result.entries);
  const summaries = await Promise.all(
    tickets.map(async (ticket) => {
      const document = await readTicket(
        projectName,
        ticket.status.name,
        ticket.name
      );
      if (!document.ok) {
        diagnostics.push(document.diagnostic);
        return null;
      }
      const metadata = ticketMetadata(ticket, document.value.metadata);
      if (!metadata.ok) {
        diagnostics.push(metadata.diagnostic);
        return null;
      }
      const summary = {
        id: ticket.id,
        name: ticket.name,
        status: ticket.status.name,
        path: ticket.path,
        ...metadata.value,
      } satisfies TicketSummary;
      return matches(summary, criteria) ? summary : null;
    })
  );

  return {
    project: projectName,
    tickets: summaries
      .filter((ticket): ticket is TicketSummary => ticket !== null)
      .sort(compareTickets),
    diagnostics: diagnostics.sort(compareDiagnostics),
    fatal: false,
  };
}

function ticketMetadata(
  ticket: Ticket,
  metadata: Metadata
):
  | {
      readonly ok: true;
      readonly value: Omit<TicketSummary, 'id' | 'name' | 'status' | 'path'>;
    }
  | { readonly ok: false; readonly diagnostic: DocumentDiagnostic } {
  const assignedTo = optionalString(metadata['Assigned-To']);
  const tags = stringArray(metadata.Tags, isNormalizedName);
  const parent = optionalString(metadata.Parent);
  const blockedBy = stringArray(metadata['Blocked-By'], isTicketReference);

  if (assignedTo !== null && !isAssigneeName(assignedTo)) {
    return invalidMetadata(ticket, 'Assigned-To');
  }
  if (tags === null) {
    return invalidMetadata(ticket, 'Tags');
  }
  if (
    parent !== null &&
    (typeof parent !== 'string' || !isTicketReference(parent))
  ) {
    return invalidMetadata(ticket, 'Parent');
  }
  if (blockedBy === null) {
    return invalidMetadata(ticket, 'Blocked-By');
  }

  return {
    ok: true,
    value: { assignedTo, tags, parent, blockedBy },
  };
}

function optionalString(value: unknown): unknown {
  return value === undefined || value === null || value === '' ? null : value;
}

function stringArray(
  value: unknown,
  validate: (item: string) => boolean
): readonly string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !validate(item)) return null;
    result.push(item);
  }
  return result;
}

function invalidMetadata(
  ticket: Ticket,
  field: string
): { readonly ok: false; readonly diagnostic: DocumentDiagnostic } {
  return {
    ok: false,
    diagnostic: {
      path: ticket.path,
      code: 'invalid-ticket-metadata',
      message: `Invalid ${field} metadata`,
    },
  };
}

function matches(ticket: TicketSummary, criteria: SearchCriteria): boolean {
  return (
    matchesOne(criteria.statuses, ticket.status) &&
    containsAll(ticket.tags, criteria.tags) &&
    allEqual(criteria.assignedTo, ticket.assignedTo) &&
    (!criteria.unassigned || ticket.assignedTo === null) &&
    allEqual(criteria.parents, ticket.parent) &&
    containsAll(ticket.blockedBy, criteria.blockedBy) &&
    (!criteria.unblocked || ticket.blockedBy.length === 0)
  );
}

function matchesOne(
  values: readonly string[] | undefined,
  expected: string
): boolean {
  return values === undefined || values.includes(expected);
}

function allEqual(
  values: readonly string[] | undefined,
  expected: string | null
): boolean {
  if (values === undefined) return true;
  for (const value of values) if (value !== expected) return false;
  return true;
}

function containsAll(
  values: readonly string[],
  required: readonly string[] | undefined
): boolean {
  if (required === undefined) return true;
  for (const value of required) if (!values.includes(value)) return false;
  return true;
}

function compareTickets(left: TicketSummary, right: TicketSummary): number {
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  return left.name.localeCompare(right.name);
}

function compareDiagnostics(
  left: DocumentDiagnostic,
  right: DocumentDiagnostic
): number {
  return (
    left.path.localeCompare(right.path) ||
    left.message.localeCompare(right.message)
  );
}
