import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isNormalizedName, parseTicketName } from './names.ts';
import type { DocumentDiagnostic } from './documents.ts';

export type Project = {
  readonly name: string;
  readonly path: string;
};

export type Status = {
  readonly name: string;
  readonly path: string;
  readonly project: Project;
};

export type Ticket = {
  readonly id: bigint;
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly status: Status;
};

export type Discovery<T> = {
  readonly entries: readonly T[];
  readonly diagnostics: readonly DocumentDiagnostic[];
};

type DirectoryEntry = Dirent<string>;

async function directoryEntries(
  path: string
): Promise<
  | { readonly ok: true; readonly entries: readonly DirectoryEntry[] }
  | { readonly ok: false; readonly diagnostic: DocumentDiagnostic }
> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return { ok: true, entries };
  } catch (error) {
    return {
      ok: false,
      diagnostic: {
        path,
        code: 'filesystem-error',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function failedDiscovery<T>(diagnostic: DocumentDiagnostic): Discovery<T> {
  return { entries: [], diagnostics: [diagnostic] };
}

export async function discoverProjects(
  workspaceRoot: string
): Promise<Discovery<Project>> {
  const result = await directoryEntries(workspaceRoot);
  if (!result.ok) return failedDiscovery(result.diagnostic);

  const entries = result.entries
    .filter(
      (entry) =>
        !entry.name.startsWith('.') &&
        entry.isDirectory() &&
        isNormalizedName(entry.name)
    )
    .map((entry) => ({
      name: entry.name,
      path: join(workspaceRoot, entry.name),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return { entries, diagnostics: [] };
}

export async function discoverStatuses(
  project: Project
): Promise<Discovery<Status>> {
  const result = await directoryEntries(project.path);
  if (!result.ok) return failedDiscovery(result.diagnostic);

  const entries = result.entries
    .filter(
      (entry) =>
        !entry.name.startsWith('.') &&
        entry.isDirectory() &&
        isNormalizedName(entry.name)
    )
    .map((entry) => ({
      name: entry.name,
      path: join(project.path, entry.name),
      project,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return { entries, diagnostics: [] };
}

export async function discoverTickets(
  status: Status
): Promise<Discovery<Ticket>> {
  const result = await directoryEntries(status.path);
  if (!result.ok) return failedDiscovery(result.diagnostic);

  const entries: Ticket[] = [];
  for (const entry of result.entries) {
    if (
      entry.name.startsWith('.') ||
      !entry.isFile() ||
      !entry.name.endsWith('.md')
    ) {
      continue;
    }

    const parsed = parseTicketName(entry.name.slice(0, -3));
    if (parsed === null) continue;
    entries.push({
      ...parsed,
      path: join(status.path, entry.name),
      status,
    });
  }

  entries.sort((left, right) => {
    if (left.id === right.id) return left.name.localeCompare(right.name);
    return left.id < right.id ? -1 : 1;
  });
  return { entries, diagnostics: [] };
}
