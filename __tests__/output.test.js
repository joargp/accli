'use strict';

const output = require('../lib/output');

describe('lib/output formatting', () => {
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
      output.outputError({ code: 'NOT_AUTHORIZED', message: 'no' }, { json: false });
      expect(spy.mock.calls.map((c) => c.join(' ')).join('\n')).toMatch(/Tip:/);
    } finally {
      spy.mockRestore();
    }
  });
});
