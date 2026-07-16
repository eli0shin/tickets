import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import bundledSkill from '../assets/tickets/SKILL.md' with { type: 'text' };

export type ConfirmOverwrite = (installedPath: string) => Promise<boolean>;

export type SkillInstallationResult =
  | { status: 'installed'; path: string }
  | { status: 'declined' }
  | { status: 'error'; message: string };

type InstallSkillOptions = {
  target?: string;
  force?: boolean;
  interactive?: boolean;
  confirmOverwrite?: ConfirmOverwrite;
};

export async function installSkill({
  target = resolve(homedir(), '.agents/skills/tickets'),
  force = false,
  interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY),
  confirmOverwrite: confirm,
}: InstallSkillOptions = {}): Promise<SkillInstallationResult> {
  const targetDirectory = resolve(target);
  const installedPath = resolve(targetDirectory, 'SKILL.md');

  try {
    await mkdir(targetDirectory, { recursive: true });

    if (force) {
      await writeFile(installedPath, bundledSkill);
      return { status: 'installed', path: installedPath };
    }

    try {
      await writeFile(installedPath, bundledSkill, { flag: 'wx' });
      return { status: 'installed', path: installedPath };
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }

    if (!interactive) {
      return {
        status: 'error',
        message: `${installedPath} already exists; use --force to overwrite it`,
      };
    }

    if (confirm === undefined) {
      throw new Error('Interactive confirmation is not configured');
    }

    if (!(await confirm(installedPath))) {
      return { status: 'declined' };
    }

    await writeFile(installedPath, bundledSkill);
    return { status: 'installed', path: installedPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'error', message };
  }
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}
