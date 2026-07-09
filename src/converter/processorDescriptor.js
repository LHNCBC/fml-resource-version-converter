/**
 * @fileoverview Processor descriptor normalization and validation helpers.
 *
 * A processor descriptor is a normalized object that describes a single
 * pre- or post-processor, to facilitate execution, tooling, and reporting.
 *
 * Fields:
 *   - name        (required) short identifier/id, used in the conversion report.
 *   - execute     (required) the conversion function (resource, ctx) -> result.
 *   - description (optional) human-readable note, including any limitations.
 *   - coverage    (postprocessors: optional; preprocessors: not applicable,
 *                 ignored when present) claimed completeness level, see
 *                 coverage.js.
 *
 * Validation is intentionally duck-typed: only the fields the runtime actually
 * depends on are enforced (name and execute; plus coverage when a postprocessor
 * declares one, since it feeds rollups). Unknown or extra fields are ignored.
 * In particular, a stray coverage field on a preprocessor descriptor is not
 * rejected or stripped - it is simply not consulted (no runtime consumer).
 */

import {
  assertCoverageLevel,
  COVERAGE,
} from './coverage.js';

/**
 * Return whether a value is a plain object.
 *
 * @param {*} value Value to test.
 * @returns {boolean} True when value is a non-array object.
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate a processor descriptor's hard invariants.
 *
 * Enforced:
 *   - descriptor is a plain object.
 *   - name is a non-empty string (needed for the conversion report).
 *   - execute is a function (needed to run).
 *   - When allowCoverage and coverage is provided (not null/undefined),
 *     coverage is a valid level (feeds into rollups).
 *
 * @param {Object} descriptor Descriptor to validate.
 * @param {Object} [opts]
 * @param {boolean} [opts.allowCoverage=true] Whether to look at coverage.
 * @param {string} [opts.label='processor'] Human-readable label for use in error messages.
 * @returns {Object} The descriptor passed in.
 * @throws {Error} If a hard invariant is violated.
 */
export function validateProcessorDescriptor(
  descriptor,
  { allowCoverage = true, label = 'processor' } = {},
) {
  if (!isObject(descriptor)) throw new Error(`${label} must be an object`);

  if (typeof descriptor.name !== 'string' || descriptor.name.length === 0) {
    throw new Error(`${label}.name must be a non-empty string`);
  }

  if (typeof descriptor.execute !== 'function') {
    throw new Error(`${label}.execute must be a function`);
  }

  if (allowCoverage && descriptor.coverage != null) {
    assertCoverageLevel(descriptor.coverage, `${label}.coverage`);
  }

  return descriptor;
}

/**
 * Make a postprocessor descriptor from an execute function.
 *
 * This is a convenience constructor: given the function that does the work,
 * it produces a validated descriptor with sensible defaults. It does not
 * accept an existing descriptor; callers who already have one can pass it
 * straight to validateProcessorDescriptor.
 *
 * The descriptor name is required: it must come from opts.name or from
 * execute.name (i.e. a named function). Anonymous functions with no
 * opts.name are rejected so reports never show a blank/placeholder name.
 * It's strongly recommended that a sensible name is used.
 *
 * @param {Function} execute The (resource, ctx) -> result function.
 * @param {Object} [opts]
 * @param {string} [opts.name] Descriptor name. Falls back to execute.name.
 * @param {string} [opts.description] Human-readable description.
 * @param {string} [opts.coverage='neutral'] Coverage level; see coverage.js.
 * @returns {Object} A validated postprocessor descriptor.
 * @throws {Error} If execute is not a function, no name can be resolved,
 *   or opts.coverage is invalid.
 */
export function makeProcessor(execute, opts = {}) {
  if (typeof execute !== 'function') {
    throw new Error('makeProcessor: execute must be a function');
  }
  const name = opts.name || execute.name;
  if (!name) {
    throw new Error('makeProcessor: name is required (pass opts.name or use a named function)');
  }
  const descriptor = {
    name,
    coverage: opts.coverage || COVERAGE.NEUTRAL,
    description: opts.description || 'Caller-provided processor.',
    execute,
  };
  return validateProcessorDescriptor(descriptor);
}



