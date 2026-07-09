/**
 * Tests for the top-level postprocessor registry.
 */
import { strict as assert } from 'node:assert';
import { COVERAGE } from '../../../src/converter/coverage.js';
import { getAdjacentPairs } from '../../../src/fml_base_conv/create_converter.js';
import { converterContext } from '../../../src/converter/converterContext.js';
import { registeredDirections } from '../../../src/postprocessors/registry.js';

// The package-wired registry, bound to the bundled mappings via the context.
const { registry } = converterContext;


describe('postprocessors/registry', function () {

  describe('lookup', function () {
    it('throws for an unknown resource type (no bundled FML mapping)', function () {
      assert.throws(
        () => registry.lookup('NoSuchResource', 'R4', 'R5'),
        /no FML mapping for NoSuchResource R4->R5/,
      );
    });

    it('throws for an invalid / non-adjacent version pair', function () {
      // R4 <-> R4B has no mapping; R3 -> R5 is non-adjacent (no direct mapping).
      assert.throws(() => registry.lookup('Questionnaire', 'R4', 'R4B'), /no FML mapping/);
      assert.throws(() => registry.lookup('Questionnaire', 'R3', 'R5'), /no FML mapping/);
    });

    it('returns the functional default entry for a valid but unreviewed tuple', function () {
      const entry = registry.lookup('Questionnaire', 'R4', 'R5');
      assert.deepEqual(entry, { fml_coverage: COVERAGE.NOT_REVIEWED, processors: [] });
    });

    it('returns a fresh copy each call (mutation-safe)', function () {
      const a = registry.lookup('Questionnaire', 'R4', 'R5');
      a.processors.push({ name: 'x' });
      a.fml_coverage = COVERAGE.COMPLETE;

      const b = registry.lookup('Questionnaire', 'R4', 'R5');
      assert.deepEqual(b, { fml_coverage: COVERAGE.NOT_REVIEWED, processors: [] });
    });
  });

  describe('direction consistency', function () {
    it('has a sub-registry for every lane-derived adjacent pair (and no extras)', function () {
      const expected = getAdjacentPairs().map(([from, to]) => `${from}->${to}`).sort();
      const actual = registeredDirections().slice().sort();
      assert.deepEqual(actual, expected);
    });
  });
});

