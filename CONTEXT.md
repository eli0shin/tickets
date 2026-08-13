# Tickets

Tickets is a personal, local system for organizing planned work across projects using a Kanban-style lifecycle.

## Language

**Workspace**:
The centrally managed collection of the user's Workspace Projects. It does not include Embedded Projects.
_Avoid_: Global state, store

**Project**:
A named scope containing related tickets and a project-defined set of statuses.
_Avoid_: Board, repository

**Workspace Project**:
A Project belonging to the user's central Workspace.
_Avoid_: Global project, central project

**Embedded Project**:
A self-contained Project colocated with the work it organizes rather than belonging to the Workspace.
_Avoid_: Local project

**Repository association**:
An optional relationship between a project and a Git repository, identified by the repository's `origin` fetch remote. A project created outside a Git worktree, without `origin`, or with an unsupported remote has no repository association.
_Avoid_: Current remote, project repository

**Ticket**:
A self-contained record of a unit of planned work within one project. Its project-unique name begins with a ticket ID and includes a human-readable description, such as `001-add-blocking`.
_Avoid_: Issue, card, task

**Ticket ID**:
The project-unique positive decimal prefix of a ticket name.
_Avoid_: Ticket number

**Ticket reference**:
A ticket name when referring within its project, or a Workspace Project name followed by a ticket name when referring across projects. Tickets in an Embedded Project are always referenced without a project prefix.
_Avoid_: File path, opaque ID

**Status**:
A project-defined lifecycle stage that groups tickets currently in that stage. Each project may have any unordered set of statuses; `done` is the conventional completed status recognized by the system.
_Avoid_: Column

**Default status**:
The project-designated status used for newly created tickets when no status is explicitly selected.
_Avoid_: Initial status, starting status

**Assignee**:
The human or agent assigned to a ticket. For active work, assignment is an exclusive claim; completed tickets retain the assignee as part of their record. Assignee names are free-form, non-empty strings preserved exactly and need not come from a registry.
_Avoid_: Owner

**Tag**:
A normalized label attached to a ticket for classification and search. Tags need not be declared in advance.
_Avoid_: Label, category

**Parent**:
The optional ticket under which another ticket is grouped. A ticket has at most one direct parent.
_Avoid_: Epic

**Blocker**:
A ticket currently identified by another ticket as standing in its way. Once it no longer prevents progress, its reference is removed.
_Avoid_: Dependency

**Blocked ticket**:
A non-completed ticket with at least one current blocker. Blocking is not itself a status.

**Unblocked ticket**:
A non-completed ticket with no current blockers. A completed ticket is neither blocked nor unblocked.
