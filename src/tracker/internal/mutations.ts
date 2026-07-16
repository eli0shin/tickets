import { lstat, mkdir, rename as renameFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DocumentDiagnostic, Outcome } from './documents.ts';
import {
  readTrackerDocument,
  updateTrackerMetadata,
  writeTrackerDocument,
} from './documents.ts';
import type { Project, Status, Ticket } from './discovery.ts';
import {
  discoverProjects,
  discoverStatuses,
  discoverTickets,
} from './discovery.ts';
import {
  isNormalizedName,
  isTicketReference,
  normalizeTicketDescription,
} from './names.ts';

export type MutationOutcome =
  | { readonly ok: true; readonly value: Ticket }
  | {
      readonly ok: false;
      readonly diagnostics: readonly DocumentDiagnostic[];
      readonly partial: boolean;
    };

type ResolvedReference = {
  readonly projectName: string;
  readonly ticketName: string;
};

type ReferenceChange =
  | {
      readonly kind: 'rename';
      readonly oldReference: ResolvedReference;
      readonly newTicketName: string;
    }
  | {
      readonly kind: 'complete';
      readonly reference: ResolvedReference;
      readonly completedPath: string;
    };

export async function renameTicket(
  workspaceRoot: string,
  selectedProject: string,
  reference: string,
  description: string
): Promise<MutationOutcome> {
  const normalizedDescription = normalizeTicketDescription(description);
  if (normalizedDescription === null) {
    return failed(
      invalid(
        workspaceRoot,
        'invalid-name',
        `Invalid ticket description name: ${description}`
      )
    );
  }
  const resolved = resolveReference(workspaceRoot, selectedProject, reference);
  if (!resolved.ok) return failed(resolved.diagnostic);
  const target = await findTicket(workspaceRoot, resolved.value, reference);
  if (!target.ok) return failed(target.diagnostic);

  const idText = target.value.name.slice(0, target.value.name.indexOf('-'));
  const newName = `${idText}-${normalizedDescription}`;
  const destination = join(target.value.status.path, `${newName}.md`);
  const collision = await renameCollision(
    target.value.status.project,
    newName,
    destination
  );
  if (collision !== null) return failed(collision);

  const moved = await moveFile(target.value.path, destination);
  if (!moved.ok) return failed(moved.diagnostic);

  const renamed = {
    ...target.value,
    name: newName,
    description: normalizedDescription,
    path: destination,
  } satisfies Ticket;
  const diagnostics = await cleanReferences(workspaceRoot, {
    kind: 'rename',
    oldReference: resolved.value,
    newTicketName: newName,
  });
  return diagnostics.length === 0
    ? { ok: true, value: renamed }
    : { ok: false, diagnostics, partial: true };
}

export async function moveTicket(
  workspaceRoot: string,
  selectedProject: string,
  reference: string,
  statusName: string
): Promise<MutationOutcome> {
  if (!isNormalizedName(statusName)) {
    return failed(
      invalid(
        workspaceRoot,
        'invalid-name',
        `Invalid status name: ${statusName}`
      )
    );
  }
  if (statusName === 'done') {
    return completeTicket(workspaceRoot, selectedProject, reference);
  }

  const resolved = resolveReference(workspaceRoot, selectedProject, reference);
  if (!resolved.ok) return failed(resolved.diagnostic);
  const target = await findTicket(workspaceRoot, resolved.value, reference);
  if (!target.ok) return failed(target.diagnostic);
  const status = await findStatus(target.value.status.project, statusName);
  if (!status.ok) return failed(status.diagnostic);
  if (target.value.status.name === statusName) {
    return { ok: true, value: target.value };
  }

  const destination = join(status.value.path, `${target.value.name}.md`);
  const collision = await existingPath(destination);
  if (collision !== null) return failed(collision);
  const moved = await moveFile(target.value.path, destination);
  return moved.ok
    ? {
        ok: true,
        value: { ...target.value, path: destination, status: status.value },
      }
    : failed(moved.diagnostic);
}

export async function completeTicket(
  workspaceRoot: string,
  selectedProject: string,
  reference: string
): Promise<MutationOutcome> {
  const resolved = resolveReference(workspaceRoot, selectedProject, reference);
  if (!resolved.ok) return failed(resolved.diagnostic);
  const target = await findTicket(workspaceRoot, resolved.value, reference);
  if (!target.ok) return failed(target.diagnostic);

  const donePath = join(target.value.status.project.path, 'done');
  const directory = await ensureDirectory(donePath);
  if (!directory.ok) return failed(directory.diagnostic);
  const done = {
    name: 'done',
    path: donePath,
    project: target.value.status.project,
  } satisfies Status;
  const destination = join(donePath, `${target.value.name}.md`);
  let completed = target.value;
  if (target.value.status.name !== 'done') {
    const collision = await existingPath(destination);
    if (collision !== null) return failed(collision);
    const moved = await moveFile(target.value.path, destination);
    if (!moved.ok) return failed(moved.diagnostic);
    completed = { ...target.value, path: destination, status: done };
  }

  const diagnostics = await cleanReferences(workspaceRoot, {
    kind: 'complete',
    reference: resolved.value,
    completedPath: completed.path,
  });
  return diagnostics.length === 0
    ? { ok: true, value: completed }
    : { ok: false, diagnostics, partial: true };
}

async function renameCollision(
  project: Project,
  name: string,
  destination: string
): Promise<DocumentDiagnostic | null> {
  const statuses = await discoverStatuses(project);
  const statusFailure = statuses.diagnostics.at(0);
  if (statusFailure !== undefined) return statusFailure;
  for (const status of statuses.entries) {
    const tickets = await discoverTickets(status);
    const ticketFailure = tickets.diagnostics.at(0);
    if (ticketFailure !== undefined) return ticketFailure;
    const collision = tickets.entries.find((ticket) => ticket.name === name);
    if (collision !== undefined) return resourceExists(collision.path);
  }
  return existingPath(destination);
}

async function moveFile(
  source: string,
  destination: string
): Promise<Outcome<undefined>> {
  try {
    await renameFile(source, destination);
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, diagnostic: filesystemFailure(destination, error) };
  }
}

async function ensureDirectory(path: string): Promise<Outcome<undefined>> {
  try {
    await mkdir(path);
    return { ok: true, value: undefined };
  } catch (error) {
    return hasErrorCode(error, 'EEXIST')
      ? inspectExistingDirectory(path)
      : { ok: false, diagnostic: filesystemFailure(path, error) };
  }
}

async function inspectExistingDirectory(
  path: string
): Promise<Outcome<undefined>> {
  try {
    const existing = await stat(path);
    return existing.isDirectory()
      ? { ok: true, value: undefined }
      : { ok: false, diagnostic: resourceExists(path) };
  } catch (error) {
    return { ok: false, diagnostic: filesystemFailure(path, error) };
  }
}

async function existingPath(path: string): Promise<DocumentDiagnostic | null> {
  try {
    await lstat(path);
    return resourceExists(path);
  } catch (error) {
    return hasErrorCode(error, 'ENOENT')
      ? null
      : filesystemFailure(path, error);
  }
}

async function findStatus(
  project: Project,
  name: string
): Promise<Outcome<Status>> {
  const statuses = await discoverStatuses(project);
  const failure = statuses.diagnostics.at(0);
  if (failure !== undefined) return { ok: false, diagnostic: failure };
  const status = statuses.entries.find((entry) => entry.name === name);
  return status === undefined
    ? {
        ok: false,
        diagnostic: invalid(
          join(project.path, name),
          'status-not-found',
          `Status not found: ${name}`
        ),
      }
    : { ok: true, value: status };
}

async function findTicket(
  workspaceRoot: string,
  reference: ResolvedReference,
  originalReference: string
): Promise<Outcome<Ticket>> {
  const project = {
    name: reference.projectName,
    path: join(workspaceRoot, reference.projectName),
  } satisfies Project;
  const statuses = await discoverStatuses(project);
  const statusFailure = statuses.diagnostics.at(0);
  if (statusFailure !== undefined)
    return { ok: false, diagnostic: statusFailure };

  const matches: Ticket[] = [];
  for (const status of statuses.entries) {
    const tickets = await discoverTickets(status);
    const failure = tickets.diagnostics.at(0);
    if (failure !== undefined) return { ok: false, diagnostic: failure };
    matches.push(
      ...tickets.entries.filter(
        (ticket) => ticket.name === reference.ticketName
      )
    );
  }
  if (matches.length === 1) return { ok: true, value: matches[0] };
  return {
    ok: false,
    diagnostic: invalid(
      project.path,
      'not-found',
      matches.length === 0
        ? `Ticket not found: ${originalReference}`
        : `Ticket reference is ambiguous: ${originalReference}`
    ),
  };
}

async function cleanReferences(
  workspaceRoot: string,
  change: ReferenceChange
): Promise<DocumentDiagnostic[]> {
  const diagnostics: DocumentDiagnostic[] = [];
  const projects = await discoverProjects(workspaceRoot);
  diagnostics.push(...projects.diagnostics);
  for (const project of projects.entries) {
    const statuses = await discoverStatuses(project);
    diagnostics.push(...statuses.diagnostics);
    for (const status of statuses.entries) {
      const tickets = await discoverTickets(status);
      diagnostics.push(...tickets.diagnostics);
      for (const ticket of tickets.entries) {
        if (
          change.kind === 'complete' &&
          ticket.path === change.completedPath
        ) {
          continue;
        }
        const result = await updateReferences(ticket, change);
        if (!result.ok) diagnostics.push(result.diagnostic);
      }
    }
  }
  return diagnostics.sort(compareDiagnostics);
}

async function updateReferences(
  ticket: Ticket,
  change: ReferenceChange
): Promise<Outcome<undefined>> {
  const document = await readTrackerDocument(ticket.path, 'ticket');
  if (!document.ok) return document;
  const metadata = document.value.metadata;
  const blockers = referenceArray(ticket, metadata['Blocked-By'], 'Blocked-By');
  if (!blockers.ok) return blockers;

  const updates = new Map<string, unknown>();
  if (change.kind === 'rename') {
    const parent = optionalReference(ticket, metadata.Parent, 'Parent');
    if (!parent.ok) return parent;
    const rewrittenParent =
      parent.value === null
        ? null
        : rewriteReference(parent.value, ticket.status.project.name, change);
    if (rewrittenParent !== parent.value) {
      updates.set('Parent', rewrittenParent);
    }

    const rewrittenBlockers = blockers.value.map((reference) =>
      rewriteReference(reference, ticket.status.project.name, change)
    );
    if (!sameReferences(blockers.value, rewrittenBlockers)) {
      updates.set('Blocked-By', rewrittenBlockers);
    }
  } else {
    const retained = blockers.value.filter(
      (reference) =>
        !matchesReference(
          reference,
          ticket.status.project.name,
          change.reference
        )
    );
    if (!sameReferences(blockers.value, retained)) {
      updates.set('Blocked-By', retained);
    }
  }

  if (updates.size === 0) {
    return { ok: true, value: undefined };
  }
  const rewritten = updateTrackerMetadata(ticket.path, document.value, updates);
  return rewritten.ok
    ? writeTrackerDocument(ticket.path, rewritten.value)
    : rewritten;
}

function rewriteReference(
  reference: string,
  containingProject: string,
  change: Extract<ReferenceChange, { kind: 'rename' }>
): string {
  if (!matchesReference(reference, containingProject, change.oldReference)) {
    return reference;
  }
  return reference.includes('/')
    ? `${change.oldReference.projectName}/${change.newTicketName}`
    : change.newTicketName;
}

function matchesReference(
  reference: string,
  containingProject: string,
  target: ResolvedReference
): boolean {
  const separator = reference.indexOf('/');
  return separator === -1
    ? containingProject === target.projectName &&
        reference === target.ticketName
    : reference.slice(0, separator) === target.projectName &&
        reference.slice(separator + 1) === target.ticketName;
}

function optionalReference(
  ticket: Ticket,
  value: unknown,
  field: string
): Outcome<string | null> {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: null };
  }
  return typeof value === 'string' && isTicketReference(value)
    ? { ok: true, value }
    : invalidMetadata(ticket, field);
}

function referenceArray(
  ticket: Ticket,
  value: unknown,
  field: string
): Outcome<readonly string[]> {
  if (value === undefined) return { ok: true, value: [] };
  if (
    Array.isArray(value) &&
    value.every(
      (reference) =>
        typeof reference === 'string' && isTicketReference(reference)
    )
  ) {
    return { ok: true, value };
  }
  return invalidMetadata(ticket, field);
}

function invalidMetadata<T>(ticket: Ticket, field: string): Outcome<T> {
  return {
    ok: false,
    diagnostic: invalid(
      ticket.path,
      'invalid-ticket-metadata',
      `Invalid ${field} metadata`
    ),
  };
}

function sameReferences(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((reference, index) => reference === right[index])
  );
}

function resolveReference(
  workspaceRoot: string,
  selectedProject: string,
  reference: string
): Outcome<ResolvedReference> {
  if (!isNormalizedName(selectedProject)) {
    return {
      ok: false,
      diagnostic: invalid(
        workspaceRoot,
        'invalid-name',
        `Invalid project name: ${selectedProject}`
      ),
    };
  }
  if (!isTicketReference(reference)) {
    return {
      ok: false,
      diagnostic: invalid(
        workspaceRoot,
        'invalid-reference',
        `Invalid ticket reference: ${reference}`
      ),
    };
  }
  const separator = reference.indexOf('/');
  return {
    ok: true,
    value:
      separator === -1
        ? { projectName: selectedProject, ticketName: reference }
        : {
            projectName: reference.slice(0, separator),
            ticketName: reference.slice(separator + 1),
          },
  };
}

function failed(diagnostic: DocumentDiagnostic): MutationOutcome {
  return { ok: false, diagnostics: [diagnostic], partial: false };
}

function resourceExists(path: string): DocumentDiagnostic {
  return invalid(path, 'resource-exists', `Resource already exists: ${path}`);
}

function filesystemFailure(path: string, error: unknown): DocumentDiagnostic {
  return invalid(
    path,
    'filesystem-error',
    error instanceof Error ? error.message : String(error)
  );
}

function invalid(
  path: string,
  code: DocumentDiagnostic['code'],
  message: string
): DocumentDiagnostic {
  return { path, code, message };
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

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === code
  );
}
