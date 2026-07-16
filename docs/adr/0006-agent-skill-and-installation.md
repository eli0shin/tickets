---
status: accepted
---

# Bundle one harness-neutral Tickets skill

Tickets bundles one model-invoked Agent Skills-compatible `tickets/SKILL.md`. It teaches predictable use of the product without duplicating the CLI reference or introducing harness integrations.

## Skill contract

The skill is harness-neutral. It contains no Pi-, Claude-, Codex-, or Wayfinder-specific concepts, assets, variants, wrappers, extensions, or environment-variable integration.

Its front matter is:

```yaml
---
name: tickets
description: Manage work in the local Tickets filesystem tracker. Use when the user asks to inspect, search, create, claim, update, move, rename, complete, or lint a Tickets project or ticket.
---
```

The description is intentionally narrow enough not to trigger for Jira, GitHub issues, or generic uses of the word “ticket.”

### Operating guidance

The body establishes these steps and completion criteria without reproducing full command grammar:

1. **Resolve and inspect.** Use the Tickets CLI to discover the selected project and use `list`, `search`, and `show` to inspect work. Consult `tickets --help` or command-specific help when syntax is needed. This step is complete when the exact project and tickets being operated on are known.
2. **Mutate through the narrowest interface.** Use CLI commands for creation, rename, movement, completion, query, and lint. Edit Markdown directly for bodies, assignment, tags, parent, and blockers. Never reimplement an existing CLI operation with ad hoc shell or YAML manipulation. A direct standard-metadata edit is complete only after `tickets lint` passes; body-only edits do not require lint.
3. **Claim before executing ticket work.** Read the ticket and confirm `Assigned-To` is empty; never overwrite another assignee. Use the human or agent name supplied by the user, project, or harness and preserve it exactly; if none is supplied, choose one recognizable name and reuse it throughout that session. Write it directly to `Assigned-To` and lint. Move status only when the user or project conventions identify the work status.
4. **Complete explicitly.** Use `tickets done` only when the ticket's requested work is complete. Completion is reached when the command succeeds and its cleanup finishes.

The skill gives no guidance about unassigning or releasing claims. Stopping and handoff are context-dependent.

The body names only workflow-critical commands. `tickets --help` is the single source of truth for command grammar, and the filesystem/CLI implementation remains the single source of truth for storage rules. The bundle contains only `SKILL.md`; no disclosed reference files are needed.

## Installation contract

```text
tickets skill install [--target <path>] [--force]
```

The binary embeds the exact `SKILL.md` shipped with its version.

- The default target directory is `~/.agents/skills/tickets`.
- `--target` names the exact skill directory, not its parent; installation writes `<target>/SKILL.md`.
- Missing target and parent directories are created.
- If `SKILL.md` does not exist, installation writes it.
- If it exists on an interactive terminal, installation asks whether to overwrite it.
- If it exists without an interactive terminal, installation fails unless `--force` is supplied.
- `--force` replaces `SKILL.md` without prompting.
- Unrelated files in the target directory are preserved. There is no merge or backup behavior.
- Declining the prompt preserves the file and exits successfully.
- A successful write prints only the installed file's absolute path.

The standalone shell installer installs only the Tickets binary. It never installs the skill.
