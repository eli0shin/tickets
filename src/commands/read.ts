import {
  isAssigneeName,
  isNormalizedName,
  isTicketReference,
  type Project,
  type QueryResult,
  type SearchCriteria,
  type Status,
  type Tracker,
} from '../tracker/index.ts';
import type { CommandOutcome } from '../types.ts';

export type SearchInput = {
  readonly status?: readonly string[];
  readonly tag?: readonly string[];
  readonly assignedTo?: readonly string[];
  readonly unassigned?: boolean;
  readonly parent?: readonly string[];
  readonly blockedBy?: readonly string[];
  readonly unblocked?: boolean;
};

export async function listProjects(
  tracker: Tracker
): Promise<CommandOutcome<readonly Project[]>> {
  const result = await tracker.discoverProjects();
  const diagnostic = result.diagnostics.at(0);
  return diagnostic === undefined
    ? { ok: true, value: result.entries }
    : { ok: false, failure: { kind: 'diagnostic', diagnostic } };
}

export async function listStatuses(
  tracker: Tracker,
  project: string
): Promise<CommandOutcome<readonly Status[]>> {
  const result = await tracker.discoverStatuses(project);
  const diagnostic = result.diagnostics.at(0);
  return diagnostic === undefined
    ? { ok: true, value: result.entries }
    : { ok: false, failure: { kind: 'diagnostic', diagnostic } };
}

export async function showTicket(
  tracker: Tracker,
  project: string,
  reference: string
): Promise<CommandOutcome<string>> {
  const validation = validateReference(reference);
  if (!validation.ok) return validation;

  const result = await tracker.showTicket(project, reference);
  return result.ok
    ? { ok: true, value: result.value }
    : {
        ok: false,
        failure: { kind: 'diagnostic', diagnostic: result.diagnostic },
      };
}

export async function listTickets(
  tracker: Tracker,
  project: string,
  status: string
): Promise<CommandOutcome<QueryResult>> {
  const validation = validateName('status', status);
  if (!validation.ok) return validation;

  return queryOutcome(await tracker.listTickets(project, status));
}

export async function searchTickets(
  tracker: Tracker,
  project: string,
  input: SearchInput
): Promise<CommandOutcome<QueryResult>> {
  const validation = validateSearchInput(input);
  if (!validation.ok) return validation;

  const criteria = {
    statuses: nonEmpty(input.status),
    tags: nonEmpty(input.tag),
    assignedTo: nonEmpty(input.assignedTo),
    unassigned: input.unassigned,
    parents: nonEmpty(input.parent),
    blockedBy: nonEmpty(input.blockedBy),
    unblocked: input.unblocked,
  } satisfies SearchCriteria;
  return queryOutcome(await tracker.searchTickets(project, criteria));
}

export function validateProject(
  project: string | undefined
): CommandOutcome<undefined> {
  return project === undefined
    ? { ok: true, value: undefined }
    : validateName('project', project);
}

export function validateReference(
  reference: string
): CommandOutcome<undefined> {
  return isTicketReference(reference)
    ? { ok: true, value: undefined }
    : failure(`Invalid ticket reference: ${reference}`);
}

export function validateSearchInput(
  input: SearchInput
): CommandOutcome<undefined> {
  if ((input.assignedTo?.length ?? 0) > 0 && input.unassigned) {
    return failure('--assigned-to and --unassigned cannot be used together');
  }
  if ((input.blockedBy?.length ?? 0) > 0 && input.unblocked) {
    return failure('--blocked-by and --unblocked cannot be used together');
  }

  for (const [kind, values] of [
    ['status', input.status],
    ['tag', input.tag],
  ] as const) {
    for (const value of values ?? []) {
      const validation = validateName(kind, value);
      if (!validation.ok) return validation;
    }
  }
  for (const assignee of input.assignedTo ?? []) {
    if (!isAssigneeName(assignee)) {
      return failure('Assignee must be a non-empty string');
    }
  }
  for (const reference of [
    ...(input.parent ?? []),
    ...(input.blockedBy ?? []),
  ]) {
    const validation = validateReference(reference);
    if (!validation.ok) return validation;
  }
  return { ok: true, value: undefined };
}

export function validateStatus(status: string): CommandOutcome<undefined> {
  return validateName('status', status);
}

function validateName(kind: string, value: string): CommandOutcome<undefined> {
  return isNormalizedName(value)
    ? { ok: true, value: undefined }
    : failure(`Invalid ${kind} name: ${value}`);
}

function queryOutcome(result: QueryResult): CommandOutcome<QueryResult> {
  if (!result.fatal) return { ok: true, value: result };
  const diagnostic = result.diagnostics.at(0);
  return diagnostic === undefined
    ? failure('Query failed')
    : { ok: false, failure: { kind: 'diagnostic', diagnostic } };
}

function failure(message: string): CommandOutcome<never> {
  return { ok: false, failure: { kind: 'message', message } };
}

function nonEmpty(values: readonly string[] | undefined) {
  return values?.length === 0 ? undefined : values;
}
