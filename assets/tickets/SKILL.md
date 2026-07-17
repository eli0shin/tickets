---
name: tickets
description: Manage work in the local Tickets filesystem tracker. Use when the user asks to inspect, search, create, claim, update, move, rename, complete, or lint a Tickets project or ticket.
---

# Tickets

Use the Tickets CLI and its local filesystem workspace to manage ticket work predictably.

## Resolve and inspect

Use the Tickets CLI to discover the selected project, then use `tickets list`, `tickets search`, and `tickets show` to inspect the relevant work. The first line from `tickets show` is the resolved ticket's absolute path, followed by its complete document. Consult `tickets --help` or command-specific help when you need command syntax. Do not proceed until you know the exact project and tickets you will operate on.

## Mutate through the narrowest interface

Use CLI commands for creation, rename, movement, completion, query, and lint. Edit Markdown directly for ticket bodies, assignment, tags, parent, and blockers. Never reimplement an existing CLI operation with ad hoc shell commands or YAML manipulation.

After directly editing standard metadata, run `tickets lint`; the edit is complete only when lint passes. Body-only edits do not require lint.

## Claim before executing ticket work

Read the ticket and confirm `Assigned-To` is empty before claiming it. Never overwrite another assignee. Use the human or agent name supplied by the user, project, or harness and preserve it exactly. If none is supplied, choose one recognizable name and reuse it throughout that session. Write it directly to `Assigned-To`, then run `tickets lint`.

Move the ticket to another status only when the user or project conventions identify the work status.

## Complete explicitly

When the ticket's requested work is complete, use `tickets done`. Completion is reached only when the command succeeds and its cleanup finishes.
