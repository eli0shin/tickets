import type {
  CreateTicketInput,
  Outcome,
  Project,
  Status,
  Ticket,
  Tracker,
} from '../tracker/index.ts';

export function createProject(
  tracker: Tracker,
  name: string,
  defaultStatus: string | undefined,
  gitRepo: string | undefined
): Promise<Outcome<Project>> {
  return tracker.createProject(name, { defaultStatus, gitRepo });
}

export function createStatus(
  tracker: Tracker,
  projectName: string,
  name: string
): Promise<Outcome<Status>> {
  return tracker.createStatus(projectName, name);
}

export function createTicket(
  tracker: Tracker,
  projectName: string,
  input: CreateTicketInput
): Promise<Outcome<Ticket>> {
  return tracker.createTicket(projectName, input);
}
