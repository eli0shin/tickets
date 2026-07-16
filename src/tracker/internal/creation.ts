import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DocumentDiagnostic, Outcome } from './documents.ts';
import { readTrackerDocument, writeNewTrackerDocument } from './documents.ts';
import type { Project, Status, Ticket } from './discovery.ts';
import { discoverStatuses, discoverTickets } from './discovery.ts';
import { isNormalizedName, isTicketReference } from './names.ts';

export type CreateTicketInput = {
  readonly description: string;
  readonly status?: string;
  readonly assignee?: string;
  readonly tags?: readonly string[];
  readonly parent?: string;
  readonly blockedBy?: readonly string[];
};

export async function createProject(
  workspaceRoot: string,
  name: string,
  defaultStatus: string
): Promise<Outcome<Project>> {
  if (!isNormalizedName(name))
    return invalidName(workspaceRoot, 'project', name);
  if (!isNormalizedName(defaultStatus)) {
    return invalidName(workspaceRoot, 'status', defaultStatus);
  }

  const project = { name, path: join(workspaceRoot, name) } satisfies Project;
  try {
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(project.path);
    await Promise.all(
      [...new Set([defaultStatus, 'in-progress', 'done'])].map((status) =>
        mkdir(join(project.path, status))
      )
    );
    const write = await writeNewTrackerDocument(
      join(project.path, 'project.md'),
      {
        metadata: { 'Default-Status': defaultStatus, 'Git-Repo': null },
        body: '',
      }
    );
    return write.ok ? { ok: true, value: project } : write;
  } catch (error) {
    return hasErrorCode(error, 'EEXIST')
      ? resourceExists(project.path)
      : filesystemFailure(project.path, error);
  }
}

export async function createStatus(
  workspaceRoot: string,
  projectName: string,
  name: string
): Promise<Outcome<Status>> {
  if (!isNormalizedName(projectName)) {
    return invalidName(workspaceRoot, 'project', projectName);
  }
  if (!isNormalizedName(name))
    return invalidName(workspaceRoot, 'status', name);

  const project = {
    name: projectName,
    path: join(workspaceRoot, projectName),
  } satisfies Project;
  const status = {
    name,
    path: join(project.path, name),
    project,
  } satisfies Status;
  const projectDocument = await readTrackerDocument(
    join(project.path, 'project.md'),
    'project'
  );
  if (!projectDocument.ok) return projectDocument;
  const projectValidation = await validateProject(
    project,
    projectDocument.value
  );
  if (!projectValidation.ok) return projectValidation;

  try {
    await mkdir(status.path);
    return { ok: true, value: status };
  } catch (error) {
    return hasErrorCode(error, 'EEXIST')
      ? resourceExists(status.path)
      : filesystemFailure(status.path, error);
  }
}

export async function createTicket(
  workspaceRoot: string,
  projectName: string,
  input: CreateTicketInput
): Promise<Outcome<Ticket>> {
  const validation = validateTicketInput(workspaceRoot, projectName, input);
  if (!validation.ok) return validation;

  const project = {
    name: projectName,
    path: join(workspaceRoot, projectName),
  } satisfies Project;
  const projectDocument = await readTrackerDocument(
    join(project.path, 'project.md'),
    'project'
  );
  if (!projectDocument.ok) return projectDocument;

  const projectValidation = await validateProject(
    project,
    projectDocument.value
  );
  if (!projectValidation.ok) return projectValidation;
  const selectedStatus = input.status ?? projectValidation.value;

  const lockPath = join(project.path, '.ticket-creation-lock');
  const lock = await acquireCreationLock(lockPath);
  if (!lock.ok) return lock;

  return createTicketWithLockHeld(project, selectedStatus, input, lock.value);
}

async function createTicketWithLockHeld(
  project: Project,
  selectedStatus: string,
  input: CreateTicketInput,
  lock: CreationLock
): Promise<Outcome<Ticket>> {
  const heartbeat = setInterval(() => {
    const now = new Date();
    void utimes(lock.ownerPath, now, now).catch(() => undefined);
  }, 1_000);
  heartbeat.unref();

  return createTicketWhileLocked(project, selectedStatus, input).then(
    async (result) => {
      clearInterval(heartbeat);
      const release = await releaseCreationLock(lock);
      return release.ok ? result : release;
    },
    async (error: unknown) => {
      clearInterval(heartbeat);
      const release = await releaseCreationLock(lock);
      if (!release.ok) return release;
      throw error;
    }
  );
}

async function releaseCreationLock(
  lock: CreationLock
): Promise<Outcome<undefined>> {
  try {
    const currentOwner = await readCreationLockOwner(lock.ownerPath);
    if (currentOwner?.token !== lock.token) {
      return failure(
        lock.path,
        'resource-exists',
        'Ticket creation lock ownership changed unexpectedly'
      );
    }
    await rm(lock.path, { recursive: true });
    return { ok: true, value: undefined };
  } catch (error) {
    return filesystemFailure(lock.path, error);
  }
}

async function validateProject(
  project: Project,
  document: { readonly metadata: Readonly<Record<string, unknown>> }
): Promise<Outcome<string>> {
  const defaultStatus = document.metadata['Default-Status'];
  if (typeof defaultStatus !== 'string' || !isNormalizedName(defaultStatus)) {
    return failure(
      join(project.path, 'project.md'),
      'invalid-status',
      'Project Default-Status must be a normalized status name'
    );
  }

  const statuses = await discoverStatuses(project);
  const diagnostic = statuses.diagnostics.at(0);
  if (diagnostic !== undefined) return { ok: false, diagnostic };
  if (!statuses.entries.some(({ name }) => name === defaultStatus)) {
    return failure(
      join(project.path, defaultStatus),
      'status-not-found',
      `Default status not found: ${defaultStatus}`
    );
  }
  return { ok: true, value: defaultStatus };
}

const CREATION_LOCK_STALE_AFTER_MS = 30_000;
const CREATION_LOCK_OWNER = 'owner.json';

type CreationLock = {
  readonly path: string;
  readonly ownerPath: string;
  readonly token: string;
  readonly pid: number;
};

async function acquireCreationLock(
  lockPath: string
): Promise<Outcome<CreationLock>> {
  const lock = {
    path: lockPath,
    ownerPath: join(lockPath, CREATION_LOCK_OWNER),
    token: randomUUID(),
    pid: process.pid,
  } satisfies CreationLock;

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await mkdir(lock.path);
      await writeFile(
        lock.ownerPath,
        `${JSON.stringify({ token: lock.token, pid: lock.pid })}\n`,
        { encoding: 'utf8', flag: 'wx' }
      );
      return { ok: true, value: lock };
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) {
        await removeIncompleteCreationLock(lock);
        return filesystemFailure(lock.path, error);
      }
      const recovery = await removeStaleCreationLock(lock.path);
      if (!recovery.ok) return recovery;
      await Bun.sleep(10);
    }
  }
  return failure(
    lock.path,
    'resource-exists',
    'Another ticket creation is already in progress'
  );
}

async function removeIncompleteCreationLock(lock: CreationLock): Promise<void> {
  try {
    const owner = await readCreationLockOwner(lock.ownerPath);
    if (owner === null || owner.token === lock.token) {
      await rm(lock.path, { recursive: true });
    }
  } catch {
    // Preserve the original acquisition failure.
  }
}

async function removeStaleCreationLock(
  lockPath: string
): Promise<Outcome<undefined>> {
  try {
    const ownerPath = join(lockPath, CREATION_LOCK_OWNER);
    const owner = await readCreationLockOwner(ownerPath);
    const ownership = await stat(owner === null ? lockPath : ownerPath);
    const recentlyActive =
      Date.now() - ownership.mtimeMs <= CREATION_LOCK_STALE_AFTER_MS;
    if (recentlyActive && (owner === null || processIsRunning(owner.pid))) {
      return { ok: true, value: undefined };
    }
    await rm(lockPath, { recursive: true });
    return { ok: true, value: undefined };
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return { ok: true, value: undefined };
    return filesystemFailure(lockPath, error);
  }
}

async function readCreationLockOwner(
  ownerPath: string
): Promise<{ readonly token: string; readonly pid: number } | null> {
  try {
    const value: unknown = JSON.parse(await readFile(ownerPath, 'utf8'));
    if (
      value !== null &&
      typeof value === 'object' &&
      'token' in value &&
      typeof value.token === 'string' &&
      'pid' in value &&
      typeof value.pid === 'number' &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0
    ) {
      return { token: value.token, pid: value.pid };
    }
    return null;
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT') || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasErrorCode(error, 'ESRCH');
  }
}

async function createTicketWhileLocked(
  project: Project,
  selectedStatus: string,
  input: CreateTicketInput
): Promise<Outcome<Ticket>> {
  const statuses = await discoverStatuses(project);
  const statusDiagnostic = statuses.diagnostics.at(0);
  if (statusDiagnostic !== undefined) {
    return { ok: false, diagnostic: statusDiagnostic };
  }
  const status = statuses.entries.find(({ name }) => name === selectedStatus);
  if (status === undefined) {
    return failure(
      join(project.path, selectedStatus),
      'status-not-found',
      `Status not found: ${selectedStatus}`
    );
  }

  let highestId = 0n;
  for (const projectStatus of statuses.entries) {
    const tickets = await discoverTickets(projectStatus);
    const ticketDiagnostic = tickets.diagnostics.at(0);
    if (ticketDiagnostic !== undefined) {
      return { ok: false, diagnostic: ticketDiagnostic };
    }
    for (const existingTicket of tickets.entries) {
      if (existingTicket.id > highestId) highestId = existingTicket.id;
    }
  }

  const id = highestId + 1n;
  const name = `${id.toString().padStart(3, '0')}-${input.description}`;
  const ticket = {
    id,
    name,
    description: input.description,
    path: join(status.path, `${name}.md`),
    status,
  } satisfies Ticket;
  const write = await writeNewTrackerDocument(ticket.path, {
    metadata: {
      'Assigned-To': input.assignee ?? null,
      Tags: [...(input.tags ?? [])],
      Parent: input.parent ?? null,
      'Blocked-By': [...(input.blockedBy ?? [])],
    },
    body: '',
  });
  return write.ok ? { ok: true, value: ticket } : write;
}

function validateTicketInput(
  workspaceRoot: string,
  projectName: string,
  input: CreateTicketInput
): Outcome<undefined> {
  if (!isNormalizedName(projectName)) {
    return invalidName(workspaceRoot, 'project', projectName);
  }
  if (!isNormalizedName(input.description)) {
    return invalidName(workspaceRoot, 'ticket description', input.description);
  }
  if (input.status !== undefined && !isNormalizedName(input.status)) {
    return invalidName(workspaceRoot, 'status', input.status);
  }
  if (input.assignee !== undefined && !isNormalizedName(input.assignee)) {
    return invalidName(workspaceRoot, 'assignee', input.assignee);
  }
  for (const tag of input.tags ?? []) {
    if (!isNormalizedName(tag)) return invalidName(workspaceRoot, 'tag', tag);
  }
  if (input.parent !== undefined && !isTicketReference(input.parent)) {
    return invalidReference(workspaceRoot, input.parent);
  }
  for (const reference of input.blockedBy ?? []) {
    if (!isTicketReference(reference)) {
      return invalidReference(workspaceRoot, reference);
    }
  }
  return { ok: true, value: undefined };
}

function invalidName<T>(path: string, kind: string, value: string): Outcome<T> {
  return failure(path, 'invalid-name', `Invalid ${kind} name: ${value}`);
}

function invalidReference<T>(path: string, value: string): Outcome<T> {
  return failure(
    path,
    'invalid-reference',
    `Invalid ticket reference: ${value}`
  );
}

function resourceExists<T>(path: string): Outcome<T> {
  return failure(path, 'resource-exists', `Resource already exists: ${path}`);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === code
  );
}

function filesystemFailure<T>(path: string, error: unknown): Outcome<T> {
  return failure(
    path,
    'filesystem-error',
    error instanceof Error ? error.message : String(error)
  );
}

function failure<T>(
  path: string,
  code: DocumentDiagnostic['code'],
  message: string
): Outcome<T> {
  return { ok: false, diagnostic: { path, code, message } };
}
