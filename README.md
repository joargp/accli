# accli

Apple Calendar CLI for macOS — manage calendars and events from the command line (via JXA + EventKit).

## Install

```bash
npm i -g @joargp/accli@beta
```

## Quick start

```bash
accli setup
accli calendars
accli events --calendar-name "Work" --from 2025-01-01 --to 2025-01-31
```

## Permissions (macOS)

On first run, you may need to grant Calendar access.

1. Run `accli setup`
2. In **System Settings → Privacy & Security → Calendars**, ensure the responsible app (often `osascript` and/or your terminal) has **Full Access** (not “Add Only”).

## Commands

- `setup` — trigger macOS Calendar permission prompt
- `calendars` — list calendars
- `events` — list events in a range
- `event` — fetch a single event by ID
- `create` — create an event
- `update` — update an event
- `delete` — delete an event
- `freebusy` — show busy time slots
- `config` — set/show/clear default calendar

Run `accli <command> --help` for command-specific options.

## JSON output

Add `--json` to most commands to output JSON (including errors).

## Notes

- macOS only (`darwin`), because it uses `osascript` + EventKit.
- Config path defaults to `~/.acclirc` but can be overridden via `ACCLI_CONFIG_PATH` (or `ACCLI_HOME`).
