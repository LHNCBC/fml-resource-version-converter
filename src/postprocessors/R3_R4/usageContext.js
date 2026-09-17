/**
 * @fileoverview Shared R4 -> R3 UsageContext validity repair.
 *
 * R4 permits UsageContext.valueReference, while STU3 requires value[x] and
 * supports only CodeableConcept, Quantity, and Range. The bundled FML maps
 * each source UsageContext in order but has no Reference rule, leaving an
 * invalid target entry containing code without its required value.
 *
 * @module postprocessors/R3_R4/usageContext
 */
import { warningMessage } from '../../converter/diagnostics.js';
import { hasAnyContent } from '../util/elements.js';

/**
 * Remove UsageContext entries whose R4 valueReference has no STU3 equivalent.
 *
 * The bundled mapping emits target entries in source order, so filtering by
 * source index preserves every representable sibling. A warning is emitted for
 * each removed entry because its applicability information cannot be retained.
 *
 * @param {Object} target FML-converted STU3 resource, mutated in place.
 * @param {Object|undefined} source R4 source resource, read-only.
 * @param {Array<Object>} messages Diagnostic messages to append.
 * @returns {number} Number of unrepresentable source entries detected.
 */
export function removeUnrepresentableUsageContexts(target, source, messages) {
  const sourceContexts = source?.useContext;
  if (!Array.isArray(sourceContexts)) return 0;

  const resourceType = source.resourceType || target?.resourceType || 'Resource';
  const removedIndexes = new Set();

  sourceContexts.forEach((sourceContext, index) => {
    if (!hasAnyContent(sourceContext, ['valueReference'])) return;

    removedIndexes.add(index);
    messages.push(warningMessage(
      `${resourceType}.useContext[${index}].valueReference has no STU3 equivalent; `
      + 'the entire UsageContext entry was removed because STU3 requires every '
      + 'UsageContext to contain value[x]',
    ));
  });

  if (removedIndexes.size === 0) return 0;

  const targetContexts = Array.isArray(target?.useContext) ? target.useContext : [];
  const kept = targetContexts.filter((unused, index) => !removedIndexes.has(index));
  if (kept.length > 0) target.useContext = kept;
  else delete target.useContext;

  return removedIndexes.size;
}
