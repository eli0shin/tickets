---
status: accepted
---

# Keep listing narrow and search structured

Tickets provides a narrow status listing, a project-wide structured search, and a read-only project linter. This avoids turning listing into an implicit broad query while retaining the searches needed by humans and agents. The filesystem remains directly usable for free-text and ad hoc queries.

## Query contract

### Listing

A listing targets exactly one explicitly selected status and returns every ticket in that status. `done` behaves like any other status. A listing cannot span multiple statuses and has no filtering behavior.

### Search

Search spans one selected project. With no criteria, it returns every ticket in the project. It supports these exact, structured criteria:

- status;
- tag;
- assignee, including unassigned;
- parent;
- blocker, including unblocked.

Every supplied criterion must match. Repeated status criteria search the union of those statuses; all other repeated criteria use AND semantics. Search is not free-text search and has no generic filtering language.

There is no separate relationship-traversal operation. Direct parent and blocker references are read from a ticket; reverse relationships are found by searching on parent or blocker.

### Ordering and output

List and search results are ordered by ascending ticket ID, with the full ticket name as a deterministic tie-breaker if manually edited files contain duplicate IDs.

Plain text emits one headerless, tab-separated record per ticket:

```text
<status>\t<ticket-name>\t<absolute-path>
```

JSON uses a stable top-level object:

```json
{
  "project": "tickets",
  "tickets": [
    {
      "name": "004-design-query-and-lint-behavior",
      "status": "done",
      "path": "/absolute/path/to/ticket.md",
      "assignedTo": null,
      "tags": ["wayfinder", "grilling"],
      "parent": "001-specify-the-local-ticket-tracker",
      "blockedBy": []
    }
  ]
}
```

Query output excludes Markdown bodies and unknown front-matter fields.

Read-only scans follow the filesystem data contract: malformed tickets do not suppress valid results from other tickets. Each malformed ticket is reported on stderr and the command exits nonzero, making the partial nature of stdout visible. JSON stdout keeps its normal schema.

## Lint contract

Lint validates exactly one selected project without modifying it. It may inspect other projects to resolve outbound references, but it reports findings only for the selected project.

Lint reports violations of the filesystem and reference contracts, including unexpected non-hidden entries, invalid project metadata, invalid ticket metadata, duplicate ticket IDs, duplicate repository associations, and broken references. It does not introduce advisory graph rules: self-references, duplicate references, parent cycles, and blocking cycles remain permitted and are not detected.

Each finding contains:

- `path`: the absolute path associated with the violation;
- `code`: a stable machine-readable violation code;
- `message`: a human-readable explanation.

Codes and finding field shapes are compatibility-stable. Messages are deterministic and tested but are not a versioned compatibility interface. Lint uses only these codes, each corresponding to a violation already defined by the filesystem, reference, or Git-discovery contract:

| Code | Contract violation |
| --- | --- |
| `unexpected-project-entry` | A non-hidden immediate project entry is neither `project.md` nor a discoverable status directory. |
| `unexpected-status-entry` | A non-hidden immediate status entry is not a discoverable ticket file. |
| `missing-project-metadata` | The selected project has no `project.md`. |
| `malformed-project-yaml` | Project front matter is missing or cannot be parsed as YAML. |
| `duplicate-project-key` | Project front matter contains a duplicate YAML key. |
| `missing-default-status` | `Default-Status` is absent. |
| `invalid-default-status` | `Default-Status` is not one normalized status name. |
| `missing-default-status-directory` | The status named by `Default-Status` does not exist. |
| `invalid-git-repo` | A non-empty `Git-Repo` cannot be normalized as a supported URI or SCP-style remote. |
| `malformed-ticket-yaml` | Ticket front matter is missing or cannot be parsed as YAML. |
| `duplicate-ticket-key` | Ticket front matter contains a duplicate YAML key. |
| `invalid-assigned-to` | `Assigned-To` is neither empty nor one normalized assignee. |
| `invalid-tags` | `Tags` is not an array of normalized tags. |
| `invalid-parent` | `Parent` is neither empty nor one syntactically valid ticket reference. |
| `invalid-blocked-by` | `Blocked-By` is not an array of syntactically valid ticket references. |
| `duplicate-ticket-id` | More than one discovered ticket in the project has the same numeric ID. |
| `broken-parent-reference` | A syntactically valid `Parent` reference does not resolve to exactly one ticket. |
| `broken-blocker-reference` | A syntactically valid `Blocked-By` entry does not resolve to exactly one ticket. |
| `duplicate-git-repo` | Another project declares the same normalized repository location as the selected project. |

This catalog does not authorize additional validation. In particular, lint still does not report symlinks, duplicate relationship entries, self-references, or relationship cycles.

Findings are sorted by absolute path, then code, then message. Plain text emits one headerless, tab-separated `<path>\t<code>\t<message>` record per finding. A clean run emits no plain text.

JSON always uses this shape, with finding objects added to `violations` when present:

```json
{
  "project": "tickets",
  "violations": []
}
```

Lint exits `0` when clean and `1` when contract violations are found. Invocation errors and unexpected operational failures use a different nonzero status.
