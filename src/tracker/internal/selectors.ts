import type { Project, Ticket } from './discovery.ts';
import { discoverStatuses, discoverTickets } from './discovery.ts';
import type { DocumentDiagnostic, Outcome } from './documents.ts';
import {
  isNormalizedName,
  isTicketReference,
  isTicketSelector,
} from './names.ts';

export type TicketSelectorProjects = {
  readonly diagnosticPath: string;
  localProjectAt(name: string): Project;
  qualifiedProjectAt(name: string): Project;
};

export async function canonicalizeTicketSelector(
  projects: TicketSelectorProjects,
  selectedProject: string,
  selector: string
): Promise<Outcome<string>> {
  if (!isNormalizedName(selectedProject)) {
    return invalid(
      projects.diagnosticPath,
      'invalid-name',
      `Invalid project name: ${selectedProject}`
    );
  }
  if (!isTicketSelector(selector)) {
    return invalid(
      projects.diagnosticPath,
      'invalid-reference',
      `Invalid ticket selector: ${selector}`
    );
  }
  if (isTicketReference(selector)) return { ok: true, value: selector };

  const separator = selector.indexOf('/');
  const projectName =
    separator === -1 ? selectedProject : selector.slice(0, separator);
  const id = separator === -1 ? selector : selector.slice(separator + 1);
  const project =
    separator === -1
      ? projects.localProjectAt(projectName)
      : projects.qualifiedProjectAt(projectName);
  const statuses = await discoverStatuses(project);
  const statusFailure = statuses.diagnostics.at(0);
  if (statusFailure !== undefined) {
    return { ok: false, diagnostic: statusFailure };
  }

  const matches: Ticket[] = [];
  for (const status of statuses.entries) {
    const tickets = await discoverTickets(status);
    const failure = tickets.diagnostics.at(0);
    if (failure !== undefined) return { ok: false, diagnostic: failure };
    matches.push(
      ...tickets.entries.filter((ticket) => ticketIdText(ticket.name) === id)
    );
  }

  if (matches.length !== 1) {
    return invalid(
      project.path,
      'not-found',
      matches.length === 0
        ? `Ticket not found: ${selector}`
        : `Ticket selector is ambiguous: ${selector}`
    );
  }

  const reference =
    separator === -1 ? matches[0].name : `${projectName}/${matches[0].name}`;
  return { ok: true, value: reference };
}

export async function canonicalizeTicketSelectors(
  projects: TicketSelectorProjects,
  selectedProject: string,
  selectors: readonly string[]
): Promise<Outcome<readonly string[]>> {
  const references: string[] = [];
  for (const selector of selectors) {
    const reference = await canonicalizeTicketSelector(
      projects,
      selectedProject,
      selector
    );
    if (!reference.ok) return reference;
    references.push(reference.value);
  }
  return { ok: true, value: references };
}

function ticketIdText(ticketName: string): string {
  return ticketName.slice(0, ticketName.indexOf('-'));
}

function invalid<T>(
  path: string,
  code: DocumentDiagnostic['code'],
  message: string
): Outcome<T> {
  return { ok: false, diagnostic: { path, code, message } };
}
