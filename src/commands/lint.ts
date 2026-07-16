import type { LintResult, Tracker } from '../tracker/index.ts';

export function lintProject(
  tracker: Tracker,
  projectName: string
): Promise<LintResult> {
  return tracker.lintProject(projectName);
}
