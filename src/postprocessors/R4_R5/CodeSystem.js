/**
 * @fileoverview CodeSystem postprocessors for the R4 <-> R5 version pair.
 *
 * R4 -> R5: the bundled FML maps every R4 element, because R5 is an element-wise
 * superset. One incompatibility survives: R4 permits `content = "supplement"`
 * without `supplements`, while R5 invariant csd-4 requires it, so the FML step
 * alone emits invalid R5. The canonical URL of the supplemented code system
 * cannot be derived from the source, so the postprocessor marks `supplements`
 * absent with the standard data-absent-reason extension rather than inventing
 * a value or relabelling `content`.
 *
 * R5 -> R4: the FML maps every shared element but drops R5-only content
 * silently, and leaves the R5-only filter operators `child-of` and
 * `descendent-leaf` in place, because `csd.fi.operator-5to4` marks them `noMap`
 * and the engine passes unmapped codes through unchanged. Those codes are not in
 * the R4 FilterOperator binding, so the postprocessor removes them.
 *
 * Neither direction implements inter-version extensions.
 *
 * R4B reuses both transforms unchanged; see postprocessors/R4B_R5/CodeSystem.js
 * for the exact scope.
 *
 * @module postprocessors/R4_R5/CodeSystem
 */
import { COVERAGE } from '../../converter/coverage.js';
import {
  statusFromMessages,
  warningMessage,
} from '../../converter/diagnostics.js';
import {
  addDataAbsentReasonExtension,
  hasAnyContent,
  removePrimitiveArrayEntries,
} from '../util/elements.js';

// Keep this reviewed conversion policy explicit so regenerated FHIR definitions
// cannot silently change which source content is reported as unrepresentable.
const R5_ONLY_ROOT_FIELDS = [
  ['versionAlgorithm[x]', ['versionAlgorithmString', '_versionAlgorithmString', 'versionAlgorithmCoding']],
  ['copyrightLabel', ['copyrightLabel', '_copyrightLabel']],
  ['approvalDate', ['approvalDate', '_approvalDate']],
  ['lastReviewDate', ['lastReviewDate', '_lastReviewDate']],
  ['effectivePeriod', ['effectivePeriod']],
  ['topic', ['topic']],
  ['author', ['author']],
  ['editor', ['editor']],
  ['reviewer', ['reviewer']],
  ['endorser', ['endorser']],
  ['relatedArtifact', ['relatedArtifact']],
];

// R5 additions to the FilterOperator value set. R4 and R4B bind the same nine
// codes, so neither has an equivalent for these.
const R5_ONLY_FILTER_OPERATORS = new Set(['child-of', 'descendent-leaf']);


/**
 * Inspect a concept tree for R5-only content.
 *
 * `CodeSystem.concept` nests arbitrarily deep, so designations are collected
 * recursively. Paths are reported without indexes, matching the element-level
 * granularity of the other reported paths.
 *
 * @param {Array<Object>|undefined} concepts R5 concept entries.
 * @param {Set<string>} paths R5-only paths found.
 */
function inspectConcepts(concepts, paths) {
  for (const concept of concepts || []) {
    for (const designation of concept?.designation || []) {
      if (hasAnyContent(designation, ['additionalUse'])) {
        paths.add('CodeSystem.concept.designation.additionalUse');
      }
    }
    inspectConcepts(concept?.concept, paths);
  }
}

/**
 * Find R5-only CodeSystem paths present in a source resource.
 *
 * @param {Object} source R5 CodeSystem source.
 * @returns {string[]} Sorted paths.
 */
function findR5OnlyContent(source) {
  const paths = new Set();

  for (const [path, fields] of R5_ONLY_ROOT_FIELDS) {
    if (hasAnyContent(source, fields)) paths.add(`CodeSystem.${path}`);
  }

  inspectConcepts(source?.concept, paths);

  return [...paths].sort();
}

/**
 * Remove R5-only operator codes from every converted filter.
 *
 * `CodeSystem.filter.operator` is 1..*, and it declares which operators the code
 * system supports for a filter rather than selecting concepts. Removing an
 * unrepresentable code therefore leaves a smaller but still truthful
 * declaration, whereas substituting the nearest operator would claim support the
 * terminology does not have. A filter left with no operator at all cannot be
 * expressed in the target, so the whole filter entry is dropped.
 *
 * @param {Object} target FML-converted R4 CodeSystem, mutated in place.
 * @param {Array<Object>} messages Diagnostic messages to append.
 * @param {string} targetVersion Target FHIR version named in diagnostics.
 */
function removeUnrepresentableFilterOperators(target, messages, targetVersion) {
  const filters = target?.filter;
  if (!Array.isArray(filters)) return;

  const keptFilters = [];

  filters.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      keptFilters.push(entry);
      return;
    }

    const { removed, remaining } = removePrimitiveArrayEntries(
      entry,
      'operator',
      value => R5_ONLY_FILTER_OPERATORS.has(value),
    );
    if (removed.length === 0) {
      keptFilters.push(entry);
      return;
    }

    const codes = removed.map(item => `"${item.value}"`).join(', ');
    const path = `CodeSystem.filter[${index}]`;

    if (remaining > 0) {
      keptFilters.push(entry);
      messages.push(warningMessage(
        `${path}.operator: removed ${codes}, which ${targetVersion} does not define; `
        + 'the filter still declares its remaining operators',
      ));
      return;
    }

    messages.push(warningMessage(
      `${path} (code "${entry.code ?? 'unknown'}") was dropped because ${codes} is its only `
      + `operator and ${targetVersion} does not define it; operator is required, so the `
      + 'filter cannot be expressed and consumers can no longer discover this filter',
    ));
  });

  if (keptFilters.length === filters.length) return;
  if (keptFilters.length === 0) delete target.filter;
  else target.filter = keptFilters;
}

/*
 * FML limitations reported (R5 -> R4):
 * - R5-only metadata elements and concept.designation.additionalUse are dropped.
 * - filter operators child-of and descendent-leaf have no R4 equivalent. The
 *   engine preserves them; the postprocessor removes them so the output
 *   conforms to the R4 FilterOperator binding, and warns about the narrowed
 *   filter declaration.
 */

/**
 * R5 -> R4 CodeSystem postprocessor descriptor.
 *
 * Reports unavoidable loss and removes R5-only filter operator codes that R4
 * cannot express.
 */
export const conv_R5_to_R4 = {
  name: 'CodeSystem_R5_to_R4',
  coverage: COVERAGE.BEST_EFFORT,
  description:
    'Reports R5-only CodeSystem content dropped during R5->R4 conversion and removes '
    + 'R5-only filter operator codes with warnings, dropping a filter left without any '
    + 'operator. Does not handle inter-version extensions.',

  /**
   * @param {Object} target FML-converted R4 CodeSystem, mutated in place.
   * @param {Object} ctx Hop context with sourceResource, fromVer, and toVer.
   * @returns {{resource: Object, status: string, messages: Array<Object>}} Result.
   */
  execute(target, ctx) {
    const messages = [];
    const paths = findR5OnlyContent(ctx?.sourceResource || {});
    const sourceVersion = ctx?.fromVer || 'R5';
    const targetVersion = ctx?.toVer || 'target version';

    if (paths.length > 0) {
      messages.push(warningMessage(
        `${sourceVersion}-only CodeSystem content was dropped because ${targetVersion} has no `
        + `equivalent: ${paths.join(', ')}`,
      ));
    }

    removeUnrepresentableFilterOperators(target, messages, targetVersion);

    return { resource: target, status: statusFromMessages(messages), messages };
  },
};

/*
 * FML limitations reported (R4 -> R5):
 * - R4 allows content = "supplement" with no supplements element; R5 csd-4
 *   makes that combination invalid, so the FML step alone emits invalid R5.
 *   The supplemented code system's canonical URL is not present anywhere in
 *   the source, so no value can be derived and none is invented. Instead the
 *   postprocessor marks the element absent with the standard
 *   data-absent-reason extension: FHIR allows an extension to stand in place
 *   of a primitive value, so `supplements` then exists for csd-4 while
 *   asserting nothing about a canonical the source never carried.
 *
 * Rejected alternatives, recorded so they are not revisited:
 * - Rewriting content to "not-present" or "fragment" would satisfy csd-4 but
 *   assert something false. "not-present" means no concepts are included,
 *   which contradicts a populated concept[], and both codes turn a supplement
 *   (a decoration of another code system) into a standalone code system at its
 *   own url, which a terminology server would then register as real content.
 * - Inventing a canonical for supplements would fabricate the one fact the
 *   source does not contain.
 */

/**
 * R4 -> R5 CodeSystem postprocessor descriptor.
 *
 * Repairs the one R4 input shape that the FML cannot render as valid R5.
 */
export const conv_R4_to_R5 = {
  name: 'CodeSystem_R4_to_R5',
  coverage: COVERAGE.COMPLETE,
  description:
    'Marks CodeSystem.supplements absent with the standard data-absent-reason extension '
    + 'when an R4 code system supplement omits it, which R5 invariant csd-4 requires. The '
    + 'supplemented canonical cannot be derived from the source, so it is reported as '
    + 'unknown rather than invented. Does not handle inter-version extensions.',

  /**
   * @param {Object} target FML-converted R5 CodeSystem, mutated in place.
   * @param {Object} ctx Hop context with sourceResource, fromVer, and toVer.
   * @returns {{resource: Object, status: string, messages: Array<Object>}} Result.
   */
  execute(target, ctx) {
    const messages = [];
    const sourceVersion = ctx?.fromVer || 'R4';
    const targetVersion = ctx?.toVer || 'R5';

    if (target?.content === 'supplement' && !hasAnyContent(target, ['supplements', '_supplements'])) {
      addDataAbsentReasonExtension(target, 'supplements');
      messages.push(warningMessage(
        'CodeSystem.content is "supplement" but CodeSystem.supplements is absent. '
        + `${sourceVersion} allows this; ${targetVersion} requires supplements whenever content `
        + 'is "supplement" (invariant csd-4). The supplemented code system cannot be identified '
        + 'from the source, so supplements was marked absent with the data-absent-reason '
        + 'extension ("unknown") instead of inventing a canonical; replace it with the real '
        + 'canonical URL to make the supplement usable',
      ));
    }

    return { resource: target, status: statusFromMessages(messages), messages };
  },
};






