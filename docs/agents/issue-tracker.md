# Local issue tracker

The tracker workspace is `~/.local/state/tickets`; this repository's project is `tickets`.

## Layout

- `~/.local/state/tickets/tickets/project.md` contains project metadata.
- Immediate project subdirectories are statuses.
- Each ticket is one Markdown file inside a status directory.
- Ticket names are project-scoped. A cross-project reference uses `project/ticket-name`.
- `done` is the completed status.

## Wayfinding operations

### Map and child representation

A map is a ticket tagged `wayfinder-map`. A child names the map in `Parent` and has exactly one Wayfinder type in `Tags`: `research`, `prototype`, `grilling`, or `task`. Additional tags are allowed.

### Create a map

Create the map in `todo`, then create each currently specifiable child in `todo`. Assign sequential ticket names by scanning all project status directories for the highest numeric prefix. In a second pass, add active ticket names to the `Blocked-By` YAML array.

### Load a map

Read the map file only. Do not load all child bodies. Use front matter to find children and zoom into a child only when needed.

### Claim a ticket

Before doing any work, confirm `Assigned-To` is empty, set it to the agent's name, and move the file to `in-progress`. Claims are best-effort and have no concurrency guarantee.

### Find the frontier

Scan non-`done` status directories for tickets whose `Parent` names the map, `Assigned-To` is empty, and `Blocked-By` is empty. Sort by the numeric ticket prefix.

### Resolve a ticket

Append a `## Resolution` section containing the decision and rationale. When the resolution establishes an architectural contract, record that contract in `docs/adr/` and link it from the ticket rather than pasting it into the ticket. Preserve `Assigned-To`, remove the resolved ticket from every `Blocked-By` field, and move it to `done`. Then append one linked gist to the map's `## Decisions so far`; use the ticket title as the link text, never a bare number.

Use relative links between ticket files. Because statuses can change, update a link whenever either linked ticket moves.

### Rule a ticket out of scope

Append the reason, preserve `Assigned-To`, and move the ticket to `done`. Add one linked line under the map's `## Out of scope`, not `## Decisions so far`.

### Update the frontier

Create newly precise tickets first, then add blocking references. Remove graduated subjects from `## Not yet specified`. Keep unresolved questions in that section until they can be stated precisely.
