---
status: accepted
---

# Use the filesystem as the complete data model

Tickets stores all durable state in directly editable Markdown files and directories under `~/.local/state/tickets`. This keeps the filesystem usable as the primary interface; the CLI scans and edits that state without hidden indexes, counters, caches, or databases. The trade-off is that manual edits can produce invalid data, which normal commands handle conservatively and `tickets lint` reports.

## Contract

```text
~/.local/state/tickets/
└── <project>/
    ├── project.md                 # required project metadata
    ├── <status>/                  # any unordered set
    │   └── <ticket>.md
    └── ...
```

### Entry discovery

- Workspace children with valid normalized directory names are projects.
- Immediate project children with valid normalized directory names are statuses.
- Markdown files with valid ticket names directly inside statuses are tickets.
- Hidden entries—names beginning with `.`—are ignored.
- Other non-hidden entries are ignored by normal commands. Project lint reports unexpected entries inside its selected project; unexpected workspace-root entries are outside project lint and remain ignored.
- Symlinks receive no product-specific handling. The implementation uses ordinary filesystem calls and inherits their behavior; lint and tests add no symlink-specific rules.
- Empty statuses are valid. A valid project contains `project.md` and the status named by its `Default-Status` field.
- `done` is the conventional completion sentinel. It is not required; project creation adds it by default, and a command that needs it may create it.
- Project creation also adds `todo` and `in-progress`, making `todo` the default status. If creation is given another default status, it creates that status instead of `todo`; `in-progress` and `done` are still created.

### Names

Project names, status names, tag values, and on-disk ticket descriptions use lowercase kebab-case:

```regex
^[a-z0-9]+(?:-[a-z0-9]+)*$
```

Create and rename accept human-readable description input and deterministically normalize it to the on-disk form: compatibility-decompose Unicode, lowercase it, remove combining marks, replace each run outside ASCII `a-z` and `0-9` with one hyphen, and trim leading or trailing hyphens. Input is invalid when normalization leaves no description. Already-normalized input is preserved exactly.

A ticket filename is `<id>-<description>.md`. The positive decimal ID is padded to at least three digits, starts at `001`, grows naturally beyond `999`, and is unique across every status in its project. The CLI allocates one greater than the highest currently discovered project ID. It keeps no hidden allocation history, so manually deleting the highest ticket can permit that ID to be reused. Simultaneous mutations are outside the filesystem contract; duplicate IDs produced by races remain visible to discovery and lint.

A local ticket reference is the filename without `.md`, such as `002-define-the-on-disk-contract`. A cross-project reference is `<project>/<ticket>`. Paths and statuses are never part of identity.

A reference that matches the same ticket name in multiple statuses is ambiguous and metadata-dependent commands fail without choosing. Creation and rename fail rather than overwrite if the resulting ticket name or destination path already exists anywhere it must be unique. Moving to the ticket's current status is a successful no-op; moving fails without overwriting when the destination path exists. Project and status creation likewise fail rather than overwrite existing entries.

### Project metadata

`project.md` is required. It uses YAML front matter and may have a free-form Markdown body:

```markdown
---
Default-Status: todo
Git-Repo:
---
```

`Default-Status` is required and names an existing normalized status used when ticket creation does not explicitly select one. `Git-Repo` is an optional Git remote URL. Unknown metadata fields are allowed.

### Ticket documents

Ticket metadata is standard YAML front matter. All standard fields are optional; absence means empty. CLI-created tickets include all fields for convenient manual editing:

```markdown
---
Assigned-To:
Tags: []
Parent:
Blocked-By: []
---
```

- `Assigned-To` is empty or one non-empty string. Human names such as `Pi` and `Eli Oshinsky` are valid and preserved exactly.
- `Tags` is an array of normalized strings.
- `Parent` is empty or one ticket reference.
- `Blocked-By` is an array of ticket references.
- Unknown YAML fields are allowed and preserved semantically.
- The Markdown body is free-form and may be empty.

Malformed YAML and duplicate keys make metadata-dependent commands fail clearly for that ticket. Read-only scans continue with other tickets, and `tickets lint` reports the file and parser error.

When changing metadata, the CLI may rewrite front matter into canonical YAML and discard front-matter comments. It preserves the Markdown content. CLI-written text is UTF-8 without a byte-order mark and uses LF line endings; rewriting may normalize CRLF to LF.
