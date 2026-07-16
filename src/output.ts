import { createInterface } from 'node:readline/promises';
import type { ProjectSelection } from './git.ts';
import type { SkillInstallationResult } from './skill.ts';
import type { CommandFailure, CommandOutcome } from './types.ts';
import type {
  DocumentDiagnostic,
  LintViolation,
  Project,
  QueryResult,
  Status,
  MutationOutcome,
} from './tracker/index.ts';

type NamedResource = Pick<Project | Status, 'name' | 'path'>;
type ProjectSelectionFailure = Extract<ProjectSelection, { ok: false }>;

export function writeStdout(value: string): void {
  process.stdout.write(value);
}

export function writeStderr(value: string): void {
  process.stderr.write(value);
}

export function writeSuccess(value: string): void {
  writeStdout(`${value}\n`);
}

export function writeRaw(value: string): void {
  writeStdout(value);
}

export function writeDiagnostic(message: string): void {
  writeStderr(`${message}\n`);
}

export async function confirmOverwrite(
  installedPath: string
): Promise<boolean> {
  const prompt = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  try {
    const answer = await prompt.question(
      `${installedPath} already exists. Overwrite? [y/N] `
    );
    return ['y', 'yes'].includes(answer.trim().toLowerCase());
  } finally {
    prompt.close();
  }
}

export function writeCommandFailure(failure: CommandFailure): void {
  switch (failure.kind) {
    case 'message':
      writeDiagnostic(failure.message);
      break;
    case 'diagnostic':
      writeDiagnostic(failure.diagnostic.message);
      break;
    case 'project-selection':
      writeDiagnostic(formatProjectSelectionFailure(failure.failure));
      break;
  }
  process.exitCode = 2;
}

export function writeCommandOutcome<Value>(
  outcome: CommandOutcome<Value>,
  writeValue: (value: Value) => void
): void {
  if (outcome.ok) {
    writeValue(outcome.value);
    return;
  }
  writeCommandFailure(outcome.failure);
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
      return 'Cannot discover a project: origin has an invalid remote; use --project.';
    case 'no-match':
      return `Cannot discover a project: no project matches origin ${JSON.stringify(failure.origin)}; use --project.`;
    case 'ambiguous':
      return `Cannot discover a project: origin ${JSON.stringify(failure.origin)} matches multiple projects (${failure.projects.join(', ')}); use --project.`;
  }
}

export function writeLint(
  project: string,
  violations: readonly LintViolation[],
  json: boolean
): void {
  if (json) {
    writeStdout(`${JSON.stringify({ project, violations }, null, 2)}\n`);
    return;
  }
  for (const violation of violations) {
    writeStdout(`${violation.path}\t${violation.code}\t${violation.message}\n`);
  }
}

export function writeLintOutcome(
  project: string,
  outcome:
    | { readonly ok: true; readonly violations: readonly LintViolation[] }
    | {
        readonly ok: false;
        readonly diagnostic: { readonly message: string };
      },
  json: boolean
): void {
  if (!outcome.ok) {
    writeDiagnostic(outcome.diagnostic.message);
    process.exitCode = 2;
    return;
  }
  writeLint(project, outcome.violations, json);
  if (outcome.violations.length > 0) process.exitCode = 1;
}

export function writeSkillInstallation(result: SkillInstallationResult): void {
  if (result.status === 'installed') {
    writeSuccess(result.path);
  } else if (result.status === 'error') {
    writeDiagnostic(result.message);
    process.exitCode = 2;
  }
}

export function assignUsageExitCode(exitCode: number): void {
  if (exitCode !== 0) process.exitCode = 2;
}

export function writeDiagnostics(
  diagnostics: readonly DocumentDiagnostic[],
  includePath = true
): void {
  for (const diagnostic of diagnostics) {
    writeDiagnostic(
      includePath
        ? `${diagnostic.path}\t${diagnostic.message}`
        : diagnostic.message
    );
  }
}

export function writeProjectList(
  projects: readonly NamedResource[],
  json: boolean
): void {
  if (json) {
    writeJson({ projects });
    return;
  }
  writeRecords(projects.map((project) => [project.name, project.path]));
}

export function writeStatusList(
  project: string,
  statuses: readonly NamedResource[],
  json: boolean
): void {
  if (json) {
    writeJson({
      project,
      statuses: statuses.map((status) => ({
        name: status.name,
        path: status.path,
      })),
    });
    return;
  }
  writeRecords(statuses.map((status) => [status.name, status.path]));
}

export function writeTicketQueryResult(
  result: QueryResult,
  json: boolean
): void {
  writeTicketQuery(result, json);
  if (result.diagnostics.length > 0) {
    writeDiagnostics(result.diagnostics);
    process.exitCode = 2;
  }
}

function writeTicketQuery(result: QueryResult, json: boolean): void {
  if (json) {
    writeJson({
      project: result.project,
      tickets: result.tickets.map((ticket) => ({
        name: ticket.name,
        status: ticket.status,
        path: ticket.path,
        assignedTo: ticket.assignedTo,
        tags: ticket.tags,
        parent: ticket.parent,
        blockedBy: ticket.blockedBy,
      })),
    });
    return;
  }
  writeRecords(
    result.tickets.map((ticket) => [ticket.status, ticket.name, ticket.path])
  );
}

function writeRecords(records: readonly (readonly string[])[]): void {
  if (records.length === 0) return;
  writeStdout(`${records.map((fields) => fields.join('\t')).join('\n')}\n`);
}

function writeJson(value: unknown): void {
  writeStdout(`${JSON.stringify(value, null, 2)}\n`);
}

export function writeMutation(
  outcome:
    | { readonly ok: true; readonly value: { readonly path: string } }
    | {
        readonly ok: false;
        readonly diagnostic: { readonly message: string };
      }
): void {
  if (outcome.ok) {
    writeSuccess(outcome.value.path);
    return;
  }

  writeDiagnostic(outcome.diagnostic.message);
  process.exitCode = 2;
}

export function writeTicketMutation(outcome: MutationOutcome): void {
  if (outcome.ok) {
    writeSuccess(outcome.value.path);
    return;
  }
  if (outcome.partial) {
    writeDiagnostics(outcome.diagnostics);
  } else {
    for (const diagnostic of outcome.diagnostics) {
      writeDiagnostic(diagnostic.message);
    }
  }
  process.exitCode = 2;
}
