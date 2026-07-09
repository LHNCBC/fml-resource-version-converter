/**
 * @fileoverview Runtime status and diagnostic-message helpers.
 */

export const STATUS = Object.freeze({
  OK: 'ok',
  WARNING: 'warning',
});

export const MESSAGE_TYPE = Object.freeze({
  INFO: 'info',
  WARNING: 'warning',
});

const VALID_STATUSES = new Set(Object.values(STATUS));
const VALID_MESSAGE_TYPES = new Set(Object.values(MESSAGE_TYPE));

const STATUS_RANK = new Map([
  [STATUS.OK, 0],
  [STATUS.WARNING, 1],
]);

/**
 * Return whether a value is a valid runtime status.
 *
 * @param {string} value Value to test.
 * @returns {boolean} True when value is a valid status.
 */
export function isStatus(value) {
  return VALID_STATUSES.has(value);
}

/**
 * Return whether a value is a valid diagnostic message type.
 *
 * @param {string} value Value to test.
 * @returns {boolean} True when value is a valid message type.
 */
export function isMessageType(value) {
  return VALID_MESSAGE_TYPES.has(value);
}

/**
 * Validate a runtime status.
 *
 * @param {string} status Runtime status.
 * @param {string} [label='status'] Human-readable field label.
 * @throws {Error} If status is invalid.
 */
export function assertStatus(status, label = 'status') {
  if (!isStatus(status)) throw new Error(`Invalid ${label}: ${status}`);
}

/**
 * Build a diagnostic message.
 *
 * Extra fields are preserved to allow callers to attach context/location data.
 * The validated type/text are applied last so they cannot be overridden by
 * anything in extra.
 *
 * @param {'info'|'warning'} type Message type.
 * @param {string} text Human-readable message text.
 * @param {Object} [extra] Additional message fields.
 * @returns {{type: string, text: string}} Message object.
 */
export function makeMessage(type, text, extra = {}) {
  if (!isMessageType(type)) throw new Error(`Invalid message type: ${type}`);
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('Message text must be a non-empty string');
  }

  return { ...extra, type, text };
}

/**
 * Build an info diagnostic message.
 *
 * @param {string} text Human-readable message text.
 * @param {Object} [extra] Additional message fields.
 * @returns {{type: string, text: string}} Message object.
 */
export function infoMessage(text, extra = {}) {
  return makeMessage(MESSAGE_TYPE.INFO, text, extra);
}

/**
 * Build a warning diagnostic message.
 *
 * @param {string} text Human-readable message text.
 * @param {Object} [extra] Additional message fields.
 * @returns {{type: string, text: string}} Message object.
 */
export function warningMessage(text, extra = {}) {
  return makeMessage(MESSAGE_TYPE.WARNING, text, extra);
}

/**
 * Return whether a message array contains at least one warning.
 *
 * Tolerant of null/undefined and non-arrays.
 *
 * @param {Array<Object>|null|undefined} messages Messages to inspect.
 * @returns {boolean} True when at least one warning message is present.
 */
export function hasWarningMessage(messages) {
  return Array.isArray(messages)
    && messages.some(message => message?.type === MESSAGE_TYPE.WARNING);
}

/**
 * Validate the processor result status/message invariant.
 *
 * If status is warning, there must be at least one warning message. Warning
 * messages may also appear with status ok. Message shape itself is not
 * validated here (messages are advisory diagnostics, not a critical component).
 *
 * @param {string} status Runtime status.
 * @param {Array<Object>|null|undefined} messages Diagnostic messages.
 * @param {string} [label='result'] Human-readable object label.
 * @throws {Error} If status is invalid or the warning-message invariant fails.
 */
export function assertWarningInvariant(status, messages, label = 'result') {
  assertStatus(status, `${label}.status`);
  if (status === STATUS.WARNING && !hasWarningMessage(messages)) {
    throw new Error(`${label}.status is warning but no warning message was provided`);
  }
}

/**
 * Return the higher-severity status.
 *
 * @param {string} left First status.
 * @param {string} right Second status.
 * @returns {string} Higher-severity status.
 */
export function maxStatus(left, right) {
  assertStatus(left, 'left status');
  assertStatus(right, 'right status');
  return STATUS_RANK.get(left) >= STATUS_RANK.get(right) ? left : right;
}

/**
 * Roll up statuses to the highest severity.
 *
 * @param {string[]} statuses Status values to roll up.
 * @returns {string} Highest-severity status, or ok when no statuses are given.
 */
export function rollupStatus(statuses = []) {
  let current = STATUS.OK;
  for (const status of statuses) current = maxStatus(current, status);
  return current;
}

/**
 * Derive engine status from captured engine warning messages.
 *
 * Engine info messages alone do not change status from ok.
 *
 * @param {Array<Object>|undefined} messages Captured engine messages.
 * @returns {'ok'|'warning'} Derived status.
 */
export function statusFromMessages(messages) {
  return hasWarningMessage(messages) ? STATUS.WARNING : STATUS.OK;
}


