import type { ProjectSelection } from './git.ts';

type ProjectSelectionFailure = Extract<ProjectSelection, { ok: false }>;

export function writeSuccess(value: string): void {
  process.stdout.write(`${value}\n`);
}

export function writeDiagnostic(message: string): void {
  process.stderr.write(`${message}\n`);
}

export function formatProjectSelectionFailure(
  failure: ProjectSelectionFailure
): string {
  switch (failure.reason) {
    case 'not-a-worktree':
      return 'Cannot discover a project: the current directory is not in a Git worktree; use --project.';
    case 'missing-origin':
      return 'Cannot discover a project: the Git worktree has no origin fetch URL; use --project.';
    case 'git-error':
      return `Cannot discover a project: Git could not ${failure.operation === 'inspect-worktree' ? 'inspect the current worktree' : 'read its origin'} (${JSON.stringify(failure.detail)}); use --project.`;
    case 'invalid-origin':
      return `Cannot discover a project: origin has an invalid remote (${JSON.stringify(failure.origin)}); use --project.`;
    case 'no-match':
      return `Cannot discover a project: no project matches origin ${JSON.stringify(failure.origin)}; use --project.`;
    case 'ambiguous':
      return `Cannot discover a project: origin ${JSON.stringify(failure.origin)} matches multiple projects (${failure.projects.join(', ')}); use --project.`;
  }
}
