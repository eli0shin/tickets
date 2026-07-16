import { createTracker, type LintResult } from '../tracker/index.ts';

export async function lintProject(
  workspaceRoot: string,
  projectName: string
): Promise<LintResult> {
  return createTracker(workspaceRoot).lintProject(projectName);
}
