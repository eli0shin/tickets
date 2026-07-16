# Tickets

Tickets is a personal, local filesystem tracker for organizing planned work across projects.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/eli0shin/tickets/main/install.sh | bash
```

The installer supports x64 and arm64 Linux and macOS systems. It installs only the
`tickets` binary to `~/.local/bin`; run `tickets skill install` separately to install
the bundled agent skill.

## Development

```bash
bun install
bun run dev -- --help
bun run build
bun run format
bun run lint
bun run typecheck
bun run test
```
