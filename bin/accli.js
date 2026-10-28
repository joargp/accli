#!/usr/bin/env node
'use strict';

const { runScript, ERROR_CODES, EXIT_VALIDATION_ERROR } = require('../lib/jxa-runner');
const output = require('../lib/output');
const config = require('../lib/config');
const { parseLocalDateTime, isNonNegativeInteger, parseEventLimit, validateOrderedRange, validateUpdateRange } = require('../lib/validation');
const { spawnSync } = require('child_process');
const readline = require('readline');

// On macOS, writes to a pipe are asynchronous, so the process.exit() calls
// below would truncate output larger than the pipe buffer (64 KB). Make
// stdout/stderr blocking so every write completes before exit.
for (const stream of [process.stdout, process.stderr]) {
  if (stream._handle && typeof stream._handle.setBlocking === 'function') {
    stream._handle.setBlocking(true);
  }
}

const GLOBAL_BOOLEAN_FLAGS = ['help', 'version', 'human', 'compact', 'json'];
const VALUE_FLAGS = new Set([
  'calendar', 'calendar-id', 'calendar-index', 'calendar-name',
  'from', 'to', 'max', 'query', 'summary', 'start', 'end', 'location', 'description',
  'occurrence-date', 'span',
]);
const SPANS = ['this', 'future', 'all'];

// Keep the accepted CLI surface next to parsing/dispatch so handlers never
// silently ignore a typo or surplus input. Calendar selectors are deliberately
// repeatable only for freebusy.
const COMMAND_CONTRACTS = {
  setup: { booleanFlags: [], scalarFlags: [], repeatableFlags: [], minPositionals: 0, maxPositionals: 0 },
  calendars: { booleanFlags: [], scalarFlags: [], repeatableFlags: [], minPositionals: 0, maxPositionals: 0 },
  events: {
    booleanFlags: [],
    scalarFlags: ['calendar-name', 'from', 'to', 'max', 'query'],
    repeatableFlags: ['calendar-id', 'calendar-index'],
    minPositionals: 0,
    maxPositionals: 1,
    calendarSelector: 'leading',
  },
  event: {
    booleanFlags: [],
    scalarFlags: ['calendar-name', 'occurrence-date'],
    repeatableFlags: ['calendar-id', 'calendar-index'],
    minPositionals: 0,
    maxPositionals: 2,
    calendarSelector: 'event-target',
  },
  create: {
    booleanFlags: ['all-day'],
    scalarFlags: ['calendar-name', 'summary', 'start', 'end', 'location', 'description'],
    repeatableFlags: ['calendar-id', 'calendar-index'],
    minPositionals: 0,
    maxPositionals: 1,
    calendarSelector: 'leading',
  },
  update: {
    booleanFlags: ['all-day', 'no-all-day'],
    scalarFlags: ['calendar-name', 'occurrence-date', 'span', 'summary', 'start', 'end', 'location', 'description'],
    repeatableFlags: ['calendar-id', 'calendar-index'],
    minPositionals: 0,
    maxPositionals: 2,
    calendarSelector: 'event-target',
  },
  delete: {
    booleanFlags: [],
    scalarFlags: ['calendar-name', 'occurrence-date', 'span'],
    repeatableFlags: ['calendar-id', 'calendar-index'],
    minPositionals: 0,
    maxPositionals: 2,
    calendarSelector: 'event-target',
  },
  freebusy: {
    booleanFlags: [],
    scalarFlags: ['from', 'to'],
    repeatableFlags: ['calendar', 'calendar-id', 'calendar-index'],
    minPositionals: 0,
    maxPositionals: 0,
  },
  config: {
    booleanFlags: [],
    scalarFlags: [],
    repeatableFlags: ['calendar', 'calendar-id'],
    minPositionals: 0,
    maxPositionals: 1,
  },
};

// Parse command line arguments
// Returns { ok: true, result: {...} } or { ok: false, error: {...} }
function parseArgs(args) {
  const result = {
    command: null,
    positional: [],
    flags: {},
    arrays: {},
    flagCounts: {},
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg.startsWith('--')) {
      const key = arg.slice(2);

      // Handle boolean flags
      if (key === 'json' || key === 'human' || key === 'compact' || key === 'help' || key === 'version' || key === 'all-day' || key === 'no-all-day') {
        result.flags[key] = true;
        i++;
        continue;
      }

      // Handle array flags (--calendar, --calendar-id, --calendar-index can be repeated)
      if (key === 'calendar' || key === 'calendar-id' || key === 'calendar-index') {
        const value = args[i + 1];
        if (value === undefined || value.startsWith('--')) {
          return {
            ok: false,
            error: { code: ERROR_CODES.MISSING_REQUIRED, message: `--${key} requires a value` },
          };
        }
        if (!result.arrays[key]) {
          result.arrays[key] = [];
        }
        result.arrays[key].push(value);
        i += 2;
        continue;
      }

      // An unknown valueless flag must reach command-contract validation as
      // unknown, rather than being misreported as a missing known value.
      if (!VALUE_FLAGS.has(key) && (args[i + 1] === undefined || args[i + 1].startsWith('--'))) {
        result.flags[key] = true;
        result.flagCounts[key] = (result.flagCounts[key] || 0) + 1;
        i++;
        continue;
      }

      // Handle key-value flags
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        return {
          ok: false,
          error: { code: ERROR_CODES.MISSING_REQUIRED, message: `--${key} requires a value` },
        };
      }
      result.flags[key] = value;
      result.flagCounts[key] = (result.flagCounts[key] || 0) + 1;
      i += 2;
    } else if (!result.command) {
      result.command = arg;
      i++;
    } else {
      result.positional.push(arg);
      i++;
    }
  }

  return { ok: true, result };
}

function invalidArgument(message) {
  return { code: ERROR_CODES.INVALID_ARGUMENT, message };
}

function validateCommandContract(args) {
  const contract = COMMAND_CONTRACTS[args.command];
  if (!contract) return null;

  const allowedBooleanFlags = new Set([...GLOBAL_BOOLEAN_FLAGS, ...contract.booleanFlags]);
  const allowedScalarFlags = new Set(contract.scalarFlags);
  const allowedRepeatableFlags = new Set(contract.repeatableFlags);

  for (const key of Object.keys(args.flags)) {
    if (!allowedBooleanFlags.has(key) && !allowedScalarFlags.has(key)) {
      return invalidArgument(`Unknown flag: --${key}`);
    }
  }
  for (const key of Object.keys(args.arrays)) {
    if (!allowedRepeatableFlags.has(key)) {
      return invalidArgument(`Unknown flag: --${key}`);
    }
  }

  for (const key of contract.scalarFlags) {
    if ((args.flagCounts[key] || 0) > 1) {
      return invalidArgument(`Flag may only be specified once: --${key}`);
    }
  }

  if (args.positional.length < contract.minPositionals || args.positional.length > contract.maxPositionals) {
    return invalidArgument(`Expected ${contract.minPositionals === contract.maxPositionals ? contract.maxPositionals : `${contract.minPositionals}-${contract.maxPositionals}`} positional argument(s) for ${args.command}`);
  }

  if (args.flags['all-day'] && args.flags['no-all-day']) {
    return invalidArgument('Use either --all-day or --no-all-day, not both');
  }

  if (hasFlag(args, 'occurrence-date') && !parseLocalDateTime(args.flags['occurrence-date']).ok) {
    return { code: ERROR_CODES.INVALID_DATETIME, message: `Invalid --occurrence-date: ${args.flags['occurrence-date']}` };
  }
  if (hasFlag(args, 'span')) {
    if (!SPANS.includes(args.flags.span)) {
      return invalidArgument(`Invalid --span: ${args.flags.span} (expected one of: ${SPANS.join(', ')})`);
    }
    if (args.flags.span === 'all' && hasFlag(args, 'occurrence-date')) {
      return invalidArgument('--span all applies to the whole series; do not combine it with --occurrence-date');
    }
  }

  const calendarName = args.flags['calendar-name'];
  const calendarIds = args.arrays['calendar-id'] || [];
  const calendarIndexes = args.arrays['calendar-index'] || [];
  for (const index of calendarIndexes) {
    if (!isNonNegativeInteger(index)) {
      return invalidArgument(`Invalid --calendar-index: ${index}`);
    }
  }
  if (contract.calendarSelector) {
    if (calendarIds.length > 1) {
      return invalidArgument('Only one --calendar-id is allowed for this command');
    }
    if (calendarIndexes.length > 1) {
      return invalidArgument('Only one --calendar-index is allowed for this command');
    }
    if (calendarName && (calendarIds.length || calendarIndexes.length)) {
      return invalidArgument('Use only one calendar selector: --calendar-name, --calendar-id, or --calendar-index');
    }
    if (calendarIds.length && calendarIndexes.length) {
      return invalidArgument('Use either --calendar-id or --calendar-index, not both');
    }
    const hasFlagSelector = !!calendarName || calendarIds.length > 0 || calendarIndexes.length > 0;
    const hasPositionalCalendar = contract.calendarSelector === 'leading'
      ? args.positional.length > 0
      : args.positional.length === 2;
    if (hasPositionalCalendar && hasFlagSelector) {
      return invalidArgument('Specify a calendar either positionally or with a calendar selector flag, not both');
    }
  }

  if (args.command === 'config') {
    const action = args.positional[0];
    const calendars = args.arrays.calendar || [];
    if (action === 'set-default') {
      if (calendars.length > 1 || calendarIds.length > 1) {
        return invalidArgument('Only one --calendar or --calendar-id is allowed for config set-default');
      }
      if (calendars.length && calendarIds.length) {
        return invalidArgument('Use either --calendar or --calendar-id for config set-default, not both');
      }
    } else if ((action === 'show' || action === 'clear') && (calendars.length || calendarIds.length)) {
      return invalidArgument(`config ${action} does not accept calendar selectors`);
    }
  }

  return null;
}

function outputOptions(args) {
  return { human: !!args.flags.human, compact: !!args.flags.compact };
}

function hasFlag(args, key) {
  return Object.prototype.hasOwnProperty.call(args.flags, key);
}

// Show help
function showHelp(command = null, { stderr = false } = {}) {
  const globalHelp = `
accli - Apple Calendar CLI for macOS

USAGE:
  accli <command> [options]

COMMANDS:
  setup        Trigger macOS Calendars permission
  calendars    List all calendars
  events       List events from a calendar
  event        Get a single event by ID
  create       Create a new event
  update       Update an existing event
  delete       Delete an event
  freebusy     Get busy time slots
  config       Manage configuration (default calendar)

GLOBAL OPTIONS:
  --human      Output human-readable text and enable interactive prompts
  --compact    Output JSON on a single line (ignored with --human)
  --json       Backward-compatible no-op; JSON is the default
  --help       Show help information
  --version    Print version

DATETIME FORMATS:
  Timed events: YYYY-MM-DDTHH:mm or YYYY-MM-DDTHH:mm:ss
  All-day:      YYYY-MM-DD

EXAMPLES:
  accli setup
  accli calendars
  accli calendars --human
  accli events Work --from 2025-01-01 --to 2025-01-31
  accli create Work --summary "Meeting" --start 2025-01-15T14:00 --end 2025-01-15T15:00
`;

  const commandHelp = {
    setup: `
accli setup - Trigger macOS Calendar permission

USAGE:
  accli setup [--human] [--compact] [--json]

OPTIONS:
  --human      Output human-readable text and enable interactive prompts
  --compact    Output single-line JSON (ignored with --human)
  --json       Backward-compatible no-op

DESCRIPTION:
  Triggers the macOS Calendars permission prompt by accessing calendar data via EventKit.
  Run this first if you see "NOT_AUTHORIZED" errors.
  Note: On recent macOS versions the Calendars permission may be set to "Add Only" by default; accli needs "Full Access".
  In System Settings > Privacy & Security > Calendars, click "Options…" next to the app (often "osascript") and select "Full Access".

EXAMPLES:
  accli setup
  accli setup --human
`,
    calendars: `
accli calendars - List all calendars

USAGE:
  accli calendars [--human] [--compact] [--json]

OPTIONS:
  --human      Output human-readable text
  --compact    Output single-line JSON (ignored with --human)
  --json       Backward-compatible no-op

DESCRIPTION:
  Lists all calendars with their names and persistent IDs.

EXAMPLES:
  accli calendars
  accli calendars --human
`,
    events: `
accli events - List events from a calendar

USAGE:
  accli events <calendarName> [options]

OPTIONS:
  --calendar-id <id>        Persistent calendar ID (recommended)
  --calendar-index <index>  Unstable calendar index (deprecated)
  --calendar-name <name>    Calendar name (exact match)
  --from <datetime>    Start of range (default: now)
  --to <datetime>      End of range (default: from + 7 days)
  --max <n>            Maximum events to return (default: 50)
  --query <q>          Case-insensitive filter on summary/location/description
  --human              Output human-readable text
  --compact            Output single-line JSON (ignored with --human)
  --json               Backward-compatible no-op

DATE RANGES:
  Date-only values are parsed at local midnight. For example,
  --from 2026-02-27 --to 2026-02-28 covers Feb 27 only.

EXAMPLES:
  accli events Work
  accli events --calendar-id "ABC123-DEF456-..." --from 2025-01-01 --to 2025-01-31
  accli events Work --query "standup" --max 10
`,
    event: `
accli event - Get a single event by ID

USAGE:
  accli event <calendarName> <eventId> [options]

OPTIONS:
  --calendar-id <id>        Persistent calendar ID (recommended)
  --calendar-index <index>  Unstable calendar index (deprecated)
  --calendar-name <name>    Calendar name (exact match)
  --occurrence-date <dt>    Pick one occurrence of a recurring event (the
                            occurrenceDate field from \`accli events\`)
  --human              Output human-readable text
  --compact            Output single-line JSON (ignored with --human)
  --json               Backward-compatible no-op

EXAMPLES:
  accli event Work event-id-123
  accli event Work event-id-123 --occurrence-date 2026-09-21T16:00:00
  accli event --calendar-id "ABC123" event-id-123 --human
`,
    create: `
accli create - Create a new event

USAGE:
  accli create <calendarName> --summary <s> --start <datetime> --end <datetime> [options]

OPTIONS:
  --calendar-id <id>        Persistent calendar ID (recommended)
  --calendar-index <index>  Unstable calendar index (deprecated)
  --calendar-name <name>    Calendar name (exact match)
  --summary <s>        Event title (required)
  --start <datetime>   Start time (required)
  --end <datetime>     End time (required)
  --location <l>       Event location
  --description <d>    Event description
  --all-day            Create an all-day event
  --human              Output human-readable text
  --compact            Output single-line JSON (ignored with --human)
  --json               Backward-compatible no-op

EXAMPLES:
  accli create Work --summary "Meeting" --start 2025-01-15T14:00 --end 2025-01-15T15:00
  accli create Personal --summary "Holiday" --start 2025-12-25 --end 2025-12-25 --all-day
`,
    update: `
accli update - Update an existing event

USAGE:
  accli update <calendarName> <eventId> [options]

OPTIONS:
  --calendar-id <id>        Persistent calendar ID (recommended)
  --calendar-index <index>  Unstable calendar index (deprecated)
  --calendar-name <name>    Calendar name (exact match)
  --occurrence-date <dt>    Occurrence of a recurring event to update
  --span <this|future|all>  Recurring scope (default: this)
  --summary <s>        New event title
  --start <datetime>   New start time
  --end <datetime>     New end time
  --location <l>       New location
  --description <d>    New description
  --all-day            Convert to all-day event
  --no-all-day         Convert to timed event
  --human              Output human-readable text
  --compact            Output single-line JSON (ignored with --human)
  --json               Backward-compatible no-op

RECURRING EVENTS:
  Every occurrence of a recurring event shares the same ID, so recurring
  events require --occurrence-date (the occurrenceDate field from
  \`accli events\`) or --span all. A date-only value matches the
  occurrence on that day.

EXAMPLES:
  accli update Work event-id-123 --summary "Updated meeting"
  accli update Work event-id-123 --start 2025-01-15T15:00 --end 2025-01-15T16:00
  accli update Work event-id-123 --occurrence-date 2025-01-20T14:00:00 --summary "Moved"
`,
    delete: `
accli delete - Delete an event

USAGE:
  accli delete <calendarName> <eventId> [options]

OPTIONS:
  --calendar-id <id>        Persistent calendar ID (recommended)
  --calendar-index <index>  Unstable calendar index (deprecated)
  --calendar-name <name>    Calendar name (exact match)
  --occurrence-date <dt>    Occurrence of a recurring event to delete
  --span <this|future|all>  Recurring scope (default: this)
  --human              Output human-readable text
  --compact            Output single-line JSON (ignored with --human)
  --json               Backward-compatible no-op

RECURRING EVENTS:
  Every occurrence of a recurring event shares the same ID, so recurring
  events require --occurrence-date (the occurrenceDate field from
  \`accli events\`) or --span all. A date-only value matches the
  occurrence on that day.

EXAMPLES:
  accli delete Work event-id-123
  accli delete --calendar-id "ABC123" event-id-123
  accli delete Work event-id-123 --occurrence-date 2025-01-20T14:00:00
  accli delete Work event-id-123 --occurrence-date 2025-01-20T14:00:00 --span future
  accli delete Work event-id-123 --span all
`,
    freebusy: `
accli freebusy - Get busy time slots

USAGE:
  accli freebusy --calendar <name> --from <datetime> --to <datetime> [options]

OPTIONS:
  --calendar <name>    Calendar name (can be repeated)
  --calendar-id <id>        Persistent calendar ID (can be repeated)
  --calendar-index <index>  Unstable calendar index (can be repeated)
  --from <datetime>    Start of range (required)
  --to <datetime>      End of range (required)
  --human              Output human-readable text
  --compact            Output single-line JSON (ignored with --human)
  --json               Backward-compatible no-op

DESCRIPTION:
  Shows busy time slots across one or more calendars.
  Excludes cancelled, declined, and "free/transparent" events.

EXAMPLES:
  accli freebusy --calendar Work --calendar Personal --from 2025-01-15 --to 2025-01-16
  accli freebusy --calendar-id "ABC123-DEF456-..." --from 2025-01-15T09:00 --to 2025-01-15T18:00
`,
    config: `
accli config - Manage configuration

USAGE:
  accli config <action> [options]

ACTIONS:
  set-default    Set the default calendar
  show           Show current configuration
  clear          Clear the default calendar setting

OPTIONS (for set-default):
  --calendar <name>         Calendar name (non-interactive)
  --calendar-id <id>        Persistent calendar ID (non-interactive)
  --human                   Output human-readable text and enable interactive selection
  --compact                 Output single-line JSON (ignored with --human)
  --json                    Backward-compatible no-op

DESCRIPTION:
  Manages accli configuration stored in ~/.acclirc.
  When a default calendar is set, commands like events, create, update, delete
  will use it automatically if no calendar is specified.

EXAMPLES:
  accli config set-default --human                   # Interactive selection
  accli config set-default --calendar Work           # Set by name
  accli config set-default --calendar-id "ABC123..." # Set by ID
  accli config show
  accli config clear
`,
  };

  const message = command && commandHelp[command] ? commandHelp[command] : globalHelp;
  (stderr ? console.error : console.log)(message.trim());
}

function promptYesNo(question) {
  if (!process.stdin.isTTY) return Promise.resolve(false);

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const normalized = String(answer || '').trim().toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}

function openCalendarsPrivacySettings() {
  const url = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars';
  spawnSync('open', [url], { stdio: 'ignore' });
}

// Main command handlers
async function handleSetup(args) {
  const result = await runScript('setup', {});

  if (result.success) {
    output.output(result.data, {
      ...outputOptions(args),
      formatter: output.formatSetup,
    });
  } else {
    output.outputError(result.error, outputOptions(args));

    if (args.flags.human && result.error && result.error.code === ERROR_CODES.NOT_AUTHORIZED) {
      const shouldOpen = await promptYesNo(
        'Open System Settings > Privacy & Security > Calendars now? (Then click Options… and set Full Access, often for "osascript".) [y/N] '
      );
      if (shouldOpen) openCalendarsPrivacySettings();
    }
  }

  process.exit(result.exitCode);
}

async function handleCalendars(args) {
  const result = await runScript('calendars', {});

  if (result.success) {
    output.output(result.data, {
      ...outputOptions(args),
      formatter: output.formatCalendars,
    });
  } else {
    output.outputError(result.error, outputOptions(args));
  }

  process.exit(result.exitCode);
}

async function handleEvents(args) {
  const calendarNamePositional = args.positional[0];
  const calendarNameFlag = args.flags['calendar-name'];
  const calendarIds = args.arrays['calendar-id'] || [];
  const calendarIndexes = args.arrays['calendar-index'] || [];

  if (calendarNamePositional && calendarNameFlag) {
    output.outputError(
      { code: ERROR_CODES.INVALID_ARGUMENT, message: 'Specify calendar as positional <calendarName> or via --calendar-name, not both' },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }

  if (calendarIndexes.length > 1) {
    output.outputError(
      { code: ERROR_CODES.INVALID_ARGUMENT, message: 'Only one --calendar-index is allowed for this command' },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }

  if (calendarIds.length > 1) {
    output.outputError(
      { code: ERROR_CODES.INVALID_ARGUMENT, message: 'Only one --calendar-id is allowed for this command' },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }

  const calendarIndex = calendarIndexes.length === 1 ? calendarIndexes[0] : null;
  const calendarId = calendarIds.length === 1 ? calendarIds[0] : null;
  const calendarName = calendarNameFlag || calendarNamePositional || null;

  let resolvedCalendarId = calendarId || null;
  let resolvedCalendarIndex = calendarIndex;

  if (resolvedCalendarId && resolvedCalendarIndex) {
    output.outputError(
      { code: ERROR_CODES.INVALID_ARGUMENT, message: 'Use either --calendar-id or --calendar-index, not both' },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }

  // Backward compatibility: numeric --calendar-id used to be an index
  if (resolvedCalendarId && /^\d+$/.test(resolvedCalendarId) && !resolvedCalendarIndex) {
    if (args.flags.human) {
      console.error('Warning: numeric --calendar-id is deprecated; use --calendar-index or a persistent --calendar-id from `accli calendars`.');
    }
    resolvedCalendarIndex = resolvedCalendarId;
    resolvedCalendarId = null;
  }

  if (!calendarName && !resolvedCalendarId && !resolvedCalendarIndex) {
    // Check for default calendar
    const defaultId = config.getDefaultCalendarId();
    if (defaultId) {
      resolvedCalendarId = defaultId;
    } else {
      output.outputError(
        { code: ERROR_CODES.MISSING_REQUIRED, message: 'Calendar name, --calendar-name, --calendar-id, or --calendar-index is required (or set a default with `accli config set-default`)' },
        outputOptions(args)
      );
      process.exit(EXIT_VALIDATION_ERROR);
    }
  }

  const from = hasFlag(args, 'from') ? parseLocalDateTime(args.flags.from) : null;
  const to = hasFlag(args, 'to') ? parseLocalDateTime(args.flags.to) : null;
  if (from && !from.ok) {
    output.outputError(
      { code: ERROR_CODES.INVALID_DATETIME, message: `Invalid --from datetime: ${args.flags.from}` },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }

  if (to && !to.ok) {
    output.outputError(
      { code: ERROR_CODES.INVALID_DATETIME, message: `Invalid --to datetime: ${args.flags.to}` },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }

  if (!validateOrderedRange(from, to)) {
    output.outputError(
      { code: ERROR_CODES.INVALID_RANGE, message: '--from must be before --to' },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }

  const max = args.flags.max === undefined ? 50 : parseEventLimit(args.flags.max);
  if (max === null) {
    output.outputError(
      { code: ERROR_CODES.INVALID_ARGUMENT, message: '--max must be an integer from 0 to 10000' },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }

  const scriptArgs = {
    calendarName: calendarName || null,
    calendarId: resolvedCalendarId,
    calendarIndex: resolvedCalendarIndex,
    from: args.flags.from || null,
    to: args.flags.to || null,
    max,
    query: args.flags.query || null,
  };

  const result = await runScript('events', scriptArgs);

  if (result.success) {
    output.output(result.data, {
      ...outputOptions(args),
      formatter: output.formatEvents,
    });
  } else {
    output.outputError(result.error, outputOptions(args));
  }

  process.exit(result.exitCode);
}

async function handleEvent(args) {
  const calendarNameFlag = args.flags['calendar-name'];
  const calendarIds = args.arrays['calendar-id'] || [];
  const calendarIndexes = args.arrays['calendar-index'] || [];

  if (calendarIndexes.length > 1) {
    output.outputError(
      { code: ERROR_CODES.INVALID_ARGUMENT, message: 'Only one --calendar-index is allowed for this command' },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }

  if (calendarIds.length > 1) {
    output.outputError(
      { code: ERROR_CODES.INVALID_ARGUMENT, message: 'Only one --calendar-id is allowed for this command' },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }

  const calendarIndex = calendarIndexes.length === 1 ? calendarIndexes[0] : null;
  const calendarId = calendarIds.length === 1 ? calendarIds[0] : null;

  let resolvedCalendarId = calendarId || null;
  let resolvedCalendarIndex = calendarIndex;

  if (resolvedCalendarId && resolvedCalendarIndex) {
    output.outputError(
      { code: ERROR_CODES.INVALID_ARGUMENT, message: 'Use either --calendar-id or --calendar-index, not both' },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }

  if (resolvedCalendarId && /^\d+$/.test(resolvedCalendarId) && !resolvedCalendarIndex) {
    if (args.flags.human) {
      console.error('Warning: numeric --calendar-id is deprecated; use --calendar-index or a persistent --calendar-id from `accli calendars`.');
    }
    resolvedCalendarIndex = resolvedCalendarId;
    resolvedCalendarId = null;
  }

  // Determine if calendar is already specified via flags
  const calendarFromFlags = calendarNameFlag || resolvedCalendarId || resolvedCalendarIndex;
  const defaultCalendarId = config.getDefaultCalendarId();

  // Parse positionals based on count and whether calendar is specified via flags
  // Rules:
  //   - 2 positionals: <calendarName> <eventId> (always, even if default exists - allows override)
  //   - 1 positional + calendar from flags: <eventId>
  //   - 1 positional + default exists (no flags): <eventId> (use default)
  //   - 1 positional + no default (no flags): <calendarName> (eventId missing error)
  //   - 0 positionals: eventId missing error
  let calendarName = calendarNameFlag || null;
  let eventId;

  if (args.positional.length >= 2) {
    // Two or more positionals: first is calendar name, second is eventId
    if (calendarFromFlags) {
      output.outputError(
        { code: ERROR_CODES.INVALID_ARGUMENT, message: 'Too many positional arguments. When using --calendar-id/--calendar-index/--calendar-name, only provide <eventId>' },
        outputOptions(args)
      );
      process.exit(EXIT_VALIDATION_ERROR);
    }
    calendarName = args.positional[0];
    eventId = args.positional[1];
  } else if (args.positional.length === 1) {
    if (calendarFromFlags) {
      // Calendar from flags, positional is eventId
      eventId = args.positional[0];
    } else if (defaultCalendarId) {
      // Use default calendar, positional is eventId
      resolvedCalendarId = defaultCalendarId;
      eventId = args.positional[0];
    } else {
      // No calendar specified anywhere - positional must be calendar name, eventId is missing
      calendarName = args.positional[0];
      eventId = undefined;
    }
  }
  // else: 0 positionals, eventId will be undefined

  // Apply default calendar if no calendar specified
  if (!calendarName && !resolvedCalendarId && !resolvedCalendarIndex) {
    if (defaultCalendarId) {
      resolvedCalendarId = defaultCalendarId;
    } else {
      output.outputError(
        { code: ERROR_CODES.MISSING_REQUIRED, message: 'Calendar name, --calendar-name, --calendar-id, or --calendar-index is required (or set a default with `accli config set-default`)' },
        outputOptions(args)
      );
      process.exit(EXIT_VALIDATION_ERROR);
    }
  }

  if (!eventId) {
    output.outputError(
      { code: ERROR_CODES.MISSING_REQUIRED, message: 'Event ID is required' },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }

  const scriptArgs = {
    calendarName: calendarName || null,
    calendarId: resolvedCalendarId,
    calendarIndex: resolvedCalendarIndex,
    eventId,
    occurrenceDate: hasFlag(args, 'occurrence-date') ? args.flags['occurrence-date'] : null,
  };

  const result = await runScript('event', scriptArgs);

  if (result.success) {
    output.output(result.data, {
      ...outputOptions(args),
      formatter: output.formatEventDetail,
    });
  } else {
    output.outputError(result.error, outputOptions(args));
  }

  process.exit(result.exitCode);
}

async function handleCreate(args) {
  const calendarNamePositional = args.positional[0];
  const calendarNameFlag = args.flags['calendar-name'];
  const calendarIds = args.arrays['calendar-id'] || [];
  const calendarIndexes = args.arrays['calendar-index'] || [];

  if (calendarNamePositional && calendarNameFlag) {
    output.outputError(
      { code: ERROR_CODES.INVALID_ARGUMENT, message: 'Specify calendar as positional <calendarName> or via --calendar-name, not both' },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }

  if (calendarIndexes.length > 1) {
    output.outputError(
      { code: ERROR_CODES.INVALID_ARGUMENT, message: 'Only one --calendar-index is allowed for this command' },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }

  if (calendarIds.length > 1) {
    output.outputError(
      { code: ERROR_CODES.INVALID_ARGUMENT, message: 'Only one --calendar-id is allowed for this command' },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }

  const calendarIndex = calendarIndexes.length === 1 ? calendarIndexes[0] : null;
  const calendarId = calendarIds.length === 1 ? calendarIds[0] : null;
  const calendarName = calendarNameFlag || calendarNamePositional || null;

  let resolvedCalendarId = calendarId || null;
  let resolvedCalendarIndex = calendarIndex;

  if (resolvedCalendarId && resolvedCalendarIndex) {
    output.outputError(
      { code: ERROR_CODES.INVALID_ARGUMENT, message: 'Use either --calendar-id or --calendar-index, not both' },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }

  if (resolvedCalendarId && /^\d+$/.test(resolvedCalendarId) && !resolvedCalendarIndex) {
    if (args.flags.human) {
      console.error('Warning: numeric --calendar-id is deprecated; use --calendar-index or a persistent --calendar-id from `accli calendars`.');
    }
    resolvedCalendarIndex = resolvedCalendarId;
    resolvedCalendarId = null;
  }

  if (!calendarName && !resolvedCalendarId && !resolvedCalendarIndex) {
    // Check for default calendar
    const defaultId = config.getDefaultCalendarId();
    if (defaultId) {
      resolvedCalendarId = defaultId;
    } else {
      output.outputError(
        { code: ERROR_CODES.MISSING_REQUIRED, message: 'Calendar name, --calendar-name, --calendar-id, or --calendar-index is required (or set a default with `accli config set-default`)' },
        outputOptions(args)
      );
      process.exit(EXIT_VALIDATION_ERROR);
    }
  }

  if (!args.flags.summary) {
    output.outputError(
      { code: ERROR_CODES.MISSING_REQUIRED, message: '--summary is required' },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }

  if (!hasFlag(args, 'start')) {
    output.outputError(
      { code: ERROR_CODES.MISSING_REQUIRED, message: '--start is required' },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }

  if (!hasFlag(args, 'end')) {
    output.outputError(
      { code: ERROR_CODES.MISSING_REQUIRED, message: '--end is required' },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }

  const start = parseLocalDateTime(args.flags.start);
  const end = parseLocalDateTime(args.flags.end);
  if (!start.ok) {
    output.outputError(
      { code: ERROR_CODES.INVALID_DATETIME, message: `Invalid --start datetime: ${args.flags.start}` },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }

  if (!end.ok) {
    output.outputError(
      { code: ERROR_CODES.INVALID_DATETIME, message: `Invalid --end datetime: ${args.flags.end}` },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }

  const allDay = args.flags['all-day'] || false;

  if (allDay) {
    if (start.kind !== 'date' || end.kind !== 'date') {
      output.outputError(
        { code: ERROR_CODES.INVALID_DATETIME, message: '--all-day requires YYYY-MM-DD format for --start and --end' },
        outputOptions(args)
      );
      process.exit(EXIT_VALIDATION_ERROR);
    }
  }

  const effectiveEnd = new Date(end.date.getTime());
  if (allDay) effectiveEnd.setDate(effectiveEnd.getDate() + 1);
  if (!validateOrderedRange(start.date, effectiveEnd)) {
    output.outputError(
      { code: ERROR_CODES.INVALID_RANGE, message: allDay ? 'Start date must not be after end date' : 'Start must be before end' },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }

  const scriptArgs = {
    calendarName: calendarName || null,
    calendarId: resolvedCalendarId,
    calendarIndex: resolvedCalendarIndex,
    summary: args.flags.summary,
    start: args.flags.start,
    end: args.flags.end,
    location: args.flags.location || null,
    description: args.flags.description || null,
    allDay,
  };

  const result = await runScript('create', scriptArgs);

  if (result.success) {
    output.output(result.data, {
      ...outputOptions(args),
      formatter: output.formatCreate,
    });
  } else {
    output.outputError(result.error, outputOptions(args));
  }

  process.exit(result.exitCode);
}

async function handleUpdate(args) {
  const calendarNameFlag = args.flags['calendar-name'];
  const calendarIds = args.arrays['calendar-id'] || [];
  const calendarIndexes = args.arrays['calendar-index'] || [];

  if (calendarIndexes.length > 1) {
    output.outputError(
      { code: ERROR_CODES.INVALID_ARGUMENT, message: 'Only one --calendar-index is allowed for this command' },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }

  if (calendarIds.length > 1) {
    output.outputError(
      { code: ERROR_CODES.INVALID_ARGUMENT, message: 'Only one --calendar-id is allowed for this command' },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }

  const calendarIndex = calendarIndexes.length === 1 ? calendarIndexes[0] : null;
  const calendarId = calendarIds.length === 1 ? calendarIds[0] : null;

  let resolvedCalendarId = calendarId || null;
  let resolvedCalendarIndex = calendarIndex;

  if (resolvedCalendarId && resolvedCalendarIndex) {
    output.outputError(
      { code: ERROR_CODES.INVALID_ARGUMENT, message: 'Use either --calendar-id or --calendar-index, not both' },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }

  if (resolvedCalendarId && /^\d+$/.test(resolvedCalendarId) && !resolvedCalendarIndex) {
    if (args.flags.human) {
      console.error('Warning: numeric --calendar-id is deprecated; use --calendar-index or a persistent --calendar-id from `accli calendars`.');
    }
    resolvedCalendarIndex = resolvedCalendarId;
    resolvedCalendarId = null;
  }

  // Determine if calendar is already specified via flags
  const calendarFromFlags = calendarNameFlag || resolvedCalendarId || resolvedCalendarIndex;
  const defaultCalendarId = config.getDefaultCalendarId();

  // Parse positionals based on count and whether calendar is specified via flags
  // Rules:
  //   - 2 positionals: <calendarName> <eventId> (always, even if default exists - allows override)
  //   - 1 positional + calendar from flags: <eventId>
  //   - 1 positional + default exists (no flags): <eventId> (use default)
  //   - 1 positional + no default (no flags): <calendarName> (eventId missing error)
  //   - 0 positionals: eventId missing error
  let calendarName = calendarNameFlag || null;
  let eventId;

  if (args.positional.length >= 2) {
    // Two or more positionals: first is calendar name, second is eventId
    if (calendarFromFlags) {
      output.outputError(
        { code: ERROR_CODES.INVALID_ARGUMENT, message: 'Too many positional arguments. When using --calendar-id/--calendar-index/--calendar-name, only provide <eventId>' },
        outputOptions(args)
      );
      process.exit(EXIT_VALIDATION_ERROR);
    }
    calendarName = args.positional[0];
    eventId = args.positional[1];
  } else if (args.positional.length === 1) {
    if (calendarFromFlags) {
      // Calendar from flags, positional is eventId
      eventId = args.positional[0];
    } else if (defaultCalendarId) {
      // Use default calendar, positional is eventId
      resolvedCalendarId = defaultCalendarId;
      eventId = args.positional[0];
    } else {
      // No calendar specified anywhere - positional must be calendar name, eventId is missing
      calendarName = args.positional[0];
      eventId = undefined;
    }
  }
  // else: 0 positionals, eventId will be undefined

  // Apply default calendar if no calendar specified
  if (!calendarName && !resolvedCalendarId && !resolvedCalendarIndex) {
    if (defaultCalendarId) {
      resolvedCalendarId = defaultCalendarId;
    } else {
      output.outputError(
        { code: ERROR_CODES.MISSING_REQUIRED, message: 'Calendar name, --calendar-name, --calendar-id, or --calendar-index is required (or set a default with `accli config set-default`)' },
        outputOptions(args)
      );
      process.exit(EXIT_VALIDATION_ERROR);
    }
  }

  if (!eventId) {
    output.outputError(
      { code: ERROR_CODES.MISSING_REQUIRED, message: 'Event ID is required' },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }

  const start = hasFlag(args, 'start') ? parseLocalDateTime(args.flags.start) : null;
  const end = hasFlag(args, 'end') ? parseLocalDateTime(args.flags.end) : null;
  if (start && !start.ok) {
    output.outputError(
      { code: ERROR_CODES.INVALID_DATETIME, message: `Invalid --start datetime: ${args.flags.start}` },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }

  if (end && !end.ok) {
    output.outputError(
      { code: ERROR_CODES.INVALID_DATETIME, message: `Invalid --end datetime: ${args.flags.end}` },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }

  const changingAllDayMode = args.flags['all-day'] || args.flags['no-all-day'];
  if (changingAllDayMode && !!start !== !!end) {
    output.outputError(
      { code: ERROR_CODES.INVALID_ARGUMENT, message: 'Changing all-day mode with dates requires both --start and --end' },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }
  if (args.flags['all-day'] && ((start && start.kind !== 'date') || (end && end.kind !== 'date'))) {
    output.outputError(
      { code: ERROR_CODES.INVALID_DATETIME, message: '--all-day requires YYYY-MM-DD format for --start and --end' },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }
  if (args.flags['no-all-day'] && ((start && start.kind === 'date') || (end && end.kind === 'date'))) {
    output.outputError(
      { code: ERROR_CODES.INVALID_DATETIME, message: '--no-all-day requires datetime boundaries' },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }
  if (start && end) {
    const effectiveEnd = new Date(end.date.getTime());
    if (args.flags['all-day']) effectiveEnd.setDate(effectiveEnd.getDate() + 1);
    const validRange = args.flags['all-day']
      ? validateOrderedRange(start.date, effectiveEnd)
      : validateUpdateRange(start, end);
    if (!validRange) {
      output.outputError(
        { code: ERROR_CODES.INVALID_RANGE, message: 'Start must be before end' },
        outputOptions(args)
      );
      process.exit(EXIT_VALIDATION_ERROR);
    }
  }

  const scriptArgs = {
    calendarName: calendarName || null,
    calendarId: resolvedCalendarId,
    calendarIndex: resolvedCalendarIndex,
    eventId,
    occurrenceDate: hasFlag(args, 'occurrence-date') ? args.flags['occurrence-date'] : null,
    span: hasFlag(args, 'span') ? args.flags.span : null,
    // Preserve empty strings to allow clearing fields (e.g., --location "")
    summary: args.flags.summary !== undefined ? args.flags.summary : null,
    start: hasFlag(args, 'start') ? args.flags.start : null,
    end: hasFlag(args, 'end') ? args.flags.end : null,
    location: args.flags.location !== undefined ? args.flags.location : null,
    description: args.flags.description !== undefined ? args.flags.description : null,
    allDay: args.flags['all-day'] || false,
    noAllDay: args.flags['no-all-day'] || false,
  };

  const result = await runScript('update', scriptArgs);

  if (result.success) {
    output.output(result.data, {
      ...outputOptions(args),
      formatter: output.formatUpdate,
    });
  } else {
    output.outputError(result.error, outputOptions(args));
  }

  process.exit(result.exitCode);
}

async function handleDelete(args) {
  const calendarNameFlag = args.flags['calendar-name'];
  const calendarIds = args.arrays['calendar-id'] || [];
  const calendarIndexes = args.arrays['calendar-index'] || [];

  if (calendarIndexes.length > 1) {
    output.outputError(
      { code: ERROR_CODES.INVALID_ARGUMENT, message: 'Only one --calendar-index is allowed for this command' },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }

  if (calendarIds.length > 1) {
    output.outputError(
      { code: ERROR_CODES.INVALID_ARGUMENT, message: 'Only one --calendar-id is allowed for this command' },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }

  const calendarIndex = calendarIndexes.length === 1 ? calendarIndexes[0] : null;
  const calendarId = calendarIds.length === 1 ? calendarIds[0] : null;

  let resolvedCalendarId = calendarId || null;
  let resolvedCalendarIndex = calendarIndex;

  if (resolvedCalendarId && resolvedCalendarIndex) {
    output.outputError(
      { code: ERROR_CODES.INVALID_ARGUMENT, message: 'Use either --calendar-id or --calendar-index, not both' },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }

  if (resolvedCalendarId && /^\d+$/.test(resolvedCalendarId) && !resolvedCalendarIndex) {
    if (args.flags.human) {
      console.error('Warning: numeric --calendar-id is deprecated; use --calendar-index or a persistent --calendar-id from `accli calendars`.');
    }
    resolvedCalendarIndex = resolvedCalendarId;
    resolvedCalendarId = null;
  }

  // Determine if calendar is already specified via flags
  const calendarFromFlags = calendarNameFlag || resolvedCalendarId || resolvedCalendarIndex;
  const defaultCalendarId = config.getDefaultCalendarId();

  // Parse positionals based on count and whether calendar is specified via flags
  // Rules:
  //   - 2 positionals: <calendarName> <eventId> (always, even if default exists - allows override)
  //   - 1 positional + calendar from flags: <eventId>
  //   - 1 positional + default exists (no flags): <eventId> (use default)
  //   - 1 positional + no default (no flags): <calendarName> (eventId missing error)
  //   - 0 positionals: eventId missing error
  let calendarName = calendarNameFlag || null;
  let eventId;

  if (args.positional.length >= 2) {
    // Two or more positionals: first is calendar name, second is eventId
    if (calendarFromFlags) {
      output.outputError(
        { code: ERROR_CODES.INVALID_ARGUMENT, message: 'Too many positional arguments. When using --calendar-id/--calendar-index/--calendar-name, only provide <eventId>' },
        outputOptions(args)
      );
      process.exit(EXIT_VALIDATION_ERROR);
    }
    calendarName = args.positional[0];
    eventId = args.positional[1];
  } else if (args.positional.length === 1) {
    if (calendarFromFlags) {
      // Calendar from flags, positional is eventId
      eventId = args.positional[0];
    } else if (defaultCalendarId) {
      // Use default calendar, positional is eventId
      resolvedCalendarId = defaultCalendarId;
      eventId = args.positional[0];
    } else {
      // No calendar specified anywhere - positional must be calendar name, eventId is missing
      calendarName = args.positional[0];
      eventId = undefined;
    }
  }
  // else: 0 positionals, eventId will be undefined

  // Apply default calendar if no calendar specified
  if (!calendarName && !resolvedCalendarId && !resolvedCalendarIndex) {
    if (defaultCalendarId) {
      resolvedCalendarId = defaultCalendarId;
    } else {
      output.outputError(
        { code: ERROR_CODES.MISSING_REQUIRED, message: 'Calendar name, --calendar-name, --calendar-id, or --calendar-index is required (or set a default with `accli config set-default`)' },
        outputOptions(args)
      );
      process.exit(EXIT_VALIDATION_ERROR);
    }
  }

  if (!eventId) {
    output.outputError(
      { code: ERROR_CODES.MISSING_REQUIRED, message: 'Event ID is required' },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }

  const scriptArgs = {
    calendarName: calendarName || null,
    calendarId: resolvedCalendarId,
    calendarIndex: resolvedCalendarIndex,
    eventId,
    occurrenceDate: hasFlag(args, 'occurrence-date') ? args.flags['occurrence-date'] : null,
    span: hasFlag(args, 'span') ? args.flags.span : null,
  };

  const result = await runScript('delete', scriptArgs);

  if (result.success) {
    output.output(result.data, {
      ...outputOptions(args),
      formatter: output.formatDelete,
    });
  } else {
    output.outputError(result.error, outputOptions(args));
  }

  process.exit(result.exitCode);
}

async function handleFreeBusy(args) {
  const calendars = args.arrays['calendar'] || [];
  const calendarIds = args.arrays['calendar-id'] || [];
  const calendarIndexes = args.arrays['calendar-index'] || [];

  if (calendars.length === 0 && calendarIds.length === 0 && calendarIndexes.length === 0) {
    output.outputError(
      { code: ERROR_CODES.MISSING_REQUIRED, message: 'At least one --calendar, --calendar-id, or --calendar-index is required' },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }

  if (!hasFlag(args, 'from')) {
    output.outputError(
      { code: ERROR_CODES.MISSING_REQUIRED, message: '--from is required' },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }

  if (!hasFlag(args, 'to')) {
    output.outputError(
      { code: ERROR_CODES.MISSING_REQUIRED, message: '--to is required' },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }

  const from = parseLocalDateTime(args.flags.from);
  const to = parseLocalDateTime(args.flags.to);
  if (!from.ok) {
    output.outputError(
      { code: ERROR_CODES.INVALID_DATETIME, message: `Invalid --from datetime: ${args.flags.from}` },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }

  if (!to.ok) {
    output.outputError(
      { code: ERROR_CODES.INVALID_DATETIME, message: `Invalid --to datetime: ${args.flags.to}` },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }

  if (!validateOrderedRange(from, to)) {
    output.outputError(
      { code: ERROR_CODES.INVALID_RANGE, message: '--from must be before --to' },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }

  const scriptArgs = {
    calendars,
    calendarIds,
    calendarIndexes,
    from: args.flags.from,
    to: args.flags.to,
  };

  const result = await runScript('freebusy', scriptArgs);

  if (result.success) {
    output.output(result.data, {
      ...outputOptions(args),
      formatter: output.formatFreeBusy,
    });
  } else {
    output.outputError(result.error, outputOptions(args));
  }

  process.exit(result.exitCode);
}

async function handleConfig(args) {
  const action = args.positional[0];

  if (!action) {
    output.outputError(
      { code: ERROR_CODES.MISSING_REQUIRED, message: 'Config action required: set-default, show, or clear' },
      outputOptions(args)
    );
    process.exit(EXIT_VALIDATION_ERROR);
  }

  switch (action) {
    case 'set-default': {
      const calendarName = args.arrays['calendar']?.[0] || null;
      const calendarId = args.arrays['calendar-id']?.[0] || null;

      // Non-interactive mode: calendar specified via flag
      if (calendarName || calendarId) {
        // Fetch calendars to validate and get info
        const result = await runScript('calendars', {});
        if (!result.success) {
          output.outputError(result.error, outputOptions(args));
          process.exit(result.exitCode);
        }

        const calendars = result.data.calendars;
        let selectedCalendar = null;

        if (calendarId) {
          selectedCalendar = calendars.find((c) => c.id === calendarId);
          if (!selectedCalendar) {
            output.outputError(
              { code: ERROR_CODES.CALENDAR_NOT_FOUND, message: `Calendar with ID "${calendarId}" not found` },
              outputOptions(args)
            );
            process.exit(EXIT_VALIDATION_ERROR);
          }
        } else if (calendarName) {
          const matches = calendars.filter((c) => c.name === calendarName);
          if (matches.length === 0) {
            output.outputError(
              { code: ERROR_CODES.CALENDAR_NOT_FOUND, message: `Calendar "${calendarName}" not found` },
              outputOptions(args)
            );
            process.exit(EXIT_VALIDATION_ERROR);
          }
          if (matches.length > 1) {
            const ids = matches.map((c) => c.id).join(', ');
            output.outputError(
              { code: ERROR_CODES.AMBIGUOUS_CALENDAR, message: `Multiple calendars named "${calendarName}". Use --calendar-id with one of: ${ids}` },
              outputOptions(args)
            );
            process.exit(EXIT_VALIDATION_ERROR);
          }
          selectedCalendar = matches[0];
        }

        config.setDefaultCalendarId(selectedCalendar.id);

        if (args.flags.human) {
          console.log(`Default calendar set to "${output.escapeTerminalText(selectedCalendar.name)}"`);
        } else {
          output.output({ defaultCalendar: { id: selectedCalendar.id, name: selectedCalendar.name } }, outputOptions(args));
        }
        process.exit(0);
      }

      // Interactive mode: prompt user to select
      if (!args.flags.human || !process.stdin.isTTY) {
        output.outputError(
          { code: ERROR_CODES.MISSING_REQUIRED, message: 'Non-interactive mode requires --calendar or --calendar-id' },
          outputOptions(args)
        );
        process.exit(EXIT_VALIDATION_ERROR);
      }

      const result = await runScript('calendars', {});
      if (!result.success) {
        output.outputError(result.error, outputOptions(args));
        process.exit(result.exitCode);
      }

      const calendars = result.data.calendars;
      if (calendars.length === 0) {
        output.outputError(
          { code: ERROR_CODES.CALENDAR_NOT_FOUND, message: 'No calendars found' },
          outputOptions(args)
        );
        process.exit(EXIT_VALIDATION_ERROR);
      }

      console.log('Available calendars:');
      calendars.forEach((cal, i) => {
        console.log(
          `  ${i + 1}. ${output.escapeTerminalText(cal.name)} (${output.escapeTerminalText(cal.source)}) - ID: ${output.escapeTerminalText(String(cal.id).substring(0, 8))}...`
        );
      });

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise((resolve) => {
        rl.question(`Select default calendar [1-${calendars.length}]: `, resolve);
      });
      rl.close();

      const index = parseInt(answer, 10) - 1;
      if (isNaN(index) || index < 0 || index >= calendars.length) {
        output.outputError(
          { code: ERROR_CODES.INVALID_ARGUMENT, message: 'Invalid selection' },
          outputOptions(args)
        );
        process.exit(EXIT_VALIDATION_ERROR);
      }

      const selectedCalendar = calendars[index];
      config.setDefaultCalendarId(selectedCalendar.id);
      console.log(`Default calendar set to "${output.escapeTerminalText(selectedCalendar.name)}"`);
      process.exit(0);
    }

    case 'show': {
      const defaultId = config.getDefaultCalendarId();

      if (!defaultId) {
        if (args.flags.human) {
          console.log('No default calendar set');
        } else {
          output.output({ defaultCalendar: null }, outputOptions(args));
        }
        process.exit(0);
      }

      // Fetch calendars to get the name
      const result = await runScript('calendars', {});
      if (!result.success) {
        output.outputError(result.error, outputOptions(args));
        process.exit(result.exitCode);
      }

      const calendar = result.data.calendars.find((c) => c.id === defaultId);

      if (!args.flags.human) {
        output.output({
          defaultCalendar: calendar ? { id: defaultId, name: calendar.name } : { id: defaultId, name: null },
        }, outputOptions(args));
      } else {
        if (calendar) {
          console.log(`Default calendar: ${output.escapeTerminalText(calendar.name)} (${output.escapeTerminalText(defaultId)})`);
        } else {
          console.log(`Default calendar ID: ${output.escapeTerminalText(defaultId)} (calendar no longer exists)`);
        }
      }
      process.exit(0);
    }

    case 'clear': {
      config.clearDefaultCalendar();

      if (args.flags.human) {
        console.log('Default calendar cleared');
      } else {
        output.output({ cleared: true }, outputOptions(args));
      }
      process.exit(0);
    }

    default:
      output.outputError(
        { code: ERROR_CODES.INVALID_ARGUMENT, message: `Unknown config action: ${action}. Use set-default, show, or clear` },
        outputOptions(args)
      );
      process.exit(EXIT_VALIDATION_ERROR);
  }
}

// Main entry point
async function main() {
  const parseResult = parseArgs(process.argv.slice(2));

  // Parsing errors follow the same output policy as operational errors.
  if (!parseResult.ok) {
    output.outputError(parseResult.error, {
      human: process.argv.includes('--human'),
      compact: process.argv.includes('--compact'),
    });
    process.exit(EXIT_VALIDATION_ERROR);
  }

  const args = parseResult.result;

  // Handle global version
  if (args.flags.version) {
    const { version } = require('../package.json');
    console.log(version);
    process.exit(0);
  }

  // Handle global help
  if (args.flags.help && !args.command) {
    showHelp();
    process.exit(0);
  }

  // Handle command-specific help
  if (args.flags.help && args.command) {
    showHelp(args.command);
    process.exit(0);
  }

  // No command provided
  if (!args.command) {
    showHelp();
    process.exit(EXIT_VALIDATION_ERROR);
  }

  if (!COMMAND_CONTRACTS[args.command]) {
    output.outputError(
      { code: ERROR_CODES.INVALID_ARGUMENT, message: `Unknown command: ${args.command}` },
      outputOptions(args)
    );
    if (args.flags.human) {
      showHelp(null, { stderr: true });
    }
    process.exit(EXIT_VALIDATION_ERROR);
  }

  const contractError = validateCommandContract(args);
  if (contractError) {
    output.outputError(contractError, outputOptions(args));
    process.exit(EXIT_VALIDATION_ERROR);
  }

  // Route to command handler
  switch (args.command) {
    case 'setup':
      await handleSetup(args);
      break;
    case 'calendars':
      await handleCalendars(args);
      break;
    case 'events':
      await handleEvents(args);
      break;
    case 'event':
      await handleEvent(args);
      break;
    case 'create':
      await handleCreate(args);
      break;
    case 'update':
      await handleUpdate(args);
      break;
    case 'delete':
      await handleDelete(args);
      break;
    case 'freebusy':
      await handleFreeBusy(args);
      break;
    case 'config':
      await handleConfig(args);
      break;
    default:
      // Command validity was checked above this switch.
      process.exit(EXIT_VALIDATION_ERROR);
  }
}

main().catch((err) => {
  output.outputError(
    { code: ERROR_CODES.INTERNAL_ERROR, message: err && err.message ? err.message : 'Unexpected internal error' },
    { human: process.argv.includes('--human'), compact: process.argv.includes('--compact') }
  );
  process.exit(1);
});
