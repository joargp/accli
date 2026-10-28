'use strict';

function escapeTerminalText(value) {
  if (value === null || value === undefined) return '';

  return String(value)
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, (character) => {
      const code = character.charCodeAt(0);
      return code >= 0x80
        ? `\\u${code.toString(16).padStart(4, '0')}`
        : `\\x${code.toString(16).padStart(2, '0')}`;
    });
}

/**
 * Format a calendar for human-readable output
 */
function formatCalendar(calendar) {
  const indexPart = calendar.index !== undefined ? `, index ${escapeTerminalText(calendar.index)}` : '';
  return `${escapeTerminalText(calendar.name)} (${escapeTerminalText(calendar.id)}${indexPart})`;
}

/**
 * Format calendars list for human-readable output
 */
function formatCalendars(data) {
  if (!data.calendars || data.calendars.length === 0) {
    return 'No calendars found.';
  }
  const lines = ['Calendars:', ''];
  for (const cal of data.calendars) {
    lines.push(`  ${escapeTerminalText(cal.name)}`);
    if (cal.source) {
      lines.push(`    Source: ${escapeTerminalText(cal.source)}`);
    }
    lines.push(`    ID: ${escapeTerminalText(cal.id)}`);
    if (cal.index !== undefined) {
      lines.push(`    Index: ${escapeTerminalText(cal.index)}`);
    }
    if (typeof cal.writable === 'boolean') {
      lines.push(`    Writable: ${cal.writable ? 'yes' : 'no'}`);
    }
  }
  return lines.join('\n');
}

/**
 * Format a datetime for display
 */
function formatDateTime(dateStr, allDay) {
  if (!dateStr) return '';
  const text = String(dateStr);
  if (allDay) {
    // For all-day events, just show the date part
    return escapeTerminalText(text.split('T')[0]);
  }
  // Show date and time
  return escapeTerminalText(text.replace('T', ' '));
}

/**
 * Format a single event for human-readable output
 */
function formatEvent(event, includeCalendar = false) {
  const lines = [];

  let header = event.summary ? escapeTerminalText(event.summary) : '(No title)';
  if (event.allDay) {
    header += ' (all-day)';
  }
  if (event.isRecurring) {
    header += ' [recurring]';
  }
  lines.push(header);

  if (includeCalendar && event.calendar) {
    lines.push(`  Calendar: ${escapeTerminalText(event.calendar)}`);
  }

  const startStr = formatDateTime(event.start, event.allDay);
  let endStr = formatDateTime(event.end, event.allDay);
  if (event.allDay && endStr && startStr && endStr < startStr) {
    endStr = startStr;
  }

  if (event.allDay) {
    if (startStr === endStr) {
      lines.push(`  Date: ${startStr}`);
    } else {
      lines.push(`  Dates: ${startStr} to ${endStr}`);
    }
  } else {
    lines.push(`  Start: ${startStr}`);
    lines.push(`  End: ${endStr}`);
  }

  if (event.location) {
    lines.push(`  Location: ${escapeTerminalText(event.location)}`);
  }

  if (event.description) {
    const desc = event.description.length > 100
      ? event.description.substring(0, 100) + '...'
      : event.description;
    lines.push(`  Description: ${escapeTerminalText(desc)}`);
  }

  lines.push(`  ID: ${escapeTerminalText(event.id)}`);

  return lines.join('\n');
}

/**
 * Format events list for human-readable output
 */
function formatEvents(data) {
  if (!data.events || data.events.length === 0) {
    return 'No events found.';
  }

  const lines = [];
  if (data.truncated) {
    lines.push(`Events (showing ${data.events.length}, truncated):`);
  } else {
    lines.push(`Events (${data.count}):`);
  }
  lines.push('');

  for (const event of data.events) {
    lines.push(formatEvent(event, true));
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

/**
 * Format a single event detail for human-readable output
 */
function formatEventDetail(data) {
  if (!data.event) {
    return 'Event not found.';
  }
  return formatEvent(data.event, true);
}

/**
 * Format setup result for human-readable output
 */
function formatSetup(data) {
  if (data.ok) {
    const lines = [escapeTerminalText(data.message)];
    if (data.calendars && data.calendars.length > 0) {
      lines.push(`Found ${data.calendars.length} calendar(s): ${data.calendars.map(escapeTerminalText).join(', ')}`);
    }
    return lines.join('\n');
  }
  return 'Setup failed.';
}

/**
 * Format create result for human-readable output
 */
function formatCreate(data) {
  if (data.ok && data.event) {
    const lines = ['Event created successfully:', ''];
    lines.push(formatEvent(data.event, true));
    return lines.join('\n');
  }
  return 'Failed to create event.';
}

/**
 * Format update result for human-readable output
 */
function formatUpdate(data) {
  if (data.ok && data.event) {
    const lines = ['Event updated successfully:', ''];
    lines.push(formatEvent(data.event, true));
    if (data.warning) {
      lines.push('');
      lines.push(`Warning: ${escapeTerminalText(data.warning)}`);
    }
    return lines.join('\n');
  }
  return 'Failed to update event.';
}

/**
 * Format delete result for human-readable output
 */
function formatDelete(data) {
  if (data.ok && data.deleted) {
    const { deleted } = data;
    const what = deleted.summary ? `"${escapeTerminalText(deleted.summary)}"` : 'Event';
    const when = deleted.isRecurring && deleted.occurrenceDate
      ? ` (occurrence ${escapeTerminalText(deleted.occurrenceDate)})`
      : '';
    const lines = [`${what}${when} deleted from calendar "${escapeTerminalText(deleted.calendar)}".`];
    if (data.warning) {
      lines.push(`Warning: ${escapeTerminalText(data.warning)}`);
    }
    return lines.join('\n');
  }
  return 'Failed to delete event.';
}

/**
 * Format freebusy result for human-readable output
 */
function formatFreeBusy(data) {
  const lines = [];

  if (data.calendarsNotFound && data.calendarsNotFound.length > 0) {
    lines.push(`Calendars not found: ${data.calendarsNotFound.map(escapeTerminalText).join(', ')}`);
    lines.push('');
  }

  if (!data.busy || data.busy.length === 0) {
    lines.push('No busy time slots found.');
    return lines.join('\n');
  }

  lines.push(`Busy time slots (${data.busy.length}):`);
  lines.push('');

  for (const slot of data.busy) {
    const startStr = formatDateTime(slot.start, false);
    const endStr = formatDateTime(slot.end, false);
    lines.push(`  ${startStr} - ${endStr}`);
    lines.push(`    ${slot.summary ? escapeTerminalText(slot.summary) : '(No title)'} [${escapeTerminalText(slot.calendar)}]`);
  }

  return lines.join('\n');
}

/**
 * Format an error for human-readable output
 */
function formatError(error) {
  return `Error [${escapeTerminalText(error.code)}]: ${escapeTerminalText(error.message)}`;
}

/**
 * Output result. JSON is the deterministic default; human output is opt-in.
 */
function output(data, options = {}) {
  const { human = false, compact = false, formatter = null } = options;

  if (human && formatter) {
    console.log(formatter(data));
  } else {
    console.log(JSON.stringify(data, null, compact ? 0 : 2));
  }
}

/**
 * Output errors. JSON errors go to stdout; human errors go to stderr.
 */
function outputError(error, options = {}) {
  const { human = false, compact = false } = options;

  if (human) {
    console.error(formatError(error));
    if (error && error.code === 'NOT_AUTHORIZED') {
      console.error(
        'Tip: On recent macOS versions this can be set to "Add Only". In System Settings > Privacy & Security > Calendars, click Options… and set "Full Access" for your terminal and/or "osascript".'
      );
    }
  } else {
    console.log(JSON.stringify({ ok: false, error }, null, compact ? 0 : 2));
  }
}

module.exports = {
  escapeTerminalText,
  formatCalendars,
  formatEvents,
  formatEventDetail,
  formatSetup,
  formatCreate,
  formatUpdate,
  formatDelete,
  formatFreeBusy,
  formatError,
  output,
  outputError,
};
