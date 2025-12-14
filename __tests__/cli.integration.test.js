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

  test('no args shows help and exits with validation error', () => {
    const r = runCli([]);
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/USAGE:/);
  });

  test('unknown command exits with validation error', () => {
    const r = runCli(['nope']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Unknown command/);
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
      expect(data.error.message).toMatch(/Too many positional arguments/);
    } finally {
      tmp.cleanup();
    }
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
