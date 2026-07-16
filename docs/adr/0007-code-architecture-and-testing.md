---
status: accepted
---

# Build a private deep tracker module and test through real filesystems

Tickets supports two product interfaces: the filesystem and the CLI. It does not expose a supported TypeScript library interface. Internally, a deep tracker module concentrates the filesystem contract behind one interface used by commands and tests.

## Module structure

```text
src/
├── cli.ts                    # Commander grammar, dependency composition, top-level failure handling
├── commands/                 # One orchestration module per command family/operation
├── tracker/
│   ├── index.ts              # The tracker module's sole internal interface
│   └── internal/             # Parsing, scanning, canonical writes, references, and lint implementation
├── git.ts                    # Remote normalization and origin-based project discovery
├── skill.ts                  # Bundled skill installation and overwrite confirmation
├── output.ts                 # All stdout/stderr, plain text, JSON, and exit-code rendering
└── types.ts                  # Shared private domain values and structured outcomes
assets/
└── tickets/
    └── SKILL.md              # Single source for the bundled skill
```

The tracker module owns:

- workspace, project, status, and ticket discovery;
- project and ticket front-matter parsing and canonical writing;
- project/status/ticket creation;
- list and structured search;
- rename, move, completion, and workspace-wide reference cleanup;
- project linting.

Its callers provide a workspace root and operation inputs. The tracker creates no default/global workspace internally, which keeps tests isolated and lets `--workspace` remain composition configuration.

The tracker directory may split its implementation into private files for locality, but callers and tests cross only `tracker/index.ts`. Parsing, repositories, relationship graphs, and individual filesystem calls are not separate caller-visible seams. There is no filesystem adapter: production and tests both use the real filesystem.

Git project discovery and skill installation remain separate because they operate at different seams. Git tests use real repositories; skill installation injects only terminal confirmation so interactive and non-interactive behavior can be deterministic.

Command modules translate parsed Commander inputs into tracker operations. They do not parse documents or render output. The CLI entry point composes workspace/project discovery, commands, and output.

## Outcomes and output

Tracker and command operations return structured outcomes. Expected validation, not-found, parse, and filesystem failures are values rather than printed text. Read-only partial scans return their valid data plus diagnostics. Unexpected exceptions are caught only at the CLI entry point.

`output.ts` is the sole writer to stdout and stderr. It renders the contracts in the query/lint and CLI ADRs and assigns exit statuses. This keeps JSON and composable plain-text stdout free of diagnostics and status prose.

The implementation uses the `yaml` package's document parser/stringifier so duplicate keys and parser diagnostics are available while unknown fields can be retained semantically. Markdown needs no parser; front matter is delimited and the remaining bytes are treated as body content.

## Testing

Follow `../repos` conventions with Bun's test runner, strict TypeScript, and exact whole-value assertions.

### Tracker integration tests

Create a fresh real temporary workspace for every test. Build files and directories directly to cover both CLI-created and manually edited state. Exercise all tracker behavior through `tracker/index.ts`; do not mock filesystem calls or test private parser functions independently.

The suite covers every accepted contract branch, including:

- valid, empty, hidden, unexpected, malformed, duplicate-ID, and cross-project layouts;
- optional and unknown fields, malformed YAML, duplicate YAML keys, and canonical rewrites;
- local and cross-project references, rename rewrites, move/completion cleanup, idempotence, and visible partial failure;
- list/search criteria, ordering, partial scans, lint findings, and stable diagnostic codes;
- required project metadata and default-status behavior.

### Git integration tests

Use real temporary Git repositories and `git remote` commands. Cover URI and SCP-style origins, normalization, case, default and non-default ports, missing worktrees/origins/matches, explicit project overrides, and ambiguous metadata. Do not mock Git subprocesses.

### CLI integration tests

Spawn `bun src/cli.ts` in isolated temporary directories and assert complete stdout, stderr, and exit status for every command and output mode. Include malformed partial-result cases and interactive skill installation through an injected confirmation seam. A packaging smoke test builds the native executable and verifies `--version`, `--help`, and embedded-skill installation from the compiled binary.

Tests may use flexible matchers only for genuinely variable values such as temporary absolute paths. Assertions otherwise compare complete values or output.

## Development and quality

Copy the `../repos` toolchain and configuration closely:

- Bun, ESM, strict TypeScript, and explicit `.ts` imports;
- Commander with `@commander-js/extra-typings`;
- ESLint with `eslint-for-ai`;
- Prettier, Husky, lint-staged, and Changesets;
- scripts for `dev`, `build`, `typecheck`, `lint`, `lint:fix`, `format`, `format:fix`, `test`, and `test:watch`;
- CI gates for formatting, lint, typecheck, build, and tests.

The package remains private while Changesets versions and tags it. Source or bundled-asset changes require a changeset.

## Binary, asset, release, and installer

Bun's text import embeds `assets/tickets/SKILL.md` into the compiled executable; runtime installation never depends on source files beside the binary. Tests verify that installed bytes equal the source asset.

Local `bun run build` produces `tickets`. Releases compile and upload:

```text
tickets-linux-x64
tickets-linux-arm64
tickets-darwin-x64
tickets-darwin-arm64
```

The Changesets release workflow follows `../repos`, adapted to the `eli0shin/tickets` repository and artifact names. The shell installer detects OS and architecture, downloads the matching latest-release artifact to `~/.local/bin/tickets`, marks it executable, and reports PATH guidance. It installs no skill or other files; `tickets skill install` is the only skill installer.
