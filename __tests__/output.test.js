'use strict';

const output = require('../lib/output');

describe('lib/output formatting', () => {
  test('exports terminal escaping for human-only command paths', () => {
    expect(output.escapeTerminalText('Name\x1b[31m\nSource\r\tID\u009b')).toBe('Name\\x1b[31m\\nSource\\r\\tID\\u009b');
  });

  test('formatCalendars includes key fields', () => {
    const text = output.formatCalendars({
      calendars: [
        { name: 'Work', source: 'iCloud', id: 'CAL1', index: 0, writable: true },
        { name: 'ReadOnly', source: 'Local', id: 'CAL2', writable: false },
      ],
    });
    expect(text).toMatch(/Calendars:/);
    expect(text).toMatch(/Work/);
    expect(text).toMatch(/Source: iCloud/);
    expect(text).toMatch(/ID: CAL1/);
    expect(text).toMatch(/Index: 0/);
    expect(text).toMatch(/Writable: yes/);
    expect(text).toMatch(/Writable: no/);
  });

  test('formatEvents renders all-day and timed events', () => {
    const text = output.formatEvents({
      count: 2,
      truncated: false,
      events: [
        {
          id: 'E1',
          summary: 'All day thing',
          allDay: true,
          start: '2025-01-01T00:00:00Z',
          end: '2025-01-01T00:00:00Z',
          calendar: 'Work',
          isRecurring: false,
        },
        {
          id: 'E2',
          summary: 'Meeting',
          allDay: false,
          start: '2025-01-01T10:00:00.000Z',
          end: '2025-01-01T11:00:00.000Z',
          calendar: 'Work',
          isRecurring: true,
          location: 'Room 1',
          description: 'A'.repeat(120),
        },
      ],
    });

    expect(text).toMatch(/Events \(2\):/);
    expect(text).toMatch(/All day thing \(all-day\)/);
    expect(text).toMatch(/Date:/);
    expect(text).toMatch(/Meeting \[recurring\]/);
    expect(text).toMatch(/Start:/);
    expect(text).toMatch(/End:/);
    expect(text).toMatch(/Location: Room 1/);
    expect(text).toMatch(/Description: A+\.\.\./);
  });

  test('formatEvents does not render inverted all-day date ranges', () => {
    const text = output.formatEvents({
      count: 1,
      truncated: false,
      events: [
        {
          id: 'E1',
          summary: 'Vacation',
          allDay: true,
          start: '2026-03-13',
          end: '2026-03-12',
          calendar: 'Work',
        },
      ],
    });

    expect(text).toMatch(/Date: 2026-03-13/);
    expect(text).not.toMatch(/Dates: 2026-03-13 to 2026-03-12/);
  });

  test('outputError prints NOT_AUTHORIZED tip in human mode', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      output.outputError({ code: 'NOT_AUTHORIZED', message: 'no' }, { human: true });
      expect(spy.mock.calls.map((c) => c.join(' ')).join('\n')).toMatch(/Tip:/);
    } finally {
      spy.mockRestore();
    }
  });

  test('output uses pretty JSON by default and compact JSON when requested', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      output.output({ calendar: 'Work' });
      output.output({ calendar: 'Work' }, { compact: true });
      expect(spy.mock.calls[0][0]).toBe('{\n  "calendar": "Work"\n}');
      expect(spy.mock.calls[1][0]).toBe('{"calendar":"Work"}');
    } finally {
      spy.mockRestore();
    }
  });

  test('outputError uses JSON stdout by default and human stderr on request', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      output.outputError({ code: 'INVALID_ARGUMENT', message: 'bad' });
      output.outputError({ code: 'INVALID_ARGUMENT', message: 'bad' }, { human: true });
      expect(log.mock.calls[0][0]).toBe('{\n  "ok": false,\n  "error": {\n    "code": "INVALID_ARGUMENT",\n    "message": "bad"\n  }\n}');
      expect(error.mock.calls[0][0]).toBe('Error [INVALID_ARGUMENT]: bad');
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  test('escapes terminal controls in every human formatter family while preserving Unicode', () => {
    const ansi = '\x1b[31mred\x1b[0m';
    const osc = '\x1b]8;;https://example.test\x07link\x1b]8;;\x07';
    const controls = `line\nnext\rreset\tcolumn\u009bDEL\x7f`;
    const outputs = [
      output.formatCalendars({ calendars: [{ name: ansi, source: osc, id: controls, index: '\u009b', writable: true }] }),
      output.formatEvents({ count: 1, events: [{ summary: ansi, calendar: osc, start: controls, end: controls, location: controls, description: `${controls}😀`, id: controls }] }),
      output.formatSetup({ ok: true, message: controls, calendars: [ansi, 'Møte 😀'] }),
      output.formatUpdate({ ok: true, event: { summary: 'Møte 😀', start: controls, end: controls, id: controls }, warning: osc }),
      output.formatDelete({ ok: true, deleted: { calendar: ansi }, warning: controls }),
      output.formatFreeBusy({ calendarsNotFound: [ansi], busy: [{ start: controls, end: controls, summary: osc, calendar: 'Møte 😀' }] }),
      output.formatError({ code: ansi, message: controls }),
    ];

    for (const text of outputs) {
      expect(text).not.toMatch(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F-\x9F]/);
      expect(text).toContain('\\x1b');
    }
    expect(outputs.join('\n')).toContain('Møte 😀');
    expect(outputs[1].split('\n')).not.toContain('next');
  });

  test('keeps raw controls in JSON while escaping explicit human output and errors', () => {
    const payload = { value: '\x1b[31mred\x1b[0m\nnext' };
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      output.output(payload);
      expect(JSON.parse(log.mock.calls[0][0])).toEqual(payload);

      output.output(payload, {
        human: true,
        formatter: (data) => output.formatEventDetail({
          event: { summary: data.value, start: '2025-01-01T10:00', end: '2025-01-01T11:00', id: 'event-1' },
        }),
      });
      expect(log.mock.calls[1][0]).toContain('\\x1b[31mred\\x1b[0m\\nnext');

      output.outputError({ code: '\x1b[31mBAD', message: payload.value });
      expect(JSON.parse(log.mock.calls[2][0]).error.message).toBe(payload.value);

      output.outputError({ code: '\x1b[31mBAD', message: payload.value }, { human: true });
      expect(error.mock.calls[0][0]).toContain('\\x1b');
      expect(error.mock.calls[0][0]).not.toContain('\x1b');
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});

describe('formatDelete', () => {
  test('names the deleted occurrence of a recurring event', () => {
    const text = output.formatDelete({
      ok: true,
      deleted: { calendar: 'Work', summary: 'Standup', isRecurring: true, occurrenceDate: '2026-09-21T16:00:00', span: 'this' },
      warning: null,
    });
    expect(text).toBe('"Standup" (occurrence 2026-09-21T16:00:00) deleted from calendar "Work".');
  });

  test('omits occurrence details for single events', () => {
    const text = output.formatDelete({ ok: true, deleted: { calendar: 'Work', summary: 'Lunch', isRecurring: false } });
    expect(text).toBe('"Lunch" deleted from calendar "Work".');
  });
});
