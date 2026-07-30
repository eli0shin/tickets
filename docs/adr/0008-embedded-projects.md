---
status: accepted
---

# Support projects embedded beside their work

Tickets supports an Embedded Project stored as `.tickets/` directly beneath the directory whose work it organizes. Automatic selection walks upward from the current directory to the filesystem root and selects the nearest `.tickets/` before attempting Git-origin discovery; explicit `--workspace` or `--project` options still take precedence. The Embedded Project derives its normalized name from its parent directory and retains the ordinary `project.md` and status layout. Once found, `.tickets/` claims the context: a missing or invalid `project.md`, or a parent name that cannot normalize, fails clearly rather than falling back to another project.

`tickets init [--default-status <status>]` creates an Embedded Project in the exact current directory with the same default lifecycle as Workspace Project creation and no repository association. It fails without changing an existing `.tickets/`, does not modify Git configuration or ignore files, and permits a nested Embedded Project to shadow an ancestor.

Embedded ticket references are always unqualified. Qualified references used from an Embedded Project target Workspace Projects in the default Workspace, allowing Embedded Projects to depend on and operate on Workspace tickets without globally registering the Embedded Project. Workspace Projects and other Embedded Projects cannot reference an Embedded Project, and rename or completion cleanup never crosses the store boundary. Embedded lint resolves outbound Workspace references, while Workspace lint never searches for Embedded Projects.

Without explicit workspace selection, `tickets project list` prepends the active Embedded Project to the ordinary Workspace Project results without changing the existing output shape. Explicit workspace selection lists only that Workspace. An absent default Workspace is treated as empty so an Embedded Project remains independently usable; qualified references into that absent Workspace lint as broken.
