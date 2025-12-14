'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function withTempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accli-home-'));
  const prevConfigPath = process.env.ACCLI_CONFIG_PATH;
  process.env.ACCLI_CONFIG_PATH = path.join(dir, '.acclirc');
  return {
    dir,
    restore() {
      if (prevConfigPath === undefined) delete process.env.ACCLI_CONFIG_PATH;
      else process.env.ACCLI_CONFIG_PATH = prevConfigPath;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('lib/config', () => {
  test('defaults to empty config when missing', () => {
    const tmp = withTempHome();
    try {
      jest.resetModules();
      const config = require('../lib/config');
      expect(config.loadConfig()).toEqual({});
      expect(config.getDefaultCalendarId()).toBeNull();
      expect(config.getConfigPath()).toBe(path.join(tmp.dir, '.acclirc'));
    } finally {
      tmp.restore();
    }
  });

  test('set/get/clear default calendar ID', () => {
    const tmp = withTempHome();
    try {
      jest.resetModules();
      const config = require('../lib/config');

      config.setDefaultCalendarId('CAL-123');
      expect(config.getDefaultCalendarId()).toBe('CAL-123');

      const raw = fs.readFileSync(config.getConfigPath(), 'utf8');
      expect(raw).toMatch(/\"defaultCalendarId\": \"CAL-123\"/);
      expect(raw.endsWith('\n')).toBe(true);

      config.clearDefaultCalendar();
      expect(config.getDefaultCalendarId()).toBeNull();
    } finally {
      tmp.restore();
    }
  });
});
