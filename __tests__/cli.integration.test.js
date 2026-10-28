'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function runCli(args, { env } = {}) {
  const preload = path.join(__dirname, 'helpers', 'mock-osascript.js');
  const nodeArgs = ['-r', preload, path.join(__dirname, '..', 'bin', 'accli.js'), ...args];
  return spawnSync(process.execPath, nodeArgs, { encoding: 'utf8', env: { ...process.env, ...env } });
}

function makeTempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accli-cli-home-'));
  return {
    dir,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('accli CLI integration', () => {
  test('--version prints package version', () => {
    const { version } = require('../package.json');
    const r = runCli(['--version']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(version);
  });

  test('no args prints global help and exits with a validation status', () => {
    const r = runCli([]);
    expect(r.status).toBe(2);
    expect(r.stderr).toBe('');
    expect(r.stdout).toMatch(/USAGE:/);
    expect(() => JSON.parse(r.stdout)).toThrow();
  });

  test('unknown command returns a JSON validation error by default', () => {
    const r = runCli(['nope']);
    expect(r.status).toBe(2);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout).error.message).toMatch(/Unknown command/);

    const human = runCli(['nope', '--human']);
    expect(human.status).toBe(2);
    expect(human.stdout).toBe('');
    expect(human.stderr).toMatch(/Error \[INVALID_ARGUMENT\]: Unknown command/);
    expect(human.stderr).toMatch(/USAGE:/);

    const compact = runCli(['nope', '--compact']);
    expect(compact.status).toBe(2);
    expect(compact.stdout.trim()).not.toContain('\n');
    expect(JSON.parse(compact.stdout).error.code).toBe('INVALID_ARGUMENT');
  });

  test('--help remains plain text', () => {
    const r = runCli(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/USAGE:/);
    expect(() => JSON.parse(r.stdout)).toThrow();

    const compact = runCli(['--help', '--compact', '--human']);
    expect(compact.status).toBe(0);
    expect(compact.stdout).toMatch(/USAGE:/);
    expect(() => JSON.parse(compact.stdout)).toThrow();

    for (const command of ['setup', 'calendars']) {
      const commandHelp = runCli([command, '--help']);
      expect(commandHelp.status).toBe(0);
      expect(commandHelp.stdout).toMatch(/--human/);
      expect(commandHelp.stdout).toMatch(/--compact/);
      expect(commandHelp.stdout).toMatch(/--json/);
    }
  });

  test('unexpected errors follow the selected output mode', () => {
    const tmp = makeTempHome();
    const configPath = path.join(tmp.dir, '.acclirc');
    fs.writeFileSync(configPath, '{invalid json', 'utf8');

    try {
      const json = runCli(['events'], { env: { ACCLI_CONFIG_PATH: configPath } });
      expect(json.status).toBe(1);
      expect(json.stderr).toBe('');
      expect(JSON.parse(json.stdout).error.code).toBe('INTERNAL_ERROR');

      const human = runCli(['events', '--human'], { env: { ACCLI_CONFIG_PATH: configPath } });
      expect(human.status).toBe(1);
      expect(human.stdout).toBe('');
      expect(human.stderr).toMatch(/Error \[INTERNAL_ERROR\]: Failed to read config/);

      const compact = runCli(['events', '--compact'], { env: { ACCLI_CONFIG_PATH: configPath } });
      expect(compact.status).toBe(1);
      expect(compact.stdout.trim()).not.toContain('\n');
      expect(JSON.parse(compact.stdout).error.code).toBe('INTERNAL_ERROR');
    } finally {
      tmp.cleanup();
    }
  });

  test('calendars defaults to pretty JSON and --json remains compatible', () => {
    const plain = runCli(['calendars']);
    const compatibility = runCli(['calendars', '--json']);
    expect(plain.status).toBe(0);
    expect(plain.stdout).toContain('\n  "calendars"');
    expect(compatibility.stdout).toBe(plain.stdout);
  });

  test('--compact emits single-line JSON and --human wins over --json', () => {
    const compact = runCli(['calendars', '--compact']);
    expect(compact.status).toBe(0);
    expect(compact.stdout.trim()).not.toContain('\n');
    expect(Array.isArray(JSON.parse(compact.stdout).calendars)).toBe(true);

    const human = runCli(['calendars', '--json', '--human']);
    expect(human.status).toBe(0);
    expect(human.stdout).toMatch(/Calendars:/);
    expect(() => JSON.parse(human.stdout)).toThrow();

    const humanCompact = runCli(['calendars', '--human', '--compact']);
    expect(humanCompact.stdout).toBe(human.stdout);
  });

  test('validation errors default to JSON stdout and use stderr with --human', () => {
    const json = runCli(['create']);
    expect(json.status).toBe(2);
    expect(json.stderr).toBe('');
    expect(JSON.parse(json.stdout).error.code).toBe('MISSING_REQUIRED');

    const compact = runCli(['create', '--compact']);
    expect(compact.status).toBe(2);
    expect(compact.stdout.trim()).not.toContain('\n');
    expect(JSON.parse(compact.stdout).error.code).toBe('MISSING_REQUIRED');

    const human = runCli(['create', '--human']);
    expect(human.status).toBe(2);
    expect(human.stdout).toBe('');
    expect(human.stderr).toMatch(/Error \[MISSING_REQUIRED\]/);
  });

  test('parse errors follow the selected output mode', () => {
    const json = runCli(['calendars', '--from']);
    expect(json.status).toBe(2);
    expect(json.stderr).toBe('');
    expect(JSON.parse(json.stdout).error.code).toBe('MISSING_REQUIRED');

    const human = runCli(['calendars', '--from', '--human']);
    expect(human.status).toBe(2);
    expect(human.stdout).toBe('');
    expect(human.stderr).toMatch(/Error \[MISSING_REQUIRED\]/);
  });

  test('config selection is non-interactive unless --human is supplied', () => {
    const json = runCli(['config', 'set-default']);
    expect(json.status).toBe(2);
    expect(JSON.parse(json.stdout).error.message).toMatch(/Non-interactive mode requires/);

    const human = runCli(['config', 'set-default', '--human']);
    expect(human.status).toBe(2);
    expect(human.stderr).toMatch(/Non-interactive mode requires/);
  });

  test('calendars --json returns stubbed calendars', () => {
    const r = runCli(['calendars', '--json']);
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(Array.isArray(data.calendars)).toBe(true);
    expect(data.calendars[0].name).toBe('Work');
  });

  test('events --json without calendar and no default returns MISSING_REQUIRED', () => {
    const tmp = makeTempHome();
    try {
      const r = runCli(['events', '--from', '2025-01-01', '--to', '2025-01-02', '--json'], { env: { ACCLI_CONFIG_PATH: path.join(tmp.dir, '.acclirc') } });
      expect(r.status).toBe(2);
      const data = JSON.parse(r.stdout);
      expect(data.ok).toBe(false);
      expect(data.error.code).toBe('MISSING_REQUIRED');
    } finally {
      tmp.cleanup();
    }
  });

  test('config set-default and show uses ~/.acclirc', () => {
    const tmp = makeTempHome();
    try {
      const set = runCli(['config', 'set-default', '--calendar-id', 'CAL1', '--json'], { env: { ACCLI_CONFIG_PATH: path.join(tmp.dir, '.acclirc') } });
      expect(set.status).toBe(0);
      expect(JSON.parse(set.stdout).defaultCalendar.id).toBe('CAL1');

      const show = runCli(['config', 'show', '--json'], { env: { ACCLI_CONFIG_PATH: path.join(tmp.dir, '.acclirc') } });
      expect(show.status).toBe(0);
      expect(JSON.parse(show.stdout).defaultCalendar.id).toBe('CAL1');
    } finally {
      tmp.cleanup();
    }
  });

  test('authorization errors retain exit 10 and selected output channel', () => {
    const payload = JSON.stringify({ ok: false, error: { code: 'NOT_AUTHORIZED', message: 'calendar denied' } });
    const json = runCli(['calendars'], { env: { ACCLI_MOCK_OSASCRIPT_RESPONSE: payload } });
    expect(json.status).toBe(10);
    expect(json.stderr).toBe('');
    expect(JSON.parse(json.stdout).error.code).toBe('NOT_AUTHORIZED');

    const human = runCli(['calendars', '--human'], { env: { ACCLI_MOCK_OSASCRIPT_RESPONSE: payload } });
    expect(human.status).toBe(10);
    expect(human.stdout).toBe('');
    expect(human.stderr).toMatch(/Error \[NOT_AUTHORIZED\]: calendar denied/);
  });

  test('config operations honor default, compact, and human output modes', () => {
    const tmp = makeTempHome();
    try {
      const env = { ACCLI_CONFIG_PATH: path.join(tmp.dir, '.acclirc') };
      const set = runCli(['config', 'set-default', '--calendar-id', 'CAL1'], { env });
      expect(set.status).toBe(0);
      expect(JSON.parse(set.stdout).defaultCalendar.id).toBe('CAL1');

      const show = runCli(['config', 'show', '--compact'], { env });
      expect(show.status).toBe(0);
      expect(show.stdout.trim()).not.toContain('\n');
      expect(JSON.parse(show.stdout).defaultCalendar.id).toBe('CAL1');

      const clear = runCli(['config', 'clear', '--human', '--compact', '--json'], { env });
      expect(clear.status).toBe(0);
      expect(clear.stdout).toBe('Default calendar cleared\n');
      expect(clear.stderr).toBe('');
    } finally {
      tmp.cleanup();
    }
  });

  test('config human output escapes calendar text while JSON remains raw', () => {
    const tmp = makeTempHome();
    const id = 'ID\x1b[31m';
    const name = 'Work\x1b]8;;https://example.test\x07\nnext';
    const source = 'iCloud\r\t';
    const payload = JSON.stringify({ ok: true, calendars: [{ id, name, source, index: 0 }] });
    const env = {
      ACCLI_CONFIG_PATH: path.join(tmp.dir, '.acclirc'),
      ACCLI_MOCK_OSASCRIPT_RESPONSE: payload,
    };

    try {
      const set = runCli(['config', 'set-default', '--calendar-id', id, '--human'], { env });
      expect(set.status).toBe(0);
      expect(set.stdout).toContain('\\x1b');
      expect(set.stdout).not.toContain('\x1b');

      const human = runCli(['config', 'show', '--human'], { env });
      expect(human.status).toBe(0);
      expect(human.stdout).toContain('\\x1b');
      expect(human.stdout).not.toContain('\x1b');

      const json = runCli(['config', 'show'], { env });
      expect(json.status).toBe(0);
      expect(JSON.parse(json.stdout).defaultCalendar).toEqual({ id, name });
    } finally {
      tmp.cleanup();
    }
  });
});

describe('positional parsing for event/update/delete (regression tests)', () => {
  test('event with 2 positionals works (calendar override)', () => {
    const tmp = makeTempHome();
    try {
      // Set a default calendar first
      runCli(['config', 'set-default', '--calendar-id', 'CAL1', '--json'], { env: { ACCLI_CONFIG_PATH: path.join(tmp.dir, '.acclirc') } });
      // Now use 2 positionals - should override default, not error
      const r = runCli(['event', 'Work', 'event-123', '--json'], { env: { ACCLI_CONFIG_PATH: path.join(tmp.dir, '.acclirc') } });
      // Mock returns EVENT_NOT_FOUND, but the point is it didn't fail with "Too many positional arguments"
      expect(r.status).toBe(1); // runtime error, not validation error
      const data = JSON.parse(r.stdout);
      expect(data.error.code).toBe('EVENT_NOT_FOUND');
    } finally {
      tmp.cleanup();
    }
  });

  test('event with 1 positional + default uses default calendar', () => {
    const tmp = makeTempHome();
    try {
      runCli(['config', 'set-default', '--calendar-id', 'CAL1', '--json'], { env: { ACCLI_CONFIG_PATH: path.join(tmp.dir, '.acclirc') } });
      const r = runCli(['event', 'event-123', '--json'], { env: { ACCLI_CONFIG_PATH: path.join(tmp.dir, '.acclirc') } });
      expect(r.status).toBe(1); // runtime error (EVENT_NOT_FOUND), not validation
      const data = JSON.parse(r.stdout);
      expect(data.error.code).toBe('EVENT_NOT_FOUND');
    } finally {
      tmp.cleanup();
    }
  });

  test('event with 1 positional + --calendar-id flag works', () => {
    const tmp = makeTempHome();
    try {
      const r = runCli(['event', 'event-123', '--calendar-id', 'CAL1', '--json'], { env: { ACCLI_CONFIG_PATH: path.join(tmp.dir, '.acclirc') } });
      expect(r.status).toBe(1); // runtime error
      const data = JSON.parse(r.stdout);
      expect(data.error.code).toBe('EVENT_NOT_FOUND');
    } finally {
      tmp.cleanup();
    }
  });

  test('event with 1 positional + no default = missing eventId error', () => {
    const tmp = makeTempHome();
    try {
      const r = runCli(['event', 'Work', '--json'], { env: { ACCLI_CONFIG_PATH: path.join(tmp.dir, '.acclirc') } });
      expect(r.status).toBe(2); // validation error
      const data = JSON.parse(r.stdout);
      expect(data.ok).toBe(false);
      expect(data.error.code).toBe('MISSING_REQUIRED');
      expect(data.error.message).toMatch(/event ID/i);
    } finally {
      tmp.cleanup();
    }
  });

  test('event with 2 positionals + --calendar-id flag = too many args', () => {
    const tmp = makeTempHome();
    try {
      const r = runCli(['event', 'Work', 'event-123', '--calendar-id', 'CAL1', '--json'], { env: { ACCLI_CONFIG_PATH: path.join(tmp.dir, '.acclirc') } });
      expect(r.status).toBe(2); // validation error
      const data = JSON.parse(r.stdout);
      expect(data.ok).toBe(false);
      expect(data.error.code).toBe('INVALID_ARGUMENT');
      expect(data.error.message).toMatch(/calendar/i);
    } finally {
      tmp.cleanup();
    }
  });
});

describe('CLI command contracts', () => {
  function expectInvalid(args, message) {
    const result = runCli(args);
    expect(result.status).toBe(2);
    expect(result.stderr).toBe('');
    const data = JSON.parse(result.stdout);
    expect(data.ok).toBe(false);
    expect(data.error.code).toBe('INVALID_ARGUMENT');
    if (message) expect(data.error.message).toMatch(message);
  }

  test.each([
    [['events', '--maxx', '10'], /Unknown flag: --maxx/],
    [['delete', 'Work', 'event-123', 'surplus'], /positional/],
    [['update', 'Work', 'event-123', 'surplus'], /positional/],
    [['create', 'Work', '--calendar-id', 'CAL1', '--summary', 'Meeting', '--start', '2025-01-15T14:00', '--end', '2025-01-15T15:00'], /calendar/i],
    [['events', 'Work', '--calendar-id', 'CAL1'], /calendar/i],
    [['events', '--calendar-name', 'Work', '--calendar-index', '0'], /calendar/i],
    [['update', 'Work', 'event-123', '--all-day', '--no-all-day'], /either --all-day or --no-all-day/],
    [['events', '--calendar-id', 'CAL1', '--calendar-id', 'CAL2'], /Only one --calendar-id/],
    [['config', 'set-default', '--calendar-id', 'CAL1', '--calendar-id', 'CAL2'], /Only one --calendar or --calendar-id/],
    [['events', '--calendar-name', 'Work', '--calendar-name', 'Personal'], /only be specified once: --calendar-name/],
    [['events', 'Work', '--from', '2025-01-01', '--from', '2025-01-02'], /only be specified once: --from/],
    [['create', 'Work', '--summary', 'One', '--summary', 'Two'], /only be specified once: --summary/],
    [['events', '--typo'], /Unknown flag: --typo/],
  ])('rejects invalid input %#', (args, message) => {
    expectInvalid(args, message);
  });

  test('misspelled create calendar selector is rejected before default-calendar dispatch', () => {
    const tmp = makeTempHome();
    try {
      fs.writeFileSync(path.join(tmp.dir, '.acclirc'), JSON.stringify({ defaultCalendarId: 'CAL1' }));
      const result = runCli([
        'create', '--calender-id', 'CAL1', '--summary', 'Meeting', '--start', '2025-01-15T14:00', '--end', '2025-01-15T15:00',
      ], { env: { ACCLI_CONFIG_PATH: path.join(tmp.dir, '.acclirc') } });
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout).error).toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringMatching(/--calender-id/) });
    } finally {
      tmp.cleanup();
    }
  });

  test('freebusy accepts repeated calendar selectors', () => {
    const result = runCli([
      'freebusy', '--calendar', 'Work', '--calendar', 'Personal', '--calendar-id', 'CAL1', '--calendar-id', 'CAL2',
      '--calendar-index', '0', '--calendar-index', '1', '--from', '2025-01-15', '--to', '2025-01-16',
    ]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).busy).toEqual([]);
  });

  test('valid event forms still accept positional calendars and configured defaults', () => {
    const tmp = makeTempHome();
    try {
      const configPath = path.join(tmp.dir, '.acclirc');
      fs.writeFileSync(configPath, JSON.stringify({ defaultCalendarId: 'CAL1' }));
      for (const args of [
        ['event', 'Work', 'event-123'],
        ['event', 'event-123', '--calendar-id', 'CAL1'],
        ['event', 'event-123'],
      ]) {
        const result = runCli(args, { env: { ACCLI_CONFIG_PATH: configPath } });
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).error.code).toBe('EVENT_NOT_FOUND');
      }
    } finally {
      tmp.cleanup();
    }
  });

  test('human contract errors use stderr', () => {
    const result = runCli(['events', '--unknown', 'value', '--human']);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/Error \[INVALID_ARGUMENT\]: Unknown flag/);
  });
});

describe('strict calendar input validation', () => {
  function expectValidation(args, code) {
    const result = runCli(args);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).error.code).toBe(code);
  }

  test.each([
    ['2025-02-30'], ['2025-04-31'], ['2025-01-01T24:00'], ['2025-01-01T12:60'],
  ])('rejects malformed event dates before dispatch: %s', (value) => {
    expectValidation(['events', 'Work', '--from', value], 'INVALID_DATETIME');
  });

  test.each([
    [['events', 'Work', '--calendar-index', '1x'], 'INVALID_ARGUMENT'],
    [['events', 'Work', '--max', '-1'], 'INVALID_ARGUMENT'],
    [['events', 'Work', '--max', '1.5'], 'INVALID_ARGUMENT'],
    [['events', 'Work', '--max', '10001'], 'INVALID_ARGUMENT'],
    [['events', 'Work', '--from', '2025-01-16', '--to', '2025-01-15'], 'INVALID_RANGE'],
    [['events', 'Work', '--from', '2025-01-15', '--to', '2025-01-15'], 'INVALID_RANGE'],
    [['freebusy', '--calendar', 'Work', '--from', '2025-01-15', '--to', '2025-01-15'], 'INVALID_RANGE'],
    [['create', 'Work', '--summary', 'Meeting', '--start', '2025-01-15T15:00', '--end', '2025-01-15T14:00'], 'INVALID_RANGE'],
    [['update', 'Work', 'event-123', '--start', '2025-01-15T15:00', '--end', '2025-01-15T14:00'], 'INVALID_RANGE'],
    [['update', 'Work', 'event-123', '--start', '2025-01-15T14:00', '--end', '2025-01-15T14:00'], 'INVALID_RANGE'],
    [['update', 'Work', 'event-123', '--all-day', '--start', '2025-01-15'], 'INVALID_ARGUMENT'],
    [['update', 'Work', 'event-123', '--all-day', '--start', '2025-01-15T09:00', '--end', '2025-01-16T09:00'], 'INVALID_DATETIME'],
    [['update', 'Work', 'event-123', '--no-all-day', '--start', '2025-01-15', '--end', '2025-01-15'], 'INVALID_DATETIME'],
    [['events', 'Work', '--from', ''], 'INVALID_DATETIME'],
    [['freebusy', '--calendar', 'Work', '--from', '', '--to', '2025-01-16'], 'INVALID_DATETIME'],
    [['create', 'Work', '--summary', 'Meeting', '--start', '', '--end', '2025-01-16T10:00'], 'INVALID_DATETIME'],
    [['update', 'Work', 'event-123', '--start', '', '--end', '2025-01-16T10:00'], 'INVALID_DATETIME'],
  ])('rejects invalid boundary input %#', (args, code) => {
    expectValidation(args, code);
  });

  test('preserves max zero and permits same-day all-day creation', () => {
    const listed = runCli(['events', 'Work', '--max', '0']);
    expect(listed.status).toBe(0);
    expect(JSON.parse(listed.stdout).count).toBe(0);

    const created = runCli([
      'create', 'Work', '--summary', 'Holiday', '--start', '2025-01-15', '--end', '2025-01-15', '--all-day',
    ]);
    expect(created.status).toBe(0);
    expect(JSON.parse(created.stdout).event.id).toBe('event-created');
  });

  test('permits same-day date-only updates until the existing all-day mode is resolved', () => {
    const updated = runCli([
      'update', 'Work', 'event-123', '--start', '2025-01-15', '--end', '2025-01-15',
    ]);
    expect(updated.status).toBe(0);
    expect(JSON.parse(updated.stdout).event.id).toBe('event-updated');
  });
});

describe('large output', () => {
  test('writes JSON larger than the 64 KB pipe buffer completely before exiting', () => {
    const events = Array.from({ length: 1500 }, (_, i) => ({
      id: `event-${i}`,
      summary: `Event number ${i} with a reasonably long title to pad the payload`,
      start: '2026-01-01T09:00:00',
      end: '2026-01-01T10:00:00',
    }));
    const payload = JSON.stringify({ ok: true, count: events.length, truncated: false, events });
    expect(payload.length).toBeGreaterThan(150000);

    const result = runCli(['events', 'Work', '--max', '10000'], { env: { ACCLI_MOCK_OSASCRIPT_RESPONSE: payload } });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).events).toHaveLength(1500);
  });
});

describe('recurring occurrence targeting', () => {
  function echoArgs(args) {
    const result = runCli(args, { env: { ACCLI_MOCK_ECHO_ARGS: '1' } });
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout).echoedArgs;
  }

  test.each([
    [['delete', 'Work', 'event-123', '--span', 'sometimes'], 'INVALID_ARGUMENT', /Invalid --span/],
    [['update', 'Work', 'event-123', '--span', 'all', '--occurrence-date', '2026-09-21'], 'INVALID_ARGUMENT', /--span all/],
    [['delete', 'Work', 'event-123', '--occurrence-date', '2026-13-01'], 'INVALID_DATETIME', /--occurrence-date/],
    [['delete', 'Work', 'event-123', '--occurrence-date', 'tomorrow'], 'INVALID_DATETIME', /--occurrence-date/],
    [['event', 'Work', 'event-123', '--span', 'all'], 'INVALID_ARGUMENT', /Unknown flag: --span/],
    [['delete', 'Work', 'event-123', '--span', 'this', '--span', 'all'], 'INVALID_ARGUMENT', /only be specified once: --span/],
  ])('rejects invalid occurrence input %#', (args, code, message) => {
    const result = runCli(args);
    expect(result.status).toBe(2);
    const data = JSON.parse(result.stdout);
    expect(data.error.code).toBe(code);
    expect(data.error.message).toMatch(message);
  });

  test('passes occurrence date and span to delete, update, and event scripts', () => {
    expect(echoArgs(['delete', 'Work', 'event-123', '--occurrence-date', '2026-09-21T16:00:00', '--span', 'future']))
      .toMatchObject({ eventId: 'event-123', occurrenceDate: '2026-09-21T16:00:00', span: 'future' });
    expect(echoArgs(['update', 'Work', 'event-123', '--occurrence-date', '2026-09-21', '--summary', 'X']))
      .toMatchObject({ eventId: 'event-123', occurrenceDate: '2026-09-21', span: null, summary: 'X' });
    expect(echoArgs(['delete', 'Work', 'event-123', '--span', 'all']))
      .toMatchObject({ occurrenceDate: null, span: 'all' });
    expect(echoArgs(['event', 'Work', 'event-123', '--occurrence-date', '2026-09-21T16:00']))
      .toMatchObject({ eventId: 'event-123', occurrenceDate: '2026-09-21T16:00' });
  });

  test.each([
    ['OCCURRENCE_REQUIRED', 2],
    ['AMBIGUOUS_OCCURRENCE', 2],
    ['OCCURRENCE_NOT_FOUND', 1],
  ])('maps %s from the script to exit code %i', (code, exitCode) => {
    const payload = JSON.stringify({ ok: false, error: { code, message: 'recurring' } });
    const result = runCli(['delete', 'Work', 'event-123'], { env: { ACCLI_MOCK_OSASCRIPT_RESPONSE: payload } });
    expect(result.status).toBe(exitCode);
    expect(JSON.parse(result.stdout).error.code).toBe(code);
  });
});

describe('EVENT_NOT_FOUND returns proper error (regression test)', () => {
  test('event command returns exit code 1 for EVENT_NOT_FOUND', () => {
    const tmp = makeTempHome();
    try {
      const r = runCli(['event', 'Work', 'nonexistent', '--json'], { env: { ACCLI_CONFIG_PATH: path.join(tmp.dir, '.acclirc') } });
      expect(r.status).toBe(1); // runtime error, not 0
      const data = JSON.parse(r.stdout);
      expect(data.ok).toBe(false);
      expect(data.error.code).toBe('EVENT_NOT_FOUND');
    } finally {
      tmp.cleanup();
    }
  });
});

describe('--json flag works for validation failures (regression test)', () => {
  test('validation errors output JSON when --json is passed', () => {
    const tmp = makeTempHome();
    try {
      const r = runCli(['create', '--json'], { env: { ACCLI_CONFIG_PATH: path.join(tmp.dir, '.acclirc') } });
      expect(r.status).toBe(2);
      // Should be valid JSON, not plain text error
      const data = JSON.parse(r.stdout);
      expect(data.ok).toBe(false);
      expect(data.error).toBeDefined();
    } finally {
      tmp.cleanup();
    }
  });
});
