export type Tracker = {
  readonly workspaceRoot: string;
};

export function createTracker(workspaceRoot: string): Tracker {
  return { workspaceRoot };
}
