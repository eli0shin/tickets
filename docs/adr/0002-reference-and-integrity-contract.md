---
status: accepted
---

# Keep relationship integrity lightweight and visible

Ticket relationships are plain YAML metadata rather than a graph enforced by the tracker. The CLI does not detect or prevent self-references, duplicate references, parent cycles, or blocking cycles; this keeps direct filesystem editing and CLI behavior simple.

## Contract

- Broken references do not prevent unrelated operations. Commands that follow one report that its ticket was not found, and `tickets lint` reports it.
- The CLI has no delete command. Users delete files with normal filesystem tools; references left behind become broken references.
- Renaming a ticket keeps its numeric ID, changes its description, and rewrites matching `Parent` and `Blocked-By` references across the workspace. It renames the target first, then performs reference cleanup.
- Moving a ticket to `done` through the CLI preserves the completed ticket file unchanged, including its `Assigned-To` and its own `Blocked-By`, and removes its reference from every other ticket's `Blocked-By` array. Parent relationships remain unchanged.
- `tickets done <reference>` and `tickets move <reference> done` invoke exactly the same completion operation. If `done` does not exist, completion creates it.
- Completion is idempotent. Running it for a ticket already in `done` reruns blocker-reference cleanup while preserving that ticket's file.
- Completion moves the target before scanning the workspace for references to remove. Cleanup continues after individual failures and retains all successful edits without rollback. Rename cleanup follows the same continuation and partial-change rules.
- If rename or completion cleanup fails, the command emits no stdout, sorts failures by absolute path and then message, reports one tab-separated `<absolute-path>\t<message>` diagnostic per failed file on stderr, and exits `2`. Only full success prints the target ticket path.
- Moving a ticket out of `done` does not restore removed blocker references.
- Manual moves, renames, and deletions receive no automatic cleanup; users make any related metadata edits themselves.
- Multi-file operations have no transaction or rollback mechanism. If an operation fails partway through, the visible partial changes remain.
