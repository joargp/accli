'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const SCRIPTS_DIR = path.join(__dirname, '..', 'scripts');

// Exit codes
const EXIT_SUCCESS = 0;
const EXIT_RUNTIME_ERROR = 1;
const EXIT_VALIDATION_ERROR = 2;
const EXIT_NOT_AUTHORIZED = 10;

// Error codes
const ERROR_CODES = {
  NOT_AUTHORIZED: 'NOT_AUTHORIZED',
  CALENDAR_NOT_FOUND: 'CALENDAR_NOT_FOUND',
  AMBIGUOUS_CALENDAR: 'AMBIGUOUS_CALENDAR',
  EVENT_NOT_FOUND: 'EVENT_NOT_FOUND',
  INVALID_DATETIME: 'INVALID_DATETIME',
  INVALID_RANGE: 'INVALID_RANGE',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  MISSING_REQUIRED: 'MISSING_REQUIRED',
  JXA_ERROR: 'JXA_ERROR',
  PARSE_ERROR: 'PARSE_ERROR',
};

/**
 * Check if an error message indicates authorization failure
 */
function isAuthorizationError(stderr) {
  return (
    stderr.includes('-1743') ||
    stderr.includes('-1744') ||
    stderr.includes('Not authorized to send Apple events') ||
    stderr.includes('EKErrorDomain') ||
    stderr.toLowerCase().includes('not authorized')
  );
}

/**
 * Run a JXA script with the given arguments
 * @param {string} scriptName - Name of the script (without .jxa extension)
 * @param {object} args - Arguments to pass to the script as JSON
 * @returns {Promise<{success: boolean, data?: any, error?: {code: string, message: string}, exitCode: number}>}
 */
function runScript(scriptName, args = {}) {
  return new Promise((resolve) => {
    const scriptPath = path.join(SCRIPTS_DIR, `${scriptName}.jxa`);

    if (!fs.existsSync(scriptPath)) {
      resolve({
        success: false,
        error: {
          code: ERROR_CODES.JXA_ERROR,
          message: `Script not found: ${scriptName}.jxa`,
        },
        exitCode: EXIT_RUNTIME_ERROR,
      });
      return;
    }

    const scriptContent = fs.readFileSync(scriptPath, 'utf8');

    // Inject the arguments as a JSON string at the top of the script
    const argsJson = JSON.stringify(args);
    const wrappedScript = `var __args = ${argsJson};\n${scriptContent}`;

    const proc = spawn('osascript', ['-l', 'JavaScript', '-e', wrappedScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      // Check for authorization errors first
      if (isAuthorizationError(stderr)) {
        resolve({
          success: false,
          error: {
            code: ERROR_CODES.NOT_AUTHORIZED,
            message:
              'Calendar access not granted. Run "accli setup" and ensure Full Access (not Add Only) is enabled in System Settings > Privacy & Security > Calendars for the responsible app (often "osascript" and/or your terminal).',
          },
          exitCode: EXIT_NOT_AUTHORIZED,
        });
        return;
      }

      // Try to parse stdout as JSON
      const trimmedOutput = stdout.trim();

      if (!trimmedOutput) {
        // No output - check if there was an error
        if (stderr.trim()) {
          resolve({
            success: false,
            error: {
              code: ERROR_CODES.JXA_ERROR,
              message: stderr.trim(),
            },
            exitCode: EXIT_RUNTIME_ERROR,
          });
        } else if (code !== 0) {
          resolve({
            success: false,
            error: {
              code: ERROR_CODES.JXA_ERROR,
              message: `Script exited with code ${code}`,
            },
            exitCode: EXIT_RUNTIME_ERROR,
          });
        } else {
          // Success with no output
          resolve({
            success: true,
            data: null,
            exitCode: EXIT_SUCCESS,
          });
        }
        return;
      }

      try {
        const data = JSON.parse(trimmedOutput);

        // Check if the script returned an error
        if (data.ok === false && data.error) {
          const exitCode = getExitCodeForError(data.error.code);
          resolve({
            success: false,
            error: data.error,
            exitCode,
          });
        } else {
          resolve({
            success: true,
            data,
            exitCode: EXIT_SUCCESS,
          });
        }
      } catch (parseError) {
        resolve({
          success: false,
          error: {
            code: ERROR_CODES.PARSE_ERROR,
            message: `Failed to parse JXA output: ${trimmedOutput.substring(0, 200)}`,
          },
          exitCode: EXIT_RUNTIME_ERROR,
        });
      }
    });

    proc.on('error', (err) => {
      resolve({
        success: false,
        error: {
          code: ERROR_CODES.JXA_ERROR,
          message: `Failed to execute osascript: ${err.message}`,
        },
        exitCode: EXIT_RUNTIME_ERROR,
      });
    });
  });
}

/**
 * Get the appropriate exit code for an error code
 */
function getExitCodeForError(errorCode) {
  switch (errorCode) {
    case ERROR_CODES.NOT_AUTHORIZED:
      return EXIT_NOT_AUTHORIZED;
    case ERROR_CODES.INVALID_DATETIME:
    case ERROR_CODES.INVALID_RANGE:
    case ERROR_CODES.INVALID_ARGUMENT:
    case ERROR_CODES.MISSING_REQUIRED:
    case ERROR_CODES.AMBIGUOUS_CALENDAR:
      return EXIT_VALIDATION_ERROR;
    default:
      return EXIT_RUNTIME_ERROR;
  }
}

module.exports = {
  runScript,
  ERROR_CODES,
  EXIT_SUCCESS,
  EXIT_RUNTIME_ERROR,
  EXIT_VALIDATION_ERROR,
  EXIT_NOT_AUTHORIZED,
};
