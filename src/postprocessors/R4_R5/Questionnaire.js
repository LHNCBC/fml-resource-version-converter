/**
 * @fileoverview Questionnaire postprocessors for the R4 <-> R5 version pair.
 *
 * Provides the R5 -> R4 direction only. The R4 -> R5 direction needs no
 * postprocessor for the necessary (non-IVE) conversions: the FML mapping covers
 * it.
 *
 * The R5 -> R4 item.type narrowing here is also reused verbatim by R5 -> R4B
 * (R4B is identical to R4 for Questionnaire.item); see
 * postprocessors/R4B_R5/Questionnaire.js. The FML issues handled are listed as a
 * bullet block directly above the descriptor (see the design documents, "The
 * postprocessor registry"). Inter-version-extension (IVE) handling is out of
 * scope and deferred to a later phase (see the design documents,
 * "Inter-version extensions").
 *
 * @module postprocessors/R4_R5/Questionnaire
 */
import { COVERAGE } from '../../converter/coverage.js';
import {
  infoMessage,
  statusFromMessages,
  warningMessage,
} from '../../converter/diagnostics.js';

/**
 * Return whether an R5 item carries answer options (answerOption/answerValueSet).
 *
 * @param {Object} item R5 source item.
 * @returns {boolean} True when the item has answer options.
 */
function hasAnswerOptions(item) {
  return (Array.isArray(item.answerOption) && item.answerOption.length > 0)
    || item.answerValueSet != null;
}

/**
 * Derive the correct R4 `item.type` from an R5 source item.
 *
 * R5 `coding` (plus `answerConstraint`/options) maps back to R4
 * `choice`/`open-choice`, while non-coding types keep their base type.
 * Ambiguous or lossy cases push an info/warning message onto `messages`.
 * (R4 and R4B are identical here, so R5 -> R4B reuses this.)
 *
 * @param {Object} sItem R5 source item (read-only).
 * @param {Array<Object>} messages Diagnostic messages to append to.
 * @returns {string} The R4 `item.type` code.
 */
function deriveR4ItemType(sItem, messages) {
  const sType = sItem.type;
  const ac = sItem.answerConstraint;
  const linkId = sItem.linkId;

  if (hasAnswerOptions(sItem)) {
    if (sType === 'coding') {
      if (ac === 'optionsOrType') {
        messages.push(infoMessage(
          `item "${linkId}": optionsOrType with type coding converted as open-choice`,
        ));
        return 'open-choice';
      }
      return ac === 'optionsOrString' ? 'open-choice' : 'choice';
    }
    // Non-coding item with options: R4 cannot express the constraint; keep the
    // base type and note the loss when the constraint was more than options-only.
    if (ac && ac !== 'optionsOnly') {
      messages.push(warningMessage(
        `item "${linkId}": ${ac}: non-coding, non-optionsOnly answerOption treated as options-only`,
      ));
    }
    return sType;
  }

  if (sType === 'coding') {
    // No options (e.g. a list supplied via extension). Choose choice/open-choice
    // from the constraint.
    const r4Type = (ac && ac !== 'optionsOnly') ? 'open-choice' : 'choice';
    messages.push(infoMessage(`item "${linkId}": item of type coding converted to ${r4Type}`));
    return r4Type;
  }

  if (ac) {
    messages.push(warningMessage(
      `item "${linkId}": unable to handle answerConstraint without answerOption/answerValueSet `
      + `for type ${sType}`,
    ));
    return sType;
  }

  return sType;
}

/**
 * Recursively index R5 source items by their linkId.
 *
 * linkId is unique within a Questionnaire, so this gives a robust mapping from
 * a converted (target) item back to its source item regardless of ordering.
 *
 * @param {Array<Object>|undefined} items Source items to index.
 * @param {Map<string, Object>} map Accumulator map (linkId -> source item).
 * @returns {Map<string, Object>} The populated map.
 */
function indexSourceItemsByLinkId(items, map) {
  if (!Array.isArray(items)) return map;
  for (const item of items) {
    if (item && typeof item === 'object') {
      if (typeof item.linkId === 'string') map.set(item.linkId, item);
      indexSourceItemsByLinkId(item.item, map);
    }
  }
  return map;
}

/**
 * Correct one target item's R4 type and strip any stray answerConstraint.
 *
 * @param {Object} tItem Target (FML-converted) item, mutated in place.
 * @param {Object|undefined} sItem Aligned R5 source item.
 * @param {Array<Object>} messages Diagnostic messages to append to.
 */
function fixItemType(tItem, sItem, messages) {
  // R4/R4B have no item.answerConstraint; drop anything the FML step left behind.
  if ('answerConstraint' in tItem) delete tItem.answerConstraint;

  if (sItem && typeof sItem === 'object' && sItem.type != null) {
    tItem.type = deriveR4ItemType(sItem, messages);
    return;
  }

  // Fallback (no aligned source item): normalize the malformed FML wrapped
  // primitive, type: { value: "..." } -> "...", so output stays well-formed.
  if (tItem.type && typeof tItem.type === 'object' && typeof tItem.type.value === 'string') {
    tItem.type = tItem.type.value;
  }
}

/**
 * Walk target items recursively, correcting each item's R4 type.
 *
 * @param {Array<Object>|undefined} targetItems Target items to correct.
 * @param {Map<string, Object>} sourceByLinkId R5 source items by linkId.
 * @param {Array<Object>} messages Diagnostic messages to append to.
 */
function convertItems(targetItems, sourceByLinkId, messages) {
  if (!Array.isArray(targetItems)) return;
  for (const tItem of targetItems) {
    if (!tItem || typeof tItem !== 'object') continue;
    const sItem = typeof tItem.linkId === 'string' ? sourceByLinkId.get(tItem.linkId) : undefined;
    fixItemType(tItem, sItem, messages);
    convertItems(tItem.item, sourceByLinkId, messages);
  }
}

/*
 * FML issues handled (R5 -> R4):
 * - item.type malformed: the FML emits a wrapped primitive
 *   `type: { value: "..." }` whenever answerConstraint was involved.
 * - item.type over-widened: the FML over-produces `open-choice`; e.g. a
 *   `coding` item constrained to a value set should be `choice`, and a
 *   non-coding item such as `integer` with options should keep its base type.
 * Both are corrected by recomputing item.type from the R5 source item.
 */

/**
 * R5 -> R4 Questionnaire postprocessor descriptor.
 *
 * Recomputes each item's R4 `type` from the R5 source item, fixing the FML
 * step's malformed and over-widened item-type narrowing. Coverage is
 * BEST_EFFORT because valid R5 answerConstraint details have no R4 equivalent
 * and may be narrowed with warnings.
 */
export const conv_R5_to_R4 = {
  name: 'Questionnaire_R5_to_R4',
  coverage: COVERAGE.BEST_EFFORT,
  description:
    'Corrects Questionnaire item.type for R5->R4 (coding/answerConstraint -> '
    + 'choice/open-choice) from the R5 source, fixing the FML step\'s malformed '
    + 'and over-widened narrowing. Also reused verbatim by R5->R4B (R4B is '
    + 'identical to R4 for Questionnaire.item). Does not handle inter-version '
    + 'extensions.',

  /**
   * @param {Object} target FML-converted R4 Questionnaire (mutated in place).
   * @param {Object} ctx Hop context; ctx.sourceResource is the R5 source.
   * @returns {{resource: Object, status: string, messages: Array<Object>}} Result.
   */
  execute(target, ctx) {
    const messages = [];
    const sourceByLinkId = indexSourceItemsByLinkId(ctx?.sourceResource?.item, new Map());
    convertItems(target.item, sourceByLinkId, messages);
    return { resource: target, status: statusFromMessages(messages), messages };
  },
};

