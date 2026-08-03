/**
 * Tests for the postprocessor combination policy.
 */
import { strict as assert } from 'node:assert';
import {
  POSTPROCESS_POLICY,
  assertPostprocessPolicy,
  isPostprocessPolicy,
  resolvePostprocessors,
} from '../../../src/converter/postprocessPolicy.js';

const A = { name: 'registryA' };
const B = { name: 'registryB' };
const C = { name: 'callerC' };


describe('converter/postprocessPolicy', function () {

  describe('validation', function () {
    it('recognizes valid policies', function () {
      assert.equal(isPostprocessPolicy('append'), true);
      assert.equal(isPostprocessPolicy('replace'), true);
      assert.equal(isPostprocessPolicy('bogus'), false);
    });

    it('assertPostprocessPolicy throws on an unknown value', function () {
      assert.doesNotThrow(() => assertPostprocessPolicy(POSTPROCESS_POLICY.APPEND));
      assert.throws(() => assertPostprocessPolicy('bogus'), /Invalid postprocessPolicy/);
    });
  });

  describe('resolvePostprocessors', function () {
    it('appends caller processors after the registry (default)', function () {
      const out = resolvePostprocessors([A, B], [C], POSTPROCESS_POLICY.APPEND);
      assert.deepEqual(out, [A, B, C]);
    });

    it('replaces registry processors with the caller list', function () {
      const out = resolvePostprocessors([A, B], [C], POSTPROCESS_POLICY.REPLACE);
      assert.deepEqual(out, [C]);
    });

    it('uses the registry list when the caller supplies none (null/undefined)', function () {
      assert.deepEqual(resolvePostprocessors([A, B], undefined, POSTPROCESS_POLICY.REPLACE), [A, B]);
      assert.deepEqual(resolvePostprocessors([A, B], null, POSTPROCESS_POLICY.APPEND), [A, B]);
    });

    it('honors an explicit empty caller list per policy', function () {
      // replace with [] intentionally removes the registry's postprocessors.
      assert.deepEqual(resolvePostprocessors([A, B], [], POSTPROCESS_POLICY.REPLACE), []);
      // append with [] leaves the registry list unchanged.
      assert.deepEqual(resolvePostprocessors([A, B], [], POSTPROCESS_POLICY.APPEND), [A, B]);
    });

    it('defaults to append', function () {
      assert.deepEqual(resolvePostprocessors([A], [C]), [A, C]);
    });

    it('returns a fresh array (no aliasing of inputs)', function () {
      const registry = [A];
      const out = resolvePostprocessors(registry, [C]);
      out.push(B);
      assert.deepEqual(registry, [A]);   // input untouched
    });

    it('throws on an invalid policy', function () {
      assert.throws(() => resolvePostprocessors([A], [C], 'bogus'), /Invalid postprocessPolicy/);
    });
  });
});


