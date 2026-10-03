// Every failure JARVIS reports carries a machine-readable code so the UI can
// show the right state (reconnect button, missing-field prompt, etc).
export class JarvisError extends Error {
  constructor(code, message, { status = 400, hint } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.hint = hint;
  }
}

export const Codes = {
  INTEGRATION_UNAVAILABLE: 'INTEGRATION_UNAVAILABLE',
  AUTH_EXPIRED: 'AUTH_EXPIRED',
  MISSING_FIELD: 'MISSING_FIELD',
  CALENDAR_FAILED: 'CALENDAR_FAILED',
  UPLOAD_FAILED: 'UPLOAD_FAILED',
  DRIVE_FAILED: 'DRIVE_FAILED',
  SEND_FAILED: 'SEND_FAILED',
  NOT_FOUND: 'NOT_FOUND',
};

export function requireFields(obj, fields, what) {
  const missing = fields.filter((f) => obj[f] === undefined || obj[f] === null || obj[f] === '');
  if (missing.length) {
    throw new JarvisError(Codes.MISSING_FIELD, `${what} is missing: ${missing.join(', ')}.`, {
      hint: missing,
    });
  }
}
