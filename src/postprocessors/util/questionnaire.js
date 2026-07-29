/**
 * @fileoverview Shared helpers for Questionnaire postprocessors.
 *
 * Questionnaire-specific logic reused across version pairs. Kept separate from
 * the generic, resource-agnostic element helpers (see ./elements.js).
 *
 * @module postprocessors/util/questionnaire
 */

/**
 * Recursively index Questionnaire source items by their linkId.
 *
 * linkId is unique within a Questionnaire, so this gives a robust mapping from
 * a converted (target) item back to its source item regardless of ordering.
 *
 * @param {Array<Object>|undefined} items Source items to index.
 * @param {Map<string, Object>} map Accumulator map (linkId -> source item).
 * @returns {Map<string, Object>} The populated map.
 */
export function indexSourceItemsByLinkId(items, map) {
  if (!Array.isArray(items)) return map;
  for (const item of items) {
    if (item && typeof item === 'object') {
      if (typeof item.linkId === 'string') map.set(item.linkId, item);
      indexSourceItemsByLinkId(item.item, map);
    }
  }
  return map;
}

