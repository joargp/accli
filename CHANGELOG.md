# Changelog

## 3.0.1

- Fixed JSON output larger than 64 KB being cut off when piped to another program.
- Fixed `events --max` returning an arbitrary set of events instead of the earliest ones.

## 3.0.0

- **Breaking:** `update` and `delete` on a recurring event now require `--occurrence-date` or `--span all`. They used to act on the first occurrence of the series while reporting success.  #6
- Added `--occurrence-date` and `--span this|future|all` to `update` and `delete`, and `--occurrence-date` to `event`.  #6
- Added `occurrenceDate` to `events` and `event` output, and occurrence details to `update` and `delete` output.  #6
- Added the `OCCURRENCE_REQUIRED`, `OCCURRENCE_NOT_FOUND`, and `AMBIGUOUS_OCCURRENCE` error codes.  #6
- Fixed `osascript` being killed on macOS 27 by running generated scripts from a temporary file.  #7
- Reported the terminating signal when `osascript` is killed, instead of `Script exited with code null` or a JSON parse error.  #7
- Fixed temporary script folders not being removed on Node versions before 14.14.

## 2.0.0

- Make JSON the default output for operational commands and errors.
- Add `--human` for human-readable output and interactive behavior.
- Add `--compact` for single-line JSON output.
- Retain `--json` as a backward-compatible no-op.
- Reject unknown, conflicting, and invalid CLI inputs before accessing Calendar.
- Validate dates, ranges, event limits, and calendar indexes strictly.
- Escape terminal control characters in human-readable output while preserving raw JSON.
- Add `INTERNAL_ERROR` for unexpected top-level failures.
