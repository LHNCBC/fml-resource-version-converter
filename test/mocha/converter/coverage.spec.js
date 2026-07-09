/**
 * Tests for conversion coverage helpers.
 */
import { strict as assert } from 'node:assert';
import {
  assertNonDecreasingCoverage,
  coverageLessThan,
  coverageRank,
  COVERAGE,
  isCoverageLevel,
  isOrderedCoverage,
  rollupChainCoverage,
  rollupHopCoverage,
} from '../../../src/converter/coverage.js';


describe('converter/coverage', function () {
  it('recognizes known coverage levels', function () {
    assert.equal(isCoverageLevel(COVERAGE.NOT_REVIEWED), true);
    assert.equal(isCoverageLevel(COVERAGE.PARTIAL), true);
    assert.equal(isCoverageLevel(COVERAGE.COMPLETE), true);
    assert.equal(isCoverageLevel(COVERAGE.NEUTRAL), true);
    assert.equal(isCoverageLevel('unknown'), false);
  });

  it('orders only non-neutral coverage levels', function () {
    assert.equal(isOrderedCoverage(COVERAGE.NOT_REVIEWED), true);
    assert.equal(isOrderedCoverage(COVERAGE.PARTIAL), true);
    assert.equal(isOrderedCoverage(COVERAGE.COMPLETE), true);
    assert.equal(isOrderedCoverage(COVERAGE.NEUTRAL), false);
  });

  it('ranks coverage levels from least to most complete', function () {
    assert.equal(coverageRank(COVERAGE.NOT_REVIEWED), 0);
    assert.equal(coverageRank(COVERAGE.PARTIAL), 1);
    assert.equal(coverageRank(COVERAGE.COMPLETE), 2);
    assert.throws(() => coverageRank(COVERAGE.NEUTRAL), /not ordered/);
  });

  it('compares ordered coverage levels', function () {
    assert.equal(coverageLessThan(COVERAGE.NOT_REVIEWED, COVERAGE.PARTIAL), true);
    assert.equal(coverageLessThan(COVERAGE.COMPLETE, COVERAGE.PARTIAL), false);
  });

  it('rolls up hop coverage by taking the last non-neutral component', function () {
    assert.equal(
      rollupHopCoverage(COVERAGE.NOT_REVIEWED, [COVERAGE.PARTIAL, COVERAGE.NEUTRAL, COVERAGE.COMPLETE]),
      COVERAGE.COMPLETE,
    );
    assert.equal(
      rollupHopCoverage(COVERAGE.PARTIAL, [COVERAGE.NEUTRAL]),
      COVERAGE.PARTIAL,
    );
  });

  it('rolls up chain coverage to the weakest ordered hop', function () {
    assert.equal(
      rollupChainCoverage([COVERAGE.COMPLETE, COVERAGE.PARTIAL, COVERAGE.COMPLETE]),
      COVERAGE.PARTIAL,
    );
    assert.equal(
      rollupChainCoverage([COVERAGE.NEUTRAL, COVERAGE.COMPLETE]),
      COVERAGE.COMPLETE,
    );
  });

  it('rejects chain rollup with no ordered coverage', function () {
    assert.throws(() => rollupChainCoverage([]), /At least one hop coverage/);
    assert.throws(() => rollupChainCoverage([COVERAGE.NEUTRAL]), /At least one ordered/);
  });

  it('accepts non-decreasing processor coverage', function () {
    assert.doesNotThrow(() => assertNonDecreasingCoverage(COVERAGE.NOT_REVIEWED, [
      { name: 'first', coverage: COVERAGE.NEUTRAL },
      { name: 'second', coverage: COVERAGE.PARTIAL },
      { name: 'third', coverage: COVERAGE.COMPLETE },
    ]));
  });

  it('rejects decreasing processor coverage', function () {
    assert.throws(() => assertNonDecreasingCoverage(COVERAGE.COMPLETE, [
      { name: 'downgrade', coverage: COVERAGE.PARTIAL },
    ]), /Coverage decreases at downgrade/);
  });

  it('ignores neutral coverage when checking for decreases', function () {
    assert.doesNotThrow(() => assertNonDecreasingCoverage(COVERAGE.COMPLETE, [
      { name: 'tag', coverage: COVERAGE.NEUTRAL },
      { name: 'still-complete', coverage: COVERAGE.COMPLETE },
    ]));
  });

  it('treats missing coverage as neutral in assertNonDecreasingCoverage', function () {
    // Descriptor with no coverage field: skip (do not throw), do not shift running level.
    assert.doesNotThrow(() => assertNonDecreasingCoverage(COVERAGE.COMPLETE, [
      { name: 'noCoverage' },
      { name: 'stillComplete', coverage: COVERAGE.COMPLETE },
    ]));
    assert.doesNotThrow(() => assertNonDecreasingCoverage(COVERAGE.PARTIAL, [
      { name: 'nully', coverage: null },
    ]));
  });

  it('treats missing coverage as neutral in rollupHopCoverage', function () {
    assert.equal(
      rollupHopCoverage(COVERAGE.PARTIAL, [undefined, null, COVERAGE.NEUTRAL]),
      COVERAGE.PARTIAL,
    );
    assert.equal(
      rollupHopCoverage(COVERAGE.NOT_REVIEWED, [undefined, COVERAGE.COMPLETE]),
      COVERAGE.COMPLETE,
    );
  });
});



