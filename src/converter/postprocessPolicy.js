/**
 * @fileoverview Postprocessor combination policy.
 *
 * When a caller supplies their own postprocessors for a hop, this policy decides
 * how those combine with the package registry's postprocessors for the same hop:
 *   - append  (default): registry processors first, then the caller's.
 *   - replace:           the caller's processors only (registry's are dropped).
 *
 * Owning both the enum and the combine logic here keeps the rule in one place,
 * shared by the single-hop entry point and the future multi-hop convert().
 *
 * @module converter/postprocessPolicy
 */

export const POSTPROCESS_POLICY = Object.freeze({
  APPEND: 'append',
  REPLACE: 'replace',
});

const VALID_POLICIES = new Set(Object.values(POSTPROCESS_POLICY));

/**
 * Return whether a value is a valid postprocess policy.
 *
 * @param {string} value Value to test.
 * @returns {boolean} True when value is a known policy.
 */
export function isPostprocessPolicy(value) {
  return VALID_POLICIES.has(value);
}

/**
 * Validate a postprocess policy.
 *
 * @param {string} policy Policy to validate.
 * @param {string} [label='postprocessPolicy'] Human-readable field label.
 * @throws {Error} If policy is not a known value.
 */
export function assertPostprocessPolicy(policy, label = 'postprocessPolicy') {
  if (!isPostprocessPolicy(policy)) {
    throw new Error(`Invalid ${label}: ${policy} (expected 'append' or 'replace')`);
  }
}

/**
 * Combine registry and caller postprocessors according to the policy.
 *
 * The caller list distinguishes "not supplied" from "supplied empty":
 *   - null/undefined: the caller supplied nothing, so the registry list is used
 *     as-is (the package default) and the policy is moot.
 *   - an array (possibly empty): the caller supplied a value, so the policy
 *     applies. append yields `[...registry, ...caller]`; replace yields the
 *     caller's list only - so `replace` with `[]` intentionally removes the
 *     registry's postprocessors (run none).
 * A fresh array is always returned so callers can mutate it safely.
 *
 * @param {Array<Object>} [registryProcs=[]] Package registry postprocessors.
 * @param {Array<Object>|null} [callerProcs]  Caller postprocessors, or
 *   null/undefined when the caller supplied none.
 * @param {string} [policy='append']          See POSTPROCESS_POLICY.
 * @returns {Array<Object>} The combined postprocessor list.
 * @throws {Error} If policy is not a known value.
 */
export function resolvePostprocessors(
  registryProcs = [],
  callerProcs,
  policy = POSTPROCESS_POLICY.APPEND,
) {
  assertPostprocessPolicy(policy);

  // Not supplied -> registry defaults; the policy does not apply.
  if (callerProcs == null) return [...registryProcs];

  // Supplied (possibly empty) -> the policy applies literally.
  if (policy === POSTPROCESS_POLICY.REPLACE) return [...callerProcs];
  return [...registryProcs, ...callerProcs];   // append
}

