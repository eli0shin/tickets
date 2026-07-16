import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeRemote } from '../../git.ts';
import type { DocumentDiagnostic } from './documents.ts';
import { readTrackerDocument } from './documents.ts';
import {
  isNormalizedName,
  isTicketReference,
  parseTicketName,
} from './names.ts';

export type LintCode =
  | 'unexpected-project-entry'
  | 'unexpected-status-entry'
  | 'missing-project-metadata'
  | 'malformed-project-yaml'
  | 'duplicate-project-key'
  | 'missing-default-status'
  | 'invalid-default-status'
  | 'missing-default-status-directory'
  | 'invalid-git-repo'
  | 'malformed-ticket-yaml'
  | 'duplicate-ticket-key'
  | 'invalid-assigned-to'
  | 'invalid-tags'
  | 'invalid-parent'
  | 'invalid-blocked-by'
  | 'duplicate-ticket-id'
  | 'broken-parent-reference'
  | 'broken-blocker-reference'
  | 'duplicate-git-repo';

export type LintViolation = {
  readonly path: string;
  readonly code: LintCode;
  readonly message: string;
};

export type LintResult =
  | { readonly ok: true; readonly violations: readonly LintViolation[] }
  | { readonly ok: false; readonly diagnostic: DocumentDiagnostic };

type ProjectEntry = { readonly name: string; readonly path: string };
type StatusEntry = ProjectEntry;
type TicketEntry = ProjectEntry & {
  readonly id: bigint;
  readonly statusName: string;
};

export async function lintProject(
  workspaceRoot: string,
  projectName: string
): Promise<LintResult> {
  const projectPath = join(workspaceRoot, projectName);
  const projectEntries = await readDirectory(projectPath);
  if (!projectEntries.ok) return projectEntries;

  const violations: LintViolation[] = [];
  const statuses: StatusEntry[] = [];
  let metadataIsFile = false;

  for (const entry of projectEntries.entries) {
    if (entry.name.startsWith('.')) continue;
    const path = join(projectPath, entry.name);
    if (
      entry.name === 'project.md' &&
      (entry.isFile() || entry.isSymbolicLink())
    ) {
      metadataIsFile = true;
    } else if (entry.isSymbolicLink()) {
      continue;
    } else if (entry.isDirectory() && isNormalizedName(entry.name)) {
      statuses.push({ name: entry.name, path });
    } else {
      violations.push({
        path,
        code: 'unexpected-project-entry',
        message: `Unexpected project entry: ${entry.name}`,
      });
    }
  }
  statuses.sort(byName);

  const metadataPath = join(projectPath, 'project.md');
  let selectedRepository: string | null = null;
  if (!metadataIsFile) {
    violations.push({
      path: metadataPath,
      code: 'missing-project-metadata',
      message: 'Project metadata file project.md is missing',
    });
  } else {
    const projectDocument = await readTrackerDocument(metadataPath, 'project');
    if (!projectDocument.ok) {
      if (isLintParserCode(projectDocument.diagnostic.code)) {
        violations.push({
          path: projectDocument.diagnostic.path,
          code: projectDocument.diagnostic.code,
          message: projectDocument.diagnostic.message,
        });
      } else {
        return projectDocument;
      }
    } else {
      const metadata = projectDocument.value.metadata;
      if (!Object.hasOwn(metadata, 'Default-Status')) {
        violations.push({
          path: metadataPath,
          code: 'missing-default-status',
          message: 'Default-Status is missing',
        });
      } else if (
        typeof metadata['Default-Status'] !== 'string' ||
        !isNormalizedName(metadata['Default-Status'])
      ) {
        violations.push({
          path: metadataPath,
          code: 'invalid-default-status',
          message: 'Default-Status must be one normalized status name',
        });
      } else if (
        !statuses.some((status) => status.name === metadata['Default-Status'])
      ) {
        violations.push({
          path: metadataPath,
          code: 'missing-default-status-directory',
          message: `Default status directory does not exist: ${metadata['Default-Status']}`,
        });
      }

      const repository = metadata['Git-Repo'];
      if (
        repository !== undefined &&
        repository !== null &&
        repository !== ''
      ) {
        selectedRepository =
          typeof repository === 'string'
            ? (normalizeRemote(repository) ?? null)
            : null;
        if (selectedRepository === null) {
          violations.push({
            path: metadataPath,
            code: 'invalid-git-repo',
            message: 'Git-Repo is not a supported remote',
          });
        }
      }
    }
  }

  const tickets: TicketEntry[] = [];
  for (const status of statuses) {
    const statusEntries = await readDirectory(status.path);
    if (!statusEntries.ok) return statusEntries;
    for (const entry of statusEntries.entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const path = join(status.path, entry.name);
      const parsed =
        entry.isFile() && entry.name.endsWith('.md')
          ? parseTicketName(entry.name.slice(0, -3))
          : null;
      if (parsed === null) {
        violations.push({
          path,
          code: 'unexpected-status-entry',
          message: `Unexpected status entry: ${entry.name}`,
        });
      } else {
        tickets.push({
          id: parsed.id,
          name: parsed.name,
          path,
          statusName: status.name,
        });
      }
    }
  }

  const workspaceTickets = await discoverWorkspaceTickets(workspaceRoot);
  if (!workspaceTickets.ok) return workspaceTickets;
  const ticketsByReference = indexTicketReferences(
    projectName,
    workspaceTickets.tickets
  );

  for (const ticket of tickets) {
    const document = await readTrackerDocument(ticket.path, 'ticket');
    if (!document.ok) {
      if (isLintParserCode(document.diagnostic.code)) {
        violations.push({
          path: document.diagnostic.path,
          code: document.diagnostic.code,
          message: document.diagnostic.message,
        });
        continue;
      }
      return document;
    }

    const metadata = document.value.metadata;
    const assignedTo = metadata['Assigned-To'];
    if (!isEmpty(assignedTo) && !isNormalizedString(assignedTo)) {
      violations.push({
        path: ticket.path,
        code: 'invalid-assigned-to',
        message: 'Assigned-To must be empty or one normalized assignee',
      });
    }

    const tags = metadata.Tags;
    if (tags !== undefined && !isNormalizedStringArray(tags)) {
      violations.push({
        path: ticket.path,
        code: 'invalid-tags',
        message: 'Tags must be an array of normalized tags',
      });
    }

    const parent = metadata.Parent;
    if (!isEmpty(parent) && !isReference(parent)) {
      violations.push({
        path: ticket.path,
        code: 'invalid-parent',
        message: 'Parent must be empty or one valid ticket reference',
      });
    } else if (
      typeof parent === 'string' &&
      parent !== '' &&
      referenceCount(parent, ticketsByReference) !== 1
    ) {
      violations.push({
        path: ticket.path,
        code: 'broken-parent-reference',
        message: `Parent reference does not resolve to exactly one ticket: ${parent}`,
      });
    }

    const blockedBy = metadata['Blocked-By'];
    if (blockedBy !== undefined && !isReferenceArray(blockedBy)) {
      violations.push({
        path: ticket.path,
        code: 'invalid-blocked-by',
        message: 'Blocked-By must be an array of valid ticket references',
      });
    } else if (Array.isArray(blockedBy)) {
      for (const blocker of blockedBy) {
        if (referenceCount(blocker, ticketsByReference) !== 1) {
          violations.push({
            path: ticket.path,
            code: 'broken-blocker-reference',
            message: `Blocker reference does not resolve to exactly one ticket: ${blocker}`,
          });
        }
      }
    }
  }

  const byId = Map.groupBy(tickets, (ticket) => ticket.id);
  for (const [id, duplicates] of byId) {
    if (duplicates.length < 2) continue;
    const names = duplicates
      .map((ticket) => ticket.name)
      .sort()
      .join(', ');
    for (const ticket of duplicates) {
      violations.push({
        path: ticket.path,
        code: 'duplicate-ticket-id',
        message: `Ticket ID ${id} is duplicated by: ${names}`,
      });
    }
  }

  if (selectedRepository !== null) {
    const duplicates = await projectsWithRepository(
      workspaceRoot,
      projectName,
      selectedRepository
    );
    if (!duplicates.ok) return duplicates;
    if (duplicates.names.length > 0) {
      violations.push({
        path: metadataPath,
        code: 'duplicate-git-repo',
        message: `Git-Repo is also declared by: ${duplicates.names.join(', ')}`,
      });
    }
  }

  violations.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.code.localeCompare(right.code) ||
      left.message.localeCompare(right.message)
  );
  return { ok: true, violations };
}

function isLintParserCode(
  code: string
): code is Extract<LintCode, `${'malformed' | 'duplicate'}-${string}`> {
  return (
    code === 'malformed-project-yaml' ||
    code === 'duplicate-project-key' ||
    code === 'malformed-ticket-yaml' ||
    code === 'duplicate-ticket-key'
  );
}

async function readDirectory(
  path: string
): Promise<
  | { readonly ok: true; readonly entries: readonly Dirent<string>[] }
  | { readonly ok: false; readonly diagnostic: DocumentDiagnostic }
> {
  try {
    return { ok: true, entries: await readdir(path, { withFileTypes: true }) };
  } catch (error) {
    return filesystemFailure(path, error);
  }
}

async function discoverWorkspaceTickets(workspaceRoot: string): Promise<
  | {
      readonly ok: true;
      readonly tickets: readonly (TicketEntry & {
        readonly projectName: string;
      })[];
    }
  | { readonly ok: false; readonly diagnostic: DocumentDiagnostic }
> {
  const projects = await readDirectory(workspaceRoot);
  if (!projects.ok) return projects;
  const tickets: (TicketEntry & { projectName: string })[] = [];
  for (const project of projects.entries) {
    if (
      project.name.startsWith('.') ||
      project.isSymbolicLink() ||
      !project.isDirectory() ||
      !isNormalizedName(project.name)
    )
      continue;
    const projectPath = join(workspaceRoot, project.name);
    const entries = await readDirectory(projectPath);
    if (!entries.ok) return entries;
    for (const status of entries.entries) {
      if (
        status.name.startsWith('.') ||
        status.isSymbolicLink() ||
        !status.isDirectory() ||
        !isNormalizedName(status.name)
      )
        continue;
      const statusPath = join(projectPath, status.name);
      const statusEntries = await readDirectory(statusPath);
      if (!statusEntries.ok) return statusEntries;
      for (const entry of statusEntries.entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const parsed = parseTicketName(entry.name.slice(0, -3));
        if (parsed !== null)
          tickets.push({
            ...parsed,
            path: join(statusPath, entry.name),
            statusName: status.name,
            projectName: project.name,
          });
      }
    }
  }
  return { ok: true, tickets };
}

function indexTicketReferences(
  selectedProject: string,
  workspaceTickets: readonly (TicketEntry & { readonly projectName: string })[]
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const ticket of workspaceTickets) {
    const crossProject = `${ticket.projectName}/${ticket.name}`;
    counts.set(crossProject, (counts.get(crossProject) ?? 0) + 1);
    if (ticket.projectName === selectedProject) {
      counts.set(ticket.name, (counts.get(ticket.name) ?? 0) + 1);
    }
  }
  return counts;
}

function referenceCount(
  reference: string,
  counts: ReadonlyMap<string, number>
): number {
  return counts.get(reference) ?? 0;
}

async function projectsWithRepository(
  workspaceRoot: string,
  selectedProject: string,
  repository: string
): Promise<
  | { readonly ok: true; readonly names: readonly string[] }
  | { readonly ok: false; readonly diagnostic: DocumentDiagnostic }
> {
  const projects = await readDirectory(workspaceRoot);
  if (!projects.ok) return projects;
  const names: string[] = [];
  for (const project of projects.entries) {
    if (
      project.name === selectedProject ||
      project.name.startsWith('.') ||
      project.isSymbolicLink() ||
      !project.isDirectory() ||
      !isNormalizedName(project.name)
    )
      continue;
    const path = join(workspaceRoot, project.name, 'project.md');
    try {
      if (!(await stat(path)).isFile()) continue;
    } catch (error) {
      if (isMissingFileError(error)) continue;
      return filesystemFailure(path, error);
    }
    const document = await readTrackerDocument(path, 'project');
    if (!document.ok) {
      if (document.diagnostic.code === 'filesystem-error') return document;
      continue;
    }
    const value = document.value.metadata['Git-Repo'];
    if (typeof value === 'string' && normalizeRemote(value) === repository)
      names.push(project.name);
  }
  names.sort();
  return { ok: true, names };
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}
function isNormalizedString(value: unknown): value is string {
  return typeof value === 'string' && isNormalizedName(value);
}
function isNormalizedStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNormalizedString);
}
function isReference(value: unknown): value is string {
  return typeof value === 'string' && isTicketReference(value);
}
function isReferenceArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isReference);
}
function byName(left: ProjectEntry, right: ProjectEntry): number {
  return left.name.localeCompare(right.name);
}
function filesystemFailure(
  path: string,
  error: unknown
): { readonly ok: false; readonly diagnostic: DocumentDiagnostic } {
  return {
    ok: false,
    diagnostic: {
      path,
      code: 'filesystem-error',
      message: error instanceof Error ? error.message : String(error),
    },
  };
}
