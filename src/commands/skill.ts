import {
  installSkill as installBundledSkill,
  type ConfirmOverwrite,
  type SkillInstallationResult,
} from '../skill.ts';

export type InstallSkillInput = {
  readonly target?: string;
  readonly force?: boolean;
};

export function installSkill(
  input: InstallSkillInput,
  dependencies: {
    readonly interactive: boolean;
    readonly confirmOverwrite: ConfirmOverwrite;
  }
): Promise<SkillInstallationResult> {
  return installBundledSkill({ ...input, ...dependencies });
}
