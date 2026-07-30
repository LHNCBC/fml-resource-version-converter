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
import {
  copyPrimitive,
  deletePrimitive,
  findValueKey,
  renamePrimitive,
} from '../util/elements.js';
import { indexSourceItemsByLinkId } from '../util/questionnaire.js';

/**
 * Test whether an R4 (source) enableWhen entry carries an answer type that has
 * no R4 equivalent.
 *
 * STU3 `enableWhen.answer[x]` allows `uri` and `Attachment`; R4 removed both.
 * The FML upgrade maps `answerUri` straight through (producing an invalid R4
 * answerUri) and leaves the Attachment case as a malformed `{ question }` entry
 * (no operator/answer). Either way the source entry has no R4 representation.
 *
 * An extension-only primitive (a `_answerUri` companion with no bare
 * `answerUri`) is valid STU3 JSON and equally unrepresentable in R4, so the
 * `_`-companion forms are detected too.
 *
 * @param {Object} sEw STU3 source enableWhen entry (read-only).
 * @returns {boolean} True if the entry's answer is uri or Attachment.
 */
function isUnrepresentableInR4(sEw) {
  return !!sEw && typeof sEw === 'object'
    && ('answerUri' in sEw || '_answerUri' in sEw
      || 'answerAttachment' in sEw || '_answerAttachment' in sEw);
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
      const badKey = ('answerUri' in sEw || '_answerUri' in sEw)
        ? 'answerUri'
        : 'answerAttachment';
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
 * Ensure an R4 item with multiple enableWhen carries an enableBehavior.
 *
 * STU3 has no enableBehavior element and combines multiple enableWhen with
 * implicit OR. R4 constraint que-12 requires enableBehavior once an item has
 * more than one enableWhen. Since the STU3 source cannot supply one, synthesize
 * "any" - which matches STU3's implicit OR, so no display behavior is changed -
 * and record it as info (not a warning, because nothing is lost). An existing
 * enableBehavior (should one ever be present) is left untouched.
 *
 * @param {Object} tItem Target R4 item, mutated in place.
 * @param {Array<Object>} messages Diagnostic messages to append to.
 */
function ensureEnableBehavior(tItem, messages) {
  if (!Array.isArray(tItem.enableWhen) || tItem.enableWhen.length < 2) return;
  if (tItem.enableBehavior != null) return;

  tItem.enableBehavior = 'any';
  messages.push(infoMessage(
    `item "${tItem.linkId}": added enableBehavior "any" for ${tItem.enableWhen.length} `
    + 'enableWhen conditions (STU3 combines multiple conditions with OR)',
  ));
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

    // Independent of a source match: R4 validity (que-12) depends on the
    // target item's final enableWhen count.
    ensureEnableBehavior(tItem, messages);

    convertItemsUpgrade(tItem.item, sourceByLinkId, messages);
  }
}

/*
 * FML issues handled (R3 -> R4):
 * - enableWhen answerUri: valid in STU3, removed in R4; the FML maps it through,
 *   emitting an invalid R4 answerUri. Dropped here.
 * - enableWhen answerAttachment: valid in STU3, removed in R4; the FML leaves a
 *   malformed entry with only `question` (no operator/answer). Dropped here.
 * - enableBehavior: absent in STU3; R4 (que-12) requires it once an item has
 *   multiple enableWhen. Synthesized as "any" to match STU3's implicit OR.
 */

/**
 * R3 (STU3) -> R4 Questionnaire postprocessor descriptor.
 *
 * Drops enableWhen entries whose STU3 answer type (uri or Attachment) has no R4
 * equivalent, using the R4-converted output aligned to the STU3 source by
 * linkId. Coverage is BEST_EFFORT because valid STU3 source content with no R4
 * equivalent is dropped with warnings.
 */
export const conv_R3_to_R4 = {
  name: 'Questionnaire_R3_to_R4',
  coverage: COVERAGE.BEST_EFFORT,
  description:
    'Drops Questionnaire enableWhen entries whose STU3 answer type (uri or '
    + 'Attachment) has no R4 equivalent, and sets enableBehavior "any" on items '
    + 'with multiple enableWhen (R4 que-12; matches STU3 implicit OR). Does not '
    + 'handle inter-version extensions.',

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
 * Drop an enableWhen primitive value and its `_`-companion, warning when a
 * companion (primitive id/extension) had to be discarded because the field has
 * no STU3 equivalent. A bare value alone drops silently; only lost id/extension
 * metadata is flagged. Questionnaire-specific diagnostic wrapper over the
 * generic deletePrimitive.
 *
 * @param {Object} obj Object to mutate in place.
 * @param {string} key Primitive key to remove.
 * @param {string} linkId Owning item's linkId (for the message).
 * @param {Array<Object>} messages Diagnostic messages to append to.
 */
function dropPrimitive(obj, key, linkId, messages) {
  const { hadCompanion } = deletePrimitive(obj, key);
  if (hadCompanion) {
    messages.push(warningMessage(
      `item "${linkId}": enableWhen _${key} (primitive id/extension) has no STU3 equivalent; discarded`,
    ));
  }
}

/**
 * Convert one R4 enableWhen entry to its STU3 form, or drop it.
 *
 * Rule: operator `exists` becomes `hasAnswer` (carrying answerBoolean's
 * `_answerBoolean` id/extension to `_hasAnswer`); operator `=` keeps its
 * `answer[x]` (operator removed); any other operator cannot be represented in
 * STU3, so the entry is dropped with a warning. The removed `operator` primitive
 * has no STU3 field, so its `_operator` metadata (if present) is discarded with
 * a warning.
 *
 * @param {Object} sEw R4 source enableWhen entry (read-only).
 * @param {string} linkId Owning item's linkId (for messages).
 * @param {Array<Object>} messages Diagnostic messages to append to.
 * @returns {Object|null} The STU3 enableWhen entry, or null to drop it.
 */
function r4EnableWhenToR3(sEw, linkId, messages) {
  if (sEw.operator === 'exists') {
    const out = { ...sEw };
    dropPrimitive(out, 'operator', linkId, messages);
    renamePrimitive(out, 'answerBoolean', 'hasAnswer');
    return out;
  }

  if (sEw.operator === '=') {
    const out = { ...sEw };
    dropPrimitive(out, 'operator', linkId, messages);
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

  // STU3 has no enableBehavior and combines multiple enableWhen with implicit
  // OR. Only relevant when 2+ conditions actually remain (with a single
  // condition, "all" and "any" are equivalent).
  if (converted.length >= 2 && sItem.enableBehavior != null) {
    if (sItem.enableBehavior === 'all') {
      messages.push(warningMessage(
        `item "${sItem.linkId}": R4 enableBehavior "all" has no STU3 equivalent; `
        + 'STU3 combines enableWhen with OR, so conditional-display behavior may change',
      ));
    } else {
      messages.push(infoMessage(
        `item "${sItem.linkId}": R4 enableBehavior "${sItem.enableBehavior}" dropped; `
        + 'matches STU3 implicit OR',
      ));
    }
  }
}

/**
 * Fix a target item's `options` to the STU3 Reference shape.
 *
 * STU3 `item.options` is a Reference(ValueSet); the FML step emits a malformed
 * bare string. Re-derive it from the R4 source's `answerValueSet`, carrying the
 * canonical's `_answerValueSet` id/extension companion onto the STU3 Reference's
 * `reference` primitive (`_reference`) so no primitive metadata is lost. An
 * extension-only `answerValueSet` (companion with no bare value) is handled too.
 *
 * @param {Object} tItem Target item, mutated in place.
 * @param {Object} sItem Aligned R4 source item (read-only).
 * @param {Array<Object>} messages Diagnostic messages to append to.
 */
function fixOptions(tItem, sItem, messages) {
  if (!('answerValueSet' in sItem) && !('_answerValueSet' in sItem)) return;

  const options = {};
  copyPrimitive(sItem, 'answerValueSet', options, 'reference');
  tItem.options = options;

  // Remove the FML-emitted primitive answerValueSet and any companion the
  // engine carried, so no stray R4 field remains on the STU3 target.
  deletePrimitive(tItem, 'answerValueSet');

  messages.push(infoMessage(
    `item "${sItem.linkId}": answerValueSet mapped to STU3 options.reference`,
  ));
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

    const suffix = findValueKey(opt, { companionAware: true, suffixOnly: true });
    if (!suffix) continue;

    if (initialSet) {
      messages.push(warningMessage(
        `item "${sItem.linkId}": ignored additional answerOption.initialSelected`,
      ));
      continue;
    }

    const initialKey = 'initial' + suffix;
    // Carry the primitive's id/extension companion (_value<Suffix>) too, so no
    // primitive metadata is lost when the value moves to initial[x].
    copyPrimitive(opt, 'value' + suffix, tItem, initialKey);
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

  // Remove any initial[x] the FML derived from the source array (any type),
  // including its `_`-companion, so a single, deterministic value remains.
  for (const entry of sItem.initial) {
    if (!entry || typeof entry !== 'object') continue;
    const suffix = findValueKey(entry, { companionAware: true, suffixOnly: true });
    if (suffix) {
      delete tItem['initial' + suffix];
      delete tItem['_initial' + suffix];
    }
  }

  const first = sItem.initial[0];
  const firstSuffix = first && typeof first === 'object'
    ? findValueKey(first, { companionAware: true, suffixOnly: true })
    : undefined;
  if (firstSuffix) {
    // Carry the primitive's id/extension companion along with the value.
    copyPrimitive(first, 'value' + firstSuffix, tItem, 'initial' + firstSuffix);
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
 * - enableWhen primitive `_`-companions: FHIR primitives keep id/extension in a
 *   sibling `_<name>`. Rewriting enableWhen carries `_answerBoolean` to
 *   `_hasAnswer` and drops the orphaned `_operator` (warning if it held data).
 * - answerOption.initialSelected -> initial[x]: R4 marks a default via
 *   `answerOption.initialSelected`; STU3 carries it on `item.initial[x]`. The
 *   FML drops both; re-derived here from the R4 source.
 * - answerOption.valueReference: no STU3 `option.value[x]` equivalent, so the
 *   FML leaves an empty `option` entry (STU3 requires a value). Dropped here.
 * - initial cardinality: R4 `initial` is 0..* but STU3 `initial[x]` is 0..1;
 *   the FML lets the last value win. The first is kept here (rest dropped).
 * - enableBehavior: R4-only; STU3 combines multiple enableWhen with implicit OR.
 *   Dropping "any" is lossless (info); dropping "all" changes behavior (warning).
 */

/**
 * R4 -> R3 (STU3) Questionnaire postprocessor descriptor.
 *
 * Corrects the FML step's item-level issues from the R4 source (see the issue
 * list above). Coverage is BEST_EFFORT because valid R4 source content with no
 * STU3 equivalent is dropped or narrowed with warnings.
 */
export const conv_R4_to_R3 = {
  name: 'Questionnaire_R4_to_R3',
  coverage: COVERAGE.BEST_EFFORT,
  description:
    'Corrects Questionnaire R4->R3 item fields from the R4 source: rebuilds '
    + 'enableWhen (dropping operators with no STU3 equivalent), fixes options to '
    + 'the STU3 Reference shape, and re-derives initial[x] from '
    + 'answerOption.initialSelected. Warns when enableBehavior "all" cannot be '
    + 'represented in STU3. Does not handle inter-version extensions.',

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

