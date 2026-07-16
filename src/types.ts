import type { ProjectSelection } from './git.ts';
import type { DocumentDiagnostic } from './tracker/index.ts';

export type CommandFailure =
  | { readonly kind: 'message'; readonly message: string }
  | { readonly kind: 'diagnostic'; readonly diagnostic: DocumentDiagnostic }
  | {
      readonly kind: 'project-selection';
      readonly failure: Extract<ProjectSelection, { readonly ok: false }>;
    };

export type CommandOutcome<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly failure: CommandFailure };
