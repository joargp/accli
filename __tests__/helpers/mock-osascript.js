'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const { EventEmitter } = require('events');

const realSpawn = childProcess.spawn;

function respondForWrappedScript(wrappedScript) {
  if (process.env.ACCLI_MOCK_OSASCRIPT_RESPONSE) {
    return JSON.parse(process.env.ACCLI_MOCK_OSASCRIPT_RESPONSE);
  }
  const match = /^var __accliScriptName = ("(?:[^"\\]|\\.)*");$/m.exec(wrappedScript);
  const scriptName = match ? JSON.parse(match[1]) : null;

  if (scriptName === 'calendars') {
    return { ok: true, calendars: [{ name: 'Work', source: 'iCloud', id: 'CAL1', index: 0, writable: true }] };
  }
  if (scriptName === 'setup') {
    return { ok: true, message: 'ok', calendars: ['Work'] };
  }
  if (scriptName === 'events') {
    return { ok: true, count: 0, truncated: false, events: [] };
  }
  if (scriptName === 'event') {
    return { ok: false, error: { code: 'EVENT_NOT_FOUND', message: 'missing' } };
  }
  if (scriptName === 'freebusy') {
    return { ok: true, busy: [] };
  }
  if (scriptName === 'create') return { ok: true, event: { id: 'event-created', calendar: 'Work' } };
  if (scriptName === 'update') return { ok: true, event: { id: 'event-updated', calendar: 'Work' } };
  if (scriptName === 'delete') return { ok: true, deleted: { id: 'event-deleted', calendar: 'Work' } };
  return { ok: true };
}

childProcess.spawn = function patchedSpawn(command, args, options) {
  if (command !== 'osascript') return realSpawn(command, args, options);

  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();

  const scriptPath = Array.isArray(args) ? args[2] : null;
  const wrappedScript = scriptPath ? fs.readFileSync(scriptPath, 'utf8') : '';
  const payload = respondForWrappedScript(String(wrappedScript || ''));

  process.nextTick(() => {
    proc.stdout.emit('data', Buffer.from(JSON.stringify(payload)));
    proc.emit('close', 0);
  });

  return proc;
};
