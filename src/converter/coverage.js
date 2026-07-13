/**
 * @fileoverview Coverage-level helpers for conversion reports.
 *
 * Coverage describes the claimed completeness of a converter component. It is
 * advisory and separate from runtime status.
 */

/**
 * Coverage levels for a converter component (the FML step or a postprocessor).
 *
 * Completeness is judged against the conversions that are NECESSARY to map
 * standard, valid input from the source version to the target version.
 *
 * In particular, inter-version-extension (IVE) round-trip preservation is not a
 * factor. A component may therefore be COMPLETE without implementing IVE handling.
 *
 * - NOT_REVIEWED: completeness has not been assessed (functional default).
 * - PARTIAL: some, but not all, necessary conversions are implemented.
 * - COMPLETE: all necessary conversions for valid input are implemented.
 * - NEUTRAL: makes no completeness claim; exempt from ordered comparison and
 *            ignored by the rollups (used by coverage-agnostic postprocessors).
 */
export const COVERAGE = Object.freeze({
  NOT_REVIEWED: 'not_reviewed',
  PARTIAL: 'partial',
  COMPLETE: 'complete',
  NEUTRAL: 'neutral',
});

const ORDERED_COVERAGES = [
  COVERAGE.NOT_REVIEWED,
  COVERAGE.PARTIAL,
  COVERAGE.COMPLETE,
];

const COVERAGES = new Set([
  ...ORDERED_COVERAGES,
  COVERAGE.NEUTRAL,
]);

const COVERAGE_RANK = new Map(ORDERED_COVERAGES.map((level, index) => [level, index]));

/**
 * Return whether a value is a known coverage level.
 *
 * @param {string} value Value to test.
 * @returns {boolean} True when value is a known coverage level.
 */
export function isCoverageLevel(value) {
  return COVERAGES.has(value);
}

/**
 * Return whether a coverage value participates in ordered comparisons.
 *
 * @param {string} coverage Coverage level to test.
 * @returns {boolean} True when coverage is not neutral.
 */
export function isOrderedCoverage(coverage) {
  return COVERAGE_RANK.has(coverage);
}

/**
 * Return the rank of an ordered coverage level.
 *
 * @param {string} coverage Coverage level to rank.
 * @returns {number} Numeric rank, lower means less complete.
 * @throws {Error} If coverage is unknown or neutral.
 */
export function coverageRank(coverage) {
  if (!isCoverageLevel(coverage)) throw new Error(`Unknown coverage level: ${coverage}`);
  if (!isOrderedCoverage(coverage)) throw new Error(`Coverage level is not ordered: ${coverage}`);
  return COVERAGE_RANK.get(coverage);
}

/**
 * Return whether left coverage is lower than right coverage.
 *
 * Neutral is exempt from ordering and cannot be compared here.
 *
 * @param {string} left First ordered coverage level.
 * @param {string} right Second ordered coverage level.
 * @returns {boolean} True when left is lower than right.
 */
export function coverageLessThan(left, right) {
  return coverageRank(left) < coverageRank(right);
}

/**
 * Validate a coverage level.
 *
 * @param {string} coverage Coverage level to validate.
 * @param {string} [label='coverage'] Human-readable field label.
 * @throws {Error} If coverage is unknown.
 */
export function assertCoverageLevel(coverage, label = 'coverage') {
  if (!isCoverageLevel(coverage)) throw new Error(`Invalid ${label}: ${coverage}`);
}

/**
 * Return the coverage that governs a single hop after a sequence of components.
 * See also assertNonDecreasingCoverage() - whether coverage is allowed to decrease
 * along the postprocessor chain is controlled at a higher level.
 *
 * Later non-neutral coverage overrides earlier coverage. Neutral or missing
 * (default to neutral) coverage leaves the running coverage unchanged (coverage is
 * optional on postprocessor descriptors; see processorDescriptor.js).
 *
 * @param {string} initialCoverage FML-stage coverage for the hop.
 * @param {Array<string|null|undefined>} coverages Later processor coverage levels.
 * @returns {string} Governing coverage for the hop.
 */
export function rollupHopCoverage(initialCoverage, coverages = []) {
  assertCoverageLevel(initialCoverage, 'initialCoverage');
  let current = initialCoverage;

  for (const coverage of coverages) {
    if (coverage == null || coverage === COVERAGE.NEUTRAL) continue;
    assertCoverageLevel(coverage);
    current = coverage;
  }

  return current;
}

/**
 * Return the lowest ordered coverage across a chain of hops.
 *
 * Neutral hop coverage is ignored because it makes no completeness claim. At
 * least one ordered hop coverage is required.
 *
 * @param {string[]} hopCoverages Governing coverage for each hop.
 * @returns {string} Overall chain coverage.
 * @throws {Error} If no ordered coverage is present.
 */
export function rollupChainCoverage(hopCoverages) {
  if (!Array.isArray(hopCoverages) || hopCoverages.length === 0) {
    throw new Error('At least one hop coverage is required');
  }

  let lowest = null;
  for (const coverage of hopCoverages) {
    assertCoverageLevel(coverage);
    if (coverage === COVERAGE.NEUTRAL) continue;
    if (lowest === null || coverageLessThan(coverage, lowest)) lowest = coverage;
  }

  if (lowest === null) throw new Error('At least one ordered hop coverage is required');
  return lowest;
}

/**
 * Assert that coverage level of the postprocessors never decreases along a hop.
 * Generally speaking, adding a postprocessor should not make things worse -
 * reduce the completeness of the conversion.
 *
 * Neutral coverage is ignored for the comparison and carries the current level
 * forward. A descriptor with no coverage field is treated as neutral (coverage
 * is optional on postprocessor descriptors; see processorDescriptor.js).
 *
 * @param {string} initialCoverage FML-stage coverage for the hop.
 * @param {Array<{name?: string, coverage?: string}>} processors Processor descriptors.
 * @throws {Error} If any processor declares lower coverage than the running level.
 */
export function assertNonDecreasingCoverage(initialCoverage, processors = []) {
  assertCoverageLevel(initialCoverage, 'initialCoverage');
  let current = initialCoverage;

  for (const processor of processors) {
    const coverage = processor?.coverage;
    if (coverage == null || coverage === COVERAGE.NEUTRAL) continue;
    assertCoverageLevel(coverage, `coverage for ${processor?.name || '<unnamed processor>'}`);

    if (coverageLessThan(coverage, current)) {
      const name = processor?.name || '<unnamed processor>';
      throw new Error(`Coverage decreases at ${name}: ${current} -> ${coverage}`);
    }

    current = coverage;
  }
}

