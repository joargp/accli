'use strict';

const { EventEmitter } = require('events');

function makeFakeProcess({ stdout = '', stderr = '', closeCode = 0, emitError = null }) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();

  process.nextTick(() => {
    if (emitError) {
      proc.emit('error', emitError);
      return;
    }
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
    if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
    proc.emit('close', closeCode);
  });

  return proc;
}

describe('lib/jxa-runner', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('returns JXA_ERROR when script is missing', async () => {
    jest.doMock('child_process', () => ({ spawn: jest.fn() }));
    const { runScript, ERROR_CODES, EXIT_RUNTIME_ERROR } = require('../lib/jxa-runner');

    const result = await runScript('__definitely_missing__', {});
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(EXIT_RUNTIME_ERROR);
    expect(result.error.code).toBe(ERROR_CODES.JXA_ERROR);
    expect(result.error.message).toMatch(/Script not found/);
  });

  test('wraps args into script and parses JSON stdout', async () => {
    const spawnMock = jest.fn((cmd, args) => {
      expect(cmd).toBe('osascript');
      expect(args[0]).toBe('-l');
      expect(args[1]).toBe('JavaScript');
      expect(args[2]).toBe('-e');
      expect(String(args[3])).toMatch(/^var __args = {"foo":"bar"};\n/);
      return makeFakeProcess({
        stdout: JSON.stringify({ ok: true, calendars: [] }),
        closeCode: 0,
      });
    });
    jest.doMock('child_process', () => ({ spawn: spawnMock }));

    const { runScript, EXIT_SUCCESS } = require('../lib/jxa-runner');
    const result = await runScript('calendars', { foo: 'bar' });

    expect(result).toEqual({
      success: true,
      data: { ok: true, calendars: [] },
      exitCode: EXIT_SUCCESS,
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  test('maps script error codes to validation exit code', async () => {
    const spawnMock = jest.fn(() =>
      makeFakeProcess({
        stdout: JSON.stringify({ ok: false, error: { code: 'INVALID_ARGUMENT', message: 'nope' } }),
        closeCode: 0,
      })
    );
    jest.doMock('child_process', () => ({ spawn: spawnMock }));

    const { runScript, EXIT_VALIDATION_ERROR } = require('../lib/jxa-runner');
    const result = await runScript('calendars', {});

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(EXIT_VALIDATION_ERROR);
    expect(result.error).toEqual({ code: 'INVALID_ARGUMENT', message: 'nope' });
  });

  test('returns NOT_AUTHORIZED when stderr indicates authorization failure', async () => {
    const spawnMock = jest.fn(() =>
      makeFakeProcess({
        stdout: '',
        stderr: 'execution error: Not authorized to send Apple events to Calendar. (-1743)\n',
        closeCode: 1,
      })
    );
    jest.doMock('child_process', () => ({ spawn: spawnMock }));

    const { runScript, ERROR_CODES, EXIT_NOT_AUTHORIZED } = require('../lib/jxa-runner');
    const result = await runScript('calendars', {});

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(EXIT_NOT_AUTHORIZED);
    expect(result.error.code).toBe(ERROR_CODES.NOT_AUTHORIZED);
    expect(result.error.message).toMatch(/Calendar access not granted/);
  });

  test('returns PARSE_ERROR when stdout is not JSON', async () => {
    const spawnMock = jest.fn(() =>
      makeFakeProcess({
        stdout: 'this is not json',
        stderr: '',
        closeCode: 0,
      })
    );
    jest.doMock('child_process', () => ({ spawn: spawnMock }));

    const { runScript, ERROR_CODES, EXIT_RUNTIME_ERROR } = require('../lib/jxa-runner');
    const result = await runScript('calendars', {});

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(EXIT_RUNTIME_ERROR);
    expect(result.error.code).toBe(ERROR_CODES.PARSE_ERROR);
  });

  test('returns JXA_ERROR when osascript cannot be executed', async () => {
    const spawnMock = jest.fn(() =>
      makeFakeProcess({
        emitError: new Error('spawn EPERM'),
      })
    );
    jest.doMock('child_process', () => ({ spawn: spawnMock }));

    const { runScript, ERROR_CODES, EXIT_RUNTIME_ERROR } = require('../lib/jxa-runner');
    const result = await runScript('calendars', {});

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(EXIT_RUNTIME_ERROR);
    expect(result.error.code).toBe(ERROR_CODES.JXA_ERROR);
    expect(result.error.message).toMatch(/Failed to execute osascript/);
  });
});
