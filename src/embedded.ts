import { lstat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  normalizeName,
  type DocumentDiagnostic,
  type Project,
} from './tracker/index.ts';

export type EmbeddedProjectDiscovery =
  | { readonly ok: true; readonly project: Project | undefined }
  | { readonly ok: false; readonly diagnostic: DocumentDiagnostic };

/** Find the nearest Embedded Project containing the current directory. */
export async function discoverEmbeddedProject(
  cwd: string
): Promise<EmbeddedProjectDiscovery> {
  let directory = resolve(cwd);

  while (true) {
    const projectPath = join(directory, '.tickets');
    try {
      await lstat(projectPath);
      const name = normalizeName(basename(directory));
      return name === null
        ? {
            ok: false,
            diagnostic: {
              path: projectPath,
              code: 'invalid-name',
              message: `Cannot derive a project name from directory: ${directory}`,
            },
          }
        : { ok: true, project: { name, path: projectPath } };
    } catch (error) {
      if (!isMissing(error)) {
        return {
          ok: false,
          diagnostic: {
            path: projectPath,
            code: 'filesystem-error',
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }

    const parent = dirname(directory);
    if (parent === directory) return { ok: true, project: undefined };
    directory = parent;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
