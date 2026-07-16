# Tickets

Tickets is a personal, local filesystem tracker for organizing planned work across projects.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/eli0shin/tickets/main/install.sh | bash
```

The installer supports x64 and arm64 Linux and macOS systems. It installs only the
`tickets` binary to `~/.local/bin`; run `tickets skill install` separately to install
the bundled agent skill.

## Commands

Run `tickets --help` for the complete command grammar.

| Command                                                              | Description                                 |
| -------------------------------------------------------------------- | ------------------------------------------- |
| `tickets project ...`                                                | Create and list projects                    |
| `tickets status ...`                                                 | Create and list statuses                    |
| `tickets create`, `show`, `list`, `search`, `rename`, `move`, `done` | Manage tickets                              |
| `tickets lint`                                                       | Validate the selected project               |
| `tickets skill install`                                              | Install the bundled agent skill             |
| `tickets update`                                                     | Update Tickets to the latest native release |

`tickets update` prints the current version, checks the latest GitHub release, and replaces the running executable when a newer release is available. It supports Linux and macOS on x64 and arm64.

Tickets also checks for updates in a detached background worker. By default it silently installs an available stable release at most once every 24 hours. Configure this in `~/.config/tickets/config.json` (or `$XDG_CONFIG_HOME/tickets/config.json`):

```json
{
  "config": {
    "updateBehavior": "notify",
    "updateCheckIntervalHours": 12
  }
}
```

`updateBehavior` can be `auto` (silently install), `notify` (print an availability message after commands), or `off` (disable checks). The interval defaults to 24 hours. Update check state is stored in `$XDG_STATE_HOME/tickets-update-state` when set, otherwise `~/.tickets-update-state`.

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
