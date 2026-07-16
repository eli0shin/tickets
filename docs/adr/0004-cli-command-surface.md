---
status: accepted
---

# Make tickets the default CLI namespace

The CLI keeps ticket operations at the root because tickets are the product's primary resource. Project, status, and skill operations use noun groups. The surface intentionally omits commands for operations that are clearer as direct filesystem edits.

## Global behavior

```text
tickets [--workspace <path>] [--project <name>] <command>
```

- `--workspace <path>` overrides the default `~/.local/state/tickets` workspace.
- `--project <name>` overrides Git-based project discovery for commands that operate on one selected project.
- Commands that inherently name or span projects do not use `--project`.
- `--help` and `--version` follow standard Commander behavior.

Exit status is `0` for success, `1` when a valid lint run finds violations, and `2` for usage, validation, not-found, or operational failure. Empty listings and searches succeed with `0`.

Diagnostics are written only to stderr. A failure associated with one invocation or resource emits one human-readable line. Read-only partial scans and workspace-wide mutation cleanup emit one tab-separated `<absolute-path>\t<message>` line per affected file, sorted by absolute path and then message. Partial list and search results retain their normal plain-text or JSON stdout schema and exit `2`; failed mutations emit no stdout. Machine-readable diagnostic codes belong only to lint findings, and the CLI defines no separate JSON error protocol.

## Project commands

```text
tickets project create <name> [--default-status <status>]
tickets project list [--json]
```

Project creation writes `project.md` and creates `in-progress`, `done`, and the default status. The default status is `todo` unless overridden; an override replaces `todo` rather than adding another status. Project deletion, renaming, and metadata editing remain filesystem operations.

## Status commands

```text
tickets status create <name>
tickets status list [--json]
```

These commands use the selected project. Status deletion and renaming remain filesystem operations.

## Ticket commands

Tickets are the default namespace; there is no `tickets ticket ...` group.

```text
tickets create <description>
  [--status <status>]
  [--assign <assignee>]
  [--tag <tag>...]
  [--parent <reference>]
  [--blocked-by <reference>...]

tickets show <reference>
tickets rename <reference> <description>
tickets move <reference> <status>
tickets done <reference>
tickets list <status> [--json]
tickets search
  [--status <status>]
  [--tag <tag>...]
  [--assigned-to <assignee> | --unassigned]
  [--parent <reference>]
  [--blocked-by <reference>... | --unblocked]
  [--json]
```

Creation uses the project's `Default-Status` unless `--status` overrides it. Create and rename accept human-readable descriptions and normalize them deterministically to the lowercase kebab-case on-disk description defined by the filesystem contract. They reject descriptions only when normalization cannot produce that on-disk form. Creation writes the standard front matter with supplied metadata and an empty Markdown body.

`show` prints the complete ticket file unchanged. There is no editor-launching command.

`done` is exact shorthand for moving to `done`; both routes invoke the same completion operation. Rename, move, and completion provide the cleanup behavior defined by the reference and integrity contract. There is no delete command, generic metadata editor, or post-creation command for assignment, tags, parents, or blockers; users edit those values directly in the ticket file.

Search criteria use AND semantics across different criterion types. Repeated `--status` values search their union; other repeated criteria use AND semantics. Assignment value and `--unassigned` are mutually exclusive; blocker values and `--unblocked` are mutually exclusive. Query behavior and output follow the query and lint contract.

## Maintenance and integration

```text
tickets lint [--json]
tickets skill install [--target <path>] [--force]
```

Lint operates on the selected project. Skill installation behavior is specified separately.

## Output

Successful creation and mutation commands print only the absolute path of the created or resulting resource. Rename and move print the ticket's new path. These commands do not support JSON.

`show` emits raw Markdown and does not support JSON.

Project and status listings are sorted by normalized name. Their plain text is headerless and tab-separated:

```text
<name>\t<absolute-path>
```

Their JSON shapes are:

```json
{
  "projects": [
    { "name": "tickets", "path": "/absolute/path/to/tickets" }
  ]
}
```

```json
{
  "project": "tickets",
  "statuses": [
    { "name": "todo", "path": "/absolute/path/to/tickets/todo" }
  ]
}
```

`--json` is supported only by `project list`, `status list`, `list`, `search`, and `lint`.
