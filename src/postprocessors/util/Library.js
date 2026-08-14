/**
 * @fileoverview Shared mechanics for Library postprocessors.
 *
 * This module contains Library-specific structure handling and diagnostic
 * formatting without any version-pair policy. Version-pair processors supply
 * reviewed rename, approximation, ambiguity, and removal sets.
 *
 * @module postprocessors/util/Library
 */
import {
  infoMessage,
  warningMessage,
} from '../../converter/diagnostics.js';

const REQUIRED_TYPE_COLLECTIONS = ['parameter', 'dataRequirement'];

/**
 * Normalize required FHIR type codes in Library datatype collections.
 *
 * Both ParameterDefinition.type and DataRequirement.type are required and bind
 * to the FHIR type names defined by their version. The Library FML emits one
 * target entry per source entry, in the same order. This helper relies on that
 * alignment to apply exact type renames or reviewed approximations and remove
 * entries whose required type cannot conform to the target binding.
 *
 * Only the bare `type` value is changed. Its `_type` primitive companion and
 * every other converted property remain on the aligned target entry.
 *
 * @param {Object} target FML-converted Library, mutated in place.
 * @param {Object} source Source Library (read-only).
 * @param {{renames?: Map<string, string>, approximations?: Map<string, Object>,
 *   unsupported?: Set<string>, ambiguous?: Set<string>}} policy Reviewed
 *   version-pair type policy.
 * @returns {{renamed: Array<Object>, approximated: Array<Object>,
 *   dropped: Array<Object>}} Actions applied.
 */
export function normalizeLibraryRequiredTypes(target, source, policy = {}) {
  const renames = policy.renames || new Map();
  const approximations = policy.approximations || new Map();
  const unsupported = policy.unsupported || new Set();
  const ambiguous = policy.ambiguous || new Set();
  const renamed = [];
  const approximated = [];
  const dropped = [];

  for (const collection of REQUIRED_TYPE_COLLECTIONS) {
    const sourceEntries = source?.[collection];
    const targetEntries = target?.[collection];
    if (!Array.isArray(sourceEntries) || !Array.isArray(targetEntries)) continue;

    const kept = [];

    targetEntries.forEach((entry, index) => {
      const sourceType = sourceEntries[index]?.type;
      const targetType = renames.get(sourceType);

      if (targetType) {
        entry.type = targetType;
        kept.push(entry);
        renamed.push({ collection, index, sourceType, targetType });
        return;
      }

      const approximation = approximations.get(sourceType);
      if (approximation) {
        entry.type = approximation.targetType;
        kept.push(entry);
        approximated.push({
          collection,
          index,
          sourceType,
          targetType: approximation.targetType,
          detail: approximation.detail,
        });
        return;
      }

      let reason = null;
      if (ambiguous.has(sourceType)) reason = 'ambiguous';
      else if (unsupported.has(sourceType)) reason = 'unsupported';
      if (reason) {
        dropped.push({ collection, index, sourceType, reason });
        return;
      }

      kept.push(entry);
    });

    if (kept.length === targetEntries.length) continue;
    if (kept.length === 0) delete target[collection];
    else target[collection] = kept;
  }

  return { renamed, approximated, dropped };
}

/**
 * Describe the actions taken while normalizing Library required type codes.
 *
 * @param {{renamed?: Array<Object>, approximated?: Array<Object>,
 *   dropped?: Array<Object>}} actions Actions from
 *   normalizeLibraryRequiredTypes().
 * @param {string} sourceVersion Source FHIR version.
 * @param {string} targetVersion Target FHIR version.
 * @returns {Array<Object>} Info and warning diagnostic messages.
 */
export function describeLibraryTypeActions(actions, sourceVersion, targetVersion) {
  const messages = [];

  for (const action of actions.renamed || []) {
    messages.push(infoMessage(
      `Library.${action.collection}[${action.index}].type was renamed from `
      + `"${action.sourceType}" to "${action.targetType}" to follow the resource rename `
      + `between ${sourceVersion} and ${targetVersion}`,
    ));
  }

  for (const action of actions.approximated || []) {
    messages.push(warningMessage(
      `Library.${action.collection}[${action.index}].type "${action.sourceType}" has no exact `
      + `${targetVersion} equivalent and was approximated as "${action.targetType}"; `
      + action.detail,
    ));
  }

  for (const action of actions.dropped || []) {
    const reason = action.reason === 'ambiguous'
      ? `maps ambiguously to more than one ${targetVersion} resource type`
      : `is defined only in ${sourceVersion} and has no ${targetVersion} type equivalent`;
    messages.push(warningMessage(
      `Library.${action.collection}[${action.index}] was dropped because its required type `
      + `"${action.sourceType}" ${reason}`,
    ));
  }

  return messages;
}
