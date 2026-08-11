/**
 * @fileoverview ValueSet postprocessor for the R5 -> R4 direction.
 *
 * The bundled FML maps every element shared by R5 and R4. This postprocessor
 * reports R5-only content that R4 cannot represent and approximates R5-only
 * filter operators with the closest valid R4 operator. It does not implement
 * inter-version extensions.
 *
 * @module postprocessors/R4_R5/ValueSet
 */
import { COVERAGE } from '../../converter/coverage.js';
import {
  statusFromMessages,
  warningMessage,
} from '../../converter/diagnostics.js';
import { hasAnyContent } from '../util/elements.js';

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
  ['scope', ['scope']],
];

const FILTER_APPROXIMATION_EFFECTS = Object.freeze({
  'child-of': 'also matches indirect descendants',
  'descendent-leaf': 'also matches non-leaf descendants',
});
const R4_FILTER_APPROXIMATION = 'descendent-of';


/**
 * Add a path once when the supplied value has content.
 *
 * @param {Set<string>} paths Paths collecting detected R5-only content.
 * @param {string} path FHIR path to add.
 * @param {*} value Value to inspect.
 */
function addPathForContent(paths, path, value) {
  if (Array.isArray(value) ? value.length > 0 : value != null) paths.add(path);
}

/**
 * Inspect an R5 compose include/exclude entry for R5-only content.
 *
 * @param {Object} entry R5 compose include/exclude entry.
 * @param {'include'|'exclude'} branch Compose branch containing the entry.
 * @param {Set<string>} paths R5-only paths found.
 */
function inspectComposeEntry(entry, branch, paths) {
  if (!entry || typeof entry !== 'object') return;

  const entryPath = `ValueSet.compose.${branch}`;

  if (hasAnyContent(entry, ['copyright', '_copyright'])) {
    paths.add(`${entryPath}.copyright`);
  }

  for (const concept of entry.concept || []) {
    for (const designation of concept?.designation || []) {
      addPathForContent(
        paths,
        `${entryPath}.concept.designation.additionalUse`,
        designation?.additionalUse,
      );
    }
  }
}

/**
 * Inspect expansion contains entries recursively for R5-only properties.
 *
 * @param {Array<Object>|undefined} entries R5 expansion contains entries.
 * @param {Set<string>} paths R5-only paths found.
 */
function inspectExpansionContains(entries, paths) {
  for (const entry of entries || []) {
    addPathForContent(paths, 'ValueSet.expansion.contains.property', entry?.property);
    inspectExpansionContains(entry?.contains, paths);
  }
}

/**
 * Find R5-only ValueSet paths present in a source resource.
 *
 * @param {Object} source R5 ValueSet source.
 * @returns {string[]} Sorted paths.
 */
function findR5OnlyContent(source) {
  const paths = new Set();

  for (const [path, fields] of R5_ONLY_ROOT_FIELDS) {
    if (hasAnyContent(source, fields)) paths.add(`ValueSet.${path}`);
  }

  if (hasAnyContent(source?.compose, ['property', '_property'])) {
    paths.add('ValueSet.compose.property');
  }
  for (const entry of source?.compose?.include || []) {
    inspectComposeEntry(entry, 'include', paths);
  }
  for (const entry of source?.compose?.exclude || []) {
    inspectComposeEntry(entry, 'exclude', paths);
  }

  if (hasAnyContent(source?.expansion, ['next', '_next'])) {
    paths.add('ValueSet.expansion.next');
  }
  addPathForContent(paths, 'ValueSet.expansion.property', source?.expansion?.property);
  inspectExpansionContains(source?.expansion?.contains, paths);

  return [...paths].sort();
}

/**
 * Approximate R5-only filter operators in one target compose entry.
 *
 * `descendent-of` is the closest R4 operator for both R5 additions: its match
 * set is broader than direct children or leaf descendants, but narrower than
 * removing the filter. Replacing only `op` preserves any `_op` companion.
 *
 * @param {Object} entry FML-converted R4 compose include/exclude entry.
 * @param {'include'|'exclude'} branch Compose branch containing the entry.
 * @param {number} entryIndex Entry index within the branch.
 * @param {Array<Object>} messages Diagnostic messages to append.
 * @param {string} targetVersion Target FHIR version named in diagnostics.
 */
function approximateComposeEntryFilters(entry, branch, entryIndex, messages, targetVersion) {
  for (const [filterIndex, filter] of (entry?.filter || []).entries()) {
    const original = filter?.op;
    if (!Object.hasOwn(FILTER_APPROXIMATION_EFFECTS, original)) continue;

    filter.op = R4_FILTER_APPROXIMATION;
    const path = `ValueSet.compose.${branch}[${entryIndex}].filter[${filterIndex}].op`;
    const membershipEffect = branch === 'include'
      ? 'include additional concepts'
      : 'exclude additional concepts';
    messages.push(warningMessage(
      `${path} "${original}" has no exact ${targetVersion} equivalent and was approximated as `
      + `"${R4_FILTER_APPROXIMATION}"; the replacement `
      + `${FILTER_APPROXIMATION_EFFECTS[original]}, so the converted ValueSet may `
      + membershipEffect,
    ));
  }
}

/**
 * Approximate every R5-only filter operator left in the converted target.
 *
 * @param {Object} target FML-converted R4 ValueSet, mutated in place.
 * @param {Array<Object>} messages Diagnostic messages to append.
 * @param {string} targetVersion Target FHIR version named in diagnostics.
 */
function approximateFilterOperators(target, messages, targetVersion) {
  for (const branch of ['include', 'exclude']) {
    for (const [entryIndex, entry] of (target?.compose?.[branch] || []).entries()) {
      approximateComposeEntryFilters(entry, branch, entryIndex, messages, targetVersion);
    }
  }
}

/*
 * FML limitations reported (R5 -> R4):
 * - R5-only metadata, compose, expansion, and scope elements are dropped.
 * - filter operators child-of and descendent-leaf have no R4 equivalent. The
 *   engine preserves them; the postprocessor approximates them as descendent-of
 *   to produce valid R4 and warns about the broadened filter match.
 */

/**
 * R5 -> R4 ValueSet postprocessor descriptor.
 *
 * Reports unavoidable loss and approximates R5-only filter operators as
 * `descendent-of`, the closest valid R4 operator.
 */
export const conv_R5_to_R4 = {
  name: 'ValueSet_R5_to_R4',
  coverage: COVERAGE.BEST_EFFORT,
  description:
    'Reports R5-only ValueSet content dropped during R5->R4 conversion and '
    + 'approximates R5-only filter operators as descendent-of with warnings. Does '
    + 'not handle inter-version extensions.',

  /**
   * @param {Object} target FML-converted R4 ValueSet, mutated in place.
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
        `${sourceVersion}-only ValueSet content was dropped because ${targetVersion} has no `
        + `equivalent: ${paths.join(', ')}`,
      ));
    }

    approximateFilterOperators(target, messages, targetVersion);

    return { resource: target, status: statusFromMessages(messages), messages };
  },
};
