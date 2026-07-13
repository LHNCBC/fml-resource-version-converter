/**
 * @fileoverview Questionnaire postprocessors for the R3 (STU3) <-> R4 pair.
 *
 * This file holds both directions:
 *   - conv_R3_to_R4: corrects the FML upgrade mapping.
 *   - conv_R4_to_R3: corrects the FML downgrade mapping.
 *
 * The specific FML issues each direction handles are listed as a bullet block
 * directly above its descriptor (see the design documents, "The postprocessor
 * registry"). Inter-version-extension (IVE) handling is out of scope and
 * deferred to a later phase (see the design documents, "Inter-version extensions").
 *
 * @module postprocessors/R3_R4/Questionnaire
 */
import { COVERAGE } from '../../converter/coverage.js';
import {
  infoMessage,
  statusFromMessages,
  warningMessage,
} from '../../converter/diagnostics.js';

/**
 * Recursively index R4 source items by their linkId.
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
 * Test whether an R4 (source) enableWhen entry carries an answer type that has
 * no R4 equivalent.
 *
 * STU3 `enableWhen.answer[x]` allows `uri` and `Attachment`; R4 removed both.
 * The FML upgrade maps `answerUri` straight through (producing an invalid R4
 * answerUri) and leaves the Attachment case as a malformed `{ question }` entry
 * (no operator/answer). Either way the source entry has no R4 representation.
 *
 * @param {Object} sEw STU3 source enableWhen entry (read-only).
 * @returns {boolean} True if the entry's answer is uri or Attachment.
 */
function isUnrepresentableInR4(sEw) {
  return !!sEw && typeof sEw === 'object'
    && ('answerUri' in sEw || 'answerAttachment' in sEw);
}

/**
 * Drop a target item's enableWhen entries that are unrepresentable in R4.
 *
 * The FML maps STU3 enableWhen to R4 one-to-one in order, so the target entries
 * align by index with the STU3 source entries. Entries whose source answer is
 * `uri` or `Attachment` (no R4 equivalent) are dropped with a warning.
 *
 * @param {Object} tItem Target item, mutated in place.
 * @param {Object} sItem Aligned STU3 source item (read-only).
 * @param {Array<Object>} messages Diagnostic messages to append to.
 */
function dropUnrepresentableEnableWhen(tItem, sItem, messages) {
  if (!Array.isArray(tItem.enableWhen) || tItem.enableWhen.length === 0) return;
  if (!Array.isArray(sItem.enableWhen)) return;

  const kept = tItem.enableWhen.filter((tEw, i) => {
    const sEw = sItem.enableWhen[i];
    if (isUnrepresentableInR4(sEw)) {
      const badKey = 'answerUri' in sEw ? 'answerUri' : 'answerAttachment';
      messages.push(warningMessage(
        `item "${sItem.linkId}": enableWhen ${badKey} has no R4 equivalent; entry dropped`,
      ));
      return false;
    }
    return true;
  });

  if (kept.length > 0) {
    tItem.enableWhen = kept;
  } else {
    delete tItem.enableWhen;
  }
}

/**
 * Walk target items recursively, applying the R3 -> R4 corrections.
 *
 * @param {Array<Object>|undefined} targetItems Target items to correct.
 * @param {Map<string, Object>} sourceByLinkId STU3 source items by linkId.
 * @param {Array<Object>} messages Diagnostic messages to append to.
 */
function convertItemsUpgrade(targetItems, sourceByLinkId, messages) {
  if (!Array.isArray(targetItems)) return;
  for (const tItem of targetItems) {
    if (!tItem || typeof tItem !== 'object') continue;

    const sItem = typeof tItem.linkId === 'string'
      ? sourceByLinkId.get(tItem.linkId)
      : undefined;

    if (sItem && typeof sItem === 'object') {
      dropUnrepresentableEnableWhen(tItem, sItem, messages);
    }

    convertItemsUpgrade(tItem.item, sourceByLinkId, messages);
  }
}

/*
 * FML issues handled (R3 -> R4):
 * - enableWhen answerUri: valid in STU3, removed in R4; the FML maps it through,
 *   emitting an invalid R4 answerUri. Dropped here.
 * - enableWhen answerAttachment: valid in STU3, removed in R4; the FML leaves a
 *   malformed entry with only `question` (no operator/answer). Dropped here.
 */

/**
 * R3 (STU3) -> R4 Questionnaire postprocessor descriptor.
 *
 * Drops enableWhen entries whose STU3 answer type (uri or Attachment) has no R4
 * equivalent, using the R4-converted output aligned to the STU3 source by
 * linkId. Coverage is COMPLETE for the necessary (non-IVE) conversions of valid
 * input.
 */
export const conv_R3_to_R4 = {
  name: 'Questionnaire_R3_to_R4',
  coverage: COVERAGE.COMPLETE,
  description:
    'Drops Questionnaire enableWhen entries whose STU3 answer type (uri or '
    + 'Attachment) has no R4 equivalent. Does not handle inter-version '
    + 'extensions.',

  /**
   * @param {Object} target FML-converted R4 Questionnaire (mutated in place).
   * @param {Object} ctx Hop context; ctx.sourceResource is the STU3 source.
   * @returns {{resource: Object, status: string, messages: Array<Object>}} Result.
   */
  execute(target, ctx) {
    const messages = [];
    const sourceByLinkId = indexSourceItemsByLinkId(ctx?.sourceResource?.item, new Map());
    convertItemsUpgrade(target.item, sourceByLinkId, messages);
    return { resource: target, status: statusFromMessages(messages), messages };
  },
};


/**
 * Convert one R4 enableWhen entry to its STU3 form, or drop it.
 *
 * Rule: operator `exists` becomes `hasAnswer`; operator `=` keeps its
 * `answer[x]` (operator removed); any other operator cannot be represented in
 * STU3, so the entry is dropped with a warning.
 *
 * @param {Object} sEw R4 source enableWhen entry (read-only).
 * @param {string} linkId Owning item's linkId (for messages).
 * @param {Array<Object>} messages Diagnostic messages to append to.
 * @returns {Object|null} The STU3 enableWhen entry, or null to drop it.
 */
function r4EnableWhenToR3(sEw, linkId, messages) {
  if (sEw.operator === 'exists') {
    const out = { ...sEw };
    delete out.operator;
    out.hasAnswer = out.answerBoolean;
    delete out.answerBoolean;
    return out;
  }

  if (sEw.operator === '=') {
    const out = { ...sEw };
    delete out.operator;
    return out;
  }

  messages.push(warningMessage(
    `item "${linkId}": enableWhen operator "${sEw.operator}" has no STU3 equivalent; entry dropped`,
  ));
  return null;
}

/**
 * Rebuild a target item's enableWhen from its R4 source item.
 *
 * The FML step strips the operator but does not re-map it, leaving invalid STU3
 * entries. Re-deriving from the source produces well-formed STU3 enableWhen.
 *
 * @param {Object} tItem Target item, mutated in place.
 * @param {Object} sItem Aligned R4 source item (read-only).
 * @param {Array<Object>} messages Diagnostic messages to append to.
 */
function fixEnableWhen(tItem, sItem, messages) {
  if (!Array.isArray(sItem.enableWhen) || sItem.enableWhen.length === 0) return;

  const converted = sItem.enableWhen
    .map(sEw => r4EnableWhenToR3(sEw, sItem.linkId, messages))
    .filter(ew => ew != null);

  if (converted.length > 0) {
    tItem.enableWhen = converted;
  } else {
    delete tItem.enableWhen;
  }
}

/**
 * Fix a target item's `options` to the STU3 Reference shape.
 *
 * STU3 `item.options` is a Reference(ValueSet); the FML step emits a malformed
 * bare string. Re-derive it from the R4 source's `answerValueSet`.
 *
 * @param {Object} tItem Target item, mutated in place.
 * @param {Object} sItem Aligned R4 source item (read-only).
 * @param {Array<Object>} messages Diagnostic messages to append to.
 */
function fixOptions(tItem, sItem, messages) {
  if (sItem.answerValueSet == null) return;

  tItem.options = { reference: sItem.answerValueSet };
  if ('answerValueSet' in tItem) delete tItem.answerValueSet;
  messages.push(infoMessage(
    `item "${sItem.linkId}": answerValueSet mapped to STU3 options.reference`,
  ));
}

/**
 * Derive the value[x] field name carried on an answerOption entry.
 *
 * @param {Object} opt An answerOption entry.
 * @returns {string|undefined} The `value*` key, or undefined if none.
 */
function findValueKey(opt) {
  return Object.keys(opt).find(k => k.startsWith('value'));
}

/**
 * Re-derive `item.initial[x]` from an R4 source item's answerOption.initialSelected.
 *
 * STU3 expresses a default answer via `item.initial[x]` (e.g. `initialCoding`).
 * The first initialSelected option wins; any subsequent one is ignored with a
 * warning.
 *
 * @param {Object} tItem Target item, mutated in place.
 * @param {Object} sItem Aligned R4 source item (read-only).
 * @param {Array<Object>} messages Diagnostic messages to append to.
 */
function fixInitialSelected(tItem, sItem, messages) {
  if (!Array.isArray(sItem.answerOption)) return;

  let initialSet = false;
  for (const opt of sItem.answerOption) {
    if (!opt || typeof opt !== 'object' || !opt.initialSelected) continue;

    const valueKey = findValueKey(opt);
    if (!valueKey) continue;

    if (initialSet) {
      messages.push(warningMessage(
        `item "${sItem.linkId}": ignored additional answerOption.initialSelected`,
      ));
      continue;
    }

    const initialKey = 'initial' + valueKey.slice('value'.length);
    tItem[initialKey] = opt[valueKey];
    initialSet = true;
    messages.push(infoMessage(
      `item "${sItem.linkId}": answerOption.initialSelected mapped to STU3 ${initialKey}`,
    ));
  }
}

/**
 * Drop a target item's `option` entries that have no STU3-representable value.
 *
 * R4 `answerOption.value[x]` adds `Reference`, which STU3 `option.value[x]` does
 * not have. The FML step still creates an `option` entry for such a source
 * option but leaves it without a `value[x]` (an empty object). STU3
 * `option.value[x]` is required, so these entries are dropped with a warning.
 * The FML maps `answerOption` to `option` one-to-one in order, so the source
 * entry aligns by index for the diagnostic detail.
 *
 * @param {Object} tItem Target item, mutated in place.
 * @param {Object} sItem Aligned R4 source item (read-only).
 * @param {Array<Object>} messages Diagnostic messages to append to.
 */
function fixAnswerOption(tItem, sItem, messages) {
  if (!Array.isArray(tItem.option) || tItem.option.length === 0) return;

  const sOpts = Array.isArray(sItem.answerOption) ? sItem.answerOption : [];
  const kept = tItem.option.filter((tOpt, i) => {
    if (tOpt && typeof tOpt === 'object' && findValueKey(tOpt)) return true;

    const sOpt = sOpts[i];
    const badKey = (sOpt && typeof sOpt === 'object' && findValueKey(sOpt)) || 'entry';
    messages.push(warningMessage(
      `item "${sItem.linkId}": answerOption ${badKey} has no STU3 equivalent; entry dropped`,
    ));
    return false;
  });

  if (kept.length > 0) {
    tItem.option = kept;
  } else {
    delete tItem.option;
  }
}

/**
 * Reduce a target item's initial value to STU3's single `initial[x]`.
 *
 * R4 `item.initial` is 0..*, but STU3 `item.initial[x]` is 0..1. The FML step
 * assigns each source entry onto the single target field, so the last one wins.
 * Re-derive from the first source entry (declaration order) and warn when more
 * than one was present.
 *
 * @param {Object} tItem Target item, mutated in place.
 * @param {Object} sItem Aligned R4 source item (read-only).
 * @param {Array<Object>} messages Diagnostic messages to append to.
 */
function fixInitial(tItem, sItem, messages) {
  if (!Array.isArray(sItem.initial) || sItem.initial.length === 0) return;

  // Remove any initial[x] the FML derived from the source array (any type), so
  // a single, deterministic value remains.
  for (const entry of sItem.initial) {
    if (!entry || typeof entry !== 'object') continue;
    const vk = findValueKey(entry);
    if (vk) delete tItem['initial' + vk.slice('value'.length)];
  }

  const first = sItem.initial[0];
  const firstKey = first && typeof first === 'object' ? findValueKey(first) : undefined;
  if (firstKey) {
    tItem['initial' + firstKey.slice('value'.length)] = first[firstKey];
  }

  if (sItem.initial.length > 1) {
    messages.push(warningMessage(
      `item "${sItem.linkId}": STU3 allows a single initial value; kept the first, `
      + `dropped ${sItem.initial.length - 1} more`,
    ));
  }
}

/**
 * Walk target items recursively, applying the R4 -> R3 corrections.
 *
 * @param {Array<Object>|undefined} targetItems Target items to correct.
 * @param {Map<string, Object>} sourceByLinkId R4 source items by linkId.
 * @param {Array<Object>} messages Diagnostic messages to append to.
 */
function convertItems(targetItems, sourceByLinkId, messages) {
  if (!Array.isArray(targetItems)) return;
  for (const tItem of targetItems) {
    if (!tItem || typeof tItem !== 'object') continue;

    const sItem = typeof tItem.linkId === 'string'
      ? sourceByLinkId.get(tItem.linkId)
      : undefined;

    if (sItem && typeof sItem === 'object') {
      fixEnableWhen(tItem, sItem, messages);
      fixOptions(tItem, sItem, messages);
      fixAnswerOption(tItem, sItem, messages);
      fixInitialSelected(tItem, sItem, messages);
      fixInitial(tItem, sItem, messages);
    }

    convertItems(tItem.item, sourceByLinkId, messages);
  }
}

/*
 * FML issues handled (R4 -> R3):
 * - answerValueSet -> options: the FML emits a malformed primitive
 *   `options: "<uri>"`; STU3 options is a Reference(ValueSet). Rebuilt here.
 * - enableWhen with a non-representable operator: STU3 supports only `hasAnswer`
 *   (operator `exists`) and `answer[x]` equality (operator `=`); any other
 *   operator has no STU3 equivalent and the FML leaves an invalid `{ question }`
 *   entry. Rebuilt from the R4 source, dropping un-representable entries.
 * - answerOption.initialSelected -> initial[x]: R4 marks a default via
 *   `answerOption.initialSelected`; STU3 carries it on `item.initial[x]`. The
 *   FML drops both; re-derived here from the R4 source.
 * - answerOption.valueReference: no STU3 `option.value[x]` equivalent, so the
 *   FML leaves an empty `option` entry (STU3 requires a value). Dropped here.
 * - initial cardinality: R4 `initial` is 0..* but STU3 `initial[x]` is 0..1;
 *   the FML lets the last value win. The first is kept here (rest dropped).
 */

/**
 * R4 -> R3 (STU3) Questionnaire postprocessor descriptor.
 *
 * Corrects the FML step's item-level issues from the R4 source (see the issue
 * list above). Coverage is COMPLETE for the necessary (non-IVE) conversions of
 * valid input.
 */
export const conv_R4_to_R3 = {
  name: 'Questionnaire_R4_to_R3',
  coverage: COVERAGE.COMPLETE,
  description:
    'Corrects Questionnaire R4->R3 item fields from the R4 source: rebuilds '
    + 'enableWhen (dropping operators with no STU3 equivalent), fixes options to '
    + 'the STU3 Reference shape, and re-derives initial[x] from '
    + 'answerOption.initialSelected. Does not handle inter-version extensions.',

  /**
   * @param {Object} target FML-converted STU3 Questionnaire (mutated in place).
   * @param {Object} ctx Hop context; ctx.sourceResource is the R4 source.
   * @returns {{resource: Object, status: string, messages: Array<Object>}} Result.
   */
  execute(target, ctx) {
    const messages = [];
    const sourceByLinkId = indexSourceItemsByLinkId(ctx?.sourceResource?.item, new Map());
    convertItems(target.item, sourceByLinkId, messages);
    return { resource: target, status: statusFromMessages(messages), messages };
  },
};

