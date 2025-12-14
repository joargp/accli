'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function computeConfigPath() {
  if (process.env.ACCLI_CONFIG_PATH) {
    return process.env.ACCLI_CONFIG_PATH;
  }
  if (process.env.ACCLI_HOME) {
    return path.join(process.env.ACCLI_HOME, '.acclirc');
  }
  return path.join(os.homedir(), '.acclirc');
}

/**
 * Load config from ~/.acclirc
 * @returns {Object} Config object (empty object if file doesn't exist)
 */
function loadConfig() {
  const CONFIG_PATH = computeConfigPath();
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      return {};
    }
    const content = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {};
    }
    throw new Error(`Failed to read config from ${CONFIG_PATH}: ${err.message}`);
  }
}

/**
 * Save config to ~/.acclirc
 * @param {Object} config - Config object to save
 */
function saveConfig(config) {
  const CONFIG_PATH = computeConfigPath();
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
  } catch (err) {
    throw new Error(`Failed to write config to ${CONFIG_PATH}: ${err.message}`);
  }
}

/**
 * Get default calendar ID from config
 * @returns {string|null} Default calendar ID or null if not set
 */
function getDefaultCalendarId() {
  const config = loadConfig();
  return config.defaultCalendarId || null;
}

/**
 * Set default calendar ID in config
 * @param {string} calendarId - Calendar ID to set as default
 */
function setDefaultCalendarId(calendarId) {
  const config = loadConfig();
  config.defaultCalendarId = calendarId;
  saveConfig(config);
}

/**
 * Clear default calendar from config
 */
function clearDefaultCalendar() {
  const config = loadConfig();
  delete config.defaultCalendarId;
  saveConfig(config);
}

/**
 * Get the config file path
 * @returns {string} Path to config file
 */
function getConfigPath() {
  return computeConfigPath();
}

module.exports = {
  loadConfig,
  saveConfig,
  getDefaultCalendarId,
  setDefaultCalendarId,
  clearDefaultCalendar,
  getConfigPath,
};
