# accli

Apple Calendar CLI for macOS — manage calendars and events from the command line (via JXA + EventKit).

## Install

```bash
npm i -g @joargp/accli
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

Operational commands emit pretty-printed JSON by default, including errors (to stdout).
Use `--compact` for single-line JSON. `--json` remains accepted as a
backward-compatible no-op.

Use `--human` for the original human-readable output. Human errors are written
to stderr, and interactive setup and `config set-default` selection are only
enabled with this flag. When `--human` is combined with `--compact` or `--json`,
`--human` wins. `--help` and `--version` always use plain text.

## Date ranges

Date-only `--from` and `--to` values are parsed at local midnight. For example,
`--from 2026-02-27 --to 2026-02-28` covers February 27 only. To include all of
February 28 too, use `--to 2026-03-01` or pass an explicit end time.

## Recurring events

All occurrences of a recurring event share one `id`. `events` and `event`
therefore also return an `occurrenceDate` (the occurrence's original start) that
identifies a single occurrence.

`update` and `delete` refuse to act on a recurring event unless you say which
occurrences to change:

```sh
# One occurrence (pass occurrenceDate from `accli events`)
accli delete Work <id> --occurrence-date 2026-09-21T16:00:00

# This occurrence and all later ones
accli update Work <id> --occurrence-date 2026-09-21T16:00:00 --span future --summary "New title"

# The whole series
accli delete Work <id> --span all
```

A date-only `--occurrence-date` matches the occurrence on that day. If no
occurrence matches, the command fails with `OCCURRENCE_NOT_FOUND` instead of
reporting success. IDs ending in `/RID=<seconds>` are also accepted.

## Agent-Ready

Designed for coding agents and automation: structured JSON output on all operational commands, distinct exit codes (0=success, 1=runtime, 2=validation, 10=auth), machine-readable error codes, and persistent calendar IDs for reliable targeting.

## Notes

- macOS only (`darwin`), because it uses `osascript` + EventKit.
- Config path defaults to `~/.acclirc` but can be overridden via `ACCLI_CONFIG_PATH` (or `ACCLI_HOME`).
