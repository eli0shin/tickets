---
status: accepted
---

# Discover projects by normalized Git origin

Commands that need a selected project use an explicit `--project` when supplied. Otherwise they compare the current Git worktree's `origin` with project `Git-Repo` metadata. Discovery is host-agnostic and never guesses from directory names.

## Discovery

1. Resolve the Git worktree containing the current directory.
2. Read that worktree's fetch URL for the `origin` remote. Ignore every other remote.
3. Normalize the origin and every valid project `Git-Repo` value.
4. Select the project when exactly one normalized value matches.

An explicit `--project` bypasses Git inspection entirely.

If the current directory is not in a Git worktree, `origin` is missing or invalid, no project matches, or more than one project matches, the command fails without operating on a project. The diagnostic states the reason and directs the caller to `--project`; an ambiguous match names every matching project.

There is no fallback based on the worktree directory name.

## Project creation

The CLI inspects the worktree containing its current directory before creating a project. When that worktree has a valid `origin` fetch URL, the CLI passes the URL verbatim to the tracker and project creation records it as `Git-Repo`. The tracker rejects creation if another project already declares the same normalized repository location.

A directory outside a Git worktree, a missing `origin`, or an invalid `origin` does not prevent project creation; `Git-Repo` remains empty. Unexpected Git inspection failures abort creation with a diagnostic. Git inspection belongs to the CLI boundary, while duplicate validation and metadata persistence belong to the tracker. Project creation has no Git opt-out flag.

## Remote normalization

`Git-Repo` accepts remote URLs on any host. Normalization recognizes standard URI forms and SCP-style SSH forms:

```text
https://user@example.com/Owner/Repo.git
ssh://git@example.com/Owner/Repo
git@example.com:Owner/Repo.git
```

These all normalize to:

```text
example.com/owner/repo
```

Normalization:

- converts SCP-style SSH syntax to the same host/path model as URI syntax;
- removes scheme and user information;
- lowercases the entire host and repository path;
- removes leading and trailing path separators;
- removes one trailing `.git` suffix;
- removes a scheme's explicit default port and retains any non-default explicit port.

Normalization is transport-aware but has no provider-specific behavior.

## Integrity

At most one project may declare a given normalized repository location. A selected project's lint run reports a duplicate repository association if another project declares the same location. Discovery still fails on ambiguity rather than choosing one project.
