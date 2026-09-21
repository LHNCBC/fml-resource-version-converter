/**
 * @fileoverview Questionnaire postprocessors for the R4 <-> R5 version pair.
 *
 * Provides both directions. R4 -> R5 repairs the que-12 invariant gap in the
 * bundled R4 mapping, while R5 -> R4 corrects item.type narrowing and reports
 * R5-only content that the target cannot represent.
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
import {
  addDataAbsentReasonExtension,
  hasAnyContent,
  hasPrimitiveValueOrExtension,
} from '../util/elements.js';
import { indexSourceItemsByLinkId } from '../util/questionnaire.js';

/**
 * Ensure R5 que-12 can be satisfied after an R4 -> R5 conversion.
 *
 * The bundled R4 mapping only requires enableBehavior above two enableWhen
 * entries, while R5 requires it above one. R4 does not define a default from
 * which "all" or "any" can be inferred, so mark the primitive absent rather
 * than inventing behavior.
 *
 * @param {Array<Object>|undefined} items Target R5 items, mutated in place.
 * @param {Array<Object>} messages Diagnostic messages to append to.
 */
function repairEnableBehavior(items, messages) {
  if (!Array.isArray(items)) return;

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;

    if (Array.isArray(item.enableWhen)
        && item.enableWhen.length > 1
        && !hasPrimitiveValueOrExtension(item, 'enableBehavior')) {
      addDataAbsentReasonExtension(item, 'enableBehavior');
      messages.push(warningMessage(
        `item "${item.linkId}": R5 requires enableBehavior for multiple enableWhen `
        + 'conditions; marked it unknown because R4 does not define the missing behavior',
      ));
    }

    repairEnableBehavior(item.item, messages);
  }
}

/*
 * FML issue handled (R4 -> R5):
 * - que-12: the bundled R4 map follows R4's incorrect machine expression and
 *   can emit exactly two enableWhen entries without enableBehavior. R5 requires
 *   the element whenever more than one condition exists. The missing primitive
 *   is represented truthfully with data-absent-reason instead of guessing all
 *   or any.
 */

/**
 * R4 -> R5 Questionnaire postprocessor descriptor.
 */
export const conv_R4_to_R5 = {
  name: 'Questionnaire_R4_to_R5',
  coverage: COVERAGE.COMPLETE,
  description:
    'Repairs R5 que-12 when an R4 Questionnaire has multiple enableWhen entries '
    + 'but no enableBehavior, using data-absent-reason rather than inventing all/any.',

  /**
   * @param {Object} target FML-converted R5 Questionnaire (mutated in place).
   * @returns {{resource: Object, status: string, messages: Array<Object>}} Result.
   */
  execute(target) {
    const messages = [];
    repairEnableBehavior(target.item, messages);
    return { resource: target, status: statusFromMessages(messages), messages };
  },
};

/**
 * Collect R5-only Questionnaire paths that carry source content.
 *
 * Primitive checks recognize extension-only occurrences while rejecting an
 * invalid id-only companion. Repeated item content is reported once by logical
 * path, regardless of nesting depth or occurrence count.
 *
 * @param {Object|undefined} source R5 source Questionnaire.
 * @returns {string[]} Sorted logical paths containing unrepresentable content.
 */
function findDroppedR5Content(source) {
  const paths = new Set();

  if (hasPrimitiveValueOrExtension(source, 'versionAlgorithmString')
      || hasAnyContent(source, ['versionAlgorithmCoding'])) {
    paths.add('Questionnaire.versionAlgorithm[x]');
  }
  if (hasPrimitiveValueOrExtension(source, 'copyrightLabel')) {
    paths.add('Questionnaire.copyrightLabel');
  }

  /**
   * Inspect nested R5 items for R5-only primitive content.
   *
   * @param {Array<Object>|undefined} items R5 source items.
   */
  function inspectItems(items) {
    if (!Array.isArray(items)) return;

    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      if (hasPrimitiveValueOrExtension(item, 'disabledDisplay')) {
        paths.add('Questionnaire.item.disabledDisplay');
      }
      inspectItems(item.item);
    }
  }

  inspectItems(source?.item);
  return [...paths].sort();
}

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
 * @param {string} sourceVersion Source FHIR version named in diagnostics.
 * @param {string} targetVersion Target FHIR version named in diagnostics.
 * @returns {string} The R4 `item.type` code.
 */
function deriveR4ItemType(sItem, messages, sourceVersion, targetVersion) {
  const sType = sItem.type;
  const ac = sItem.answerConstraint;
  const linkId = sItem.linkId;

  if (hasAnswerOptions(sItem)) {
    if (sType === 'coding') {
      if (ac === 'optionsOrType') {
        // Lossy narrowing: R5 optionsOrType on a coding item permits any coding
        // of the item's type, whereas R4/R4B open-choice permits only a listed
        // coding or free-text string. The permitted answer space shrinks, so
        // this is a warning (unlike optionsOrString, which maps exactly).
        messages.push(warningMessage(
          `item "${linkId}": optionsOrType with type coding narrowed to open-choice; `
          + `${sourceVersion} allows any coding but ${targetVersion} open-choice allows `
          + 'only listed codings or free text',
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
 * Correct one target item's R4 type and strip any stray answerConstraint.
 *
 * @param {Object} tItem Target (FML-converted) item, mutated in place.
 * @param {Object|undefined} sItem Aligned R5 source item.
 * @param {Array<Object>} messages Diagnostic messages to append to.
 * @param {string} sourceVersion Source FHIR version named in diagnostics.
 * @param {string} targetVersion Target FHIR version named in diagnostics.
 */
function fixItemType(tItem, sItem, messages, sourceVersion, targetVersion) {
  // R4/R4B have no item.answerConstraint; drop anything the FML step left behind.
  if ('answerConstraint' in tItem) delete tItem.answerConstraint;

  if (sItem && typeof sItem === 'object' && sItem.type != null) {
    tItem.type = deriveR4ItemType(sItem, messages, sourceVersion, targetVersion);
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
 * @param {string} sourceVersion Source FHIR version named in diagnostics.
 * @param {string} targetVersion Target FHIR version named in diagnostics.
 */
function convertItems(targetItems, sourceByLinkId, messages, sourceVersion, targetVersion) {
  if (!Array.isArray(targetItems)) return;
  for (const tItem of targetItems) {
    if (!tItem || typeof tItem !== 'object') continue;
    const sItem = typeof tItem.linkId === 'string' ? sourceByLinkId.get(tItem.linkId) : undefined;
    fixItemType(tItem, sItem, messages, sourceVersion, targetVersion);
    convertItems(tItem.item, sourceByLinkId, messages, sourceVersion, targetVersion);
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
 * - versionAlgorithm[x], copyrightLabel, and item.disabledDisplay: R5-only
 *   elements are dropped by the FML. Source occurrences are reported,
 *   including extension-only primitives and recursively nested items.
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
    + 'and over-widened narrowing. Reports dropped R5-only versionAlgorithm[x], '
    + 'copyrightLabel, and nested item.disabledDisplay content. Also reused '
    + 'verbatim by R5->R4B. Does not handle inter-version extensions.',

  /**
   * @param {Object} target FML-converted R4 Questionnaire (mutated in place).
   * @param {Object} ctx Hop context with sourceResource, fromVer, and toVer.
   * @returns {{resource: Object, status: string, messages: Array<Object>}} Result.
   */
  execute(target, ctx) {
    const messages = [];
    const sourceByLinkId = indexSourceItemsByLinkId(ctx?.sourceResource?.item, new Map());
    const sourceVersion = ctx?.fromVer || 'R5';
    const targetVersion = ctx?.toVer || 'target version';
    const droppedPaths = findDroppedR5Content(ctx?.sourceResource);
    if (droppedPaths.length > 0) {
      messages.push(warningMessage(
        `${droppedPaths.join(', ')} ${droppedPaths.length === 1 ? 'has' : 'have'} no `
        + `${targetVersion} equivalent; source content dropped`,
      ));
    }
    convertItems(target.item, sourceByLinkId, messages, sourceVersion, targetVersion);
    return { resource: target, status: statusFromMessages(messages), messages };
  },
};
