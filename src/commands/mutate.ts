import type { MutationOutcome, Tracker } from '../tracker/index.ts';

export function renameTicket(
  tracker: Tracker,
  projectName: string,
  reference: string,
  description: string
): Promise<MutationOutcome> {
  return tracker.renameTicket(projectName, reference, description);
}

export function moveTicket(
  tracker: Tracker,
  projectName: string,
  reference: string,
  statusName: string
): Promise<MutationOutcome> {
  return tracker.moveTicket(projectName, reference, statusName);
}

export function completeTicket(
  tracker: Tracker,
  projectName: string,
  reference: string
): Promise<MutationOutcome> {
  return tracker.completeTicket(projectName, reference);
}
