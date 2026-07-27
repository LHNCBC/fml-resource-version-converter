/**
 * Tests for processor-option normalization.
 */
import { strict as assert } from 'node:assert';
import {
  normalizeProcessorOptions,
  resolveSingleHopOptionKeys,
} from '../../../src/converter/processorOptions.js';

const noop = { name: 'noop', execute: r => ({ resource: r, status: 'ok' }) };
const other = { name: 'other', execute: r => ({ resource: r, status: 'ok' }) };

// Single- and multi-hop only differ by the planned hops; the module itself is
// hop-count agnostic and always expects canonical "type:v1->v2" map keys.
const SINGLE = { hops: [['R4', 'R5']], primaryType: 'Questionnaire' };
const MULTI = { hops: [['R3', 'R4'], ['R4', 'R5']], primaryType: 'Questionnaire' };


describe('converter/processorOptions', function () {

  describe('empty options', function () {
    it('yields lookups that never match', function () {
      const { preLookup, postLookup } = normalizeProcessorOptions({}, SINGLE);
      assert.equal(preLookup('Questionnaire', 'R4', 'R5'), undefined);
      assert.equal(postLookup('Questionnaire', 'R4', 'R5'), undefined);
    });
  });

  describe('singular preproc / postproc (outer boundaries)', function () {
    it('preproc matches the primary type on the first hop only', function () {
      const { preLookup } = normalizeProcessorOptions({ preproc: [noop] }, MULTI);
      assert.deepEqual(preLookup('Questionnaire', 'R3', 'R4').map(p => p.name), ['noop']);
      assert.equal(preLookup('Questionnaire', 'R4', 'R5'), undefined);   // not first hop
      assert.equal(preLookup('Observation', 'R3', 'R4'), undefined);     // not primary type
    });

    it('postproc matches the primary type on the last hop only', function () {
      const { postLookup } = normalizeProcessorOptions({ postproc: [noop] }, MULTI);
      const entry = postLookup('Questionnaire', 'R4', 'R5');
      assert.equal(entry.policy, 'append');
      assert.deepEqual(entry.processors.map(p => p.name), ['noop']);
      assert.equal(postLookup('Questionnaire', 'R3', 'R4'), undefined);  // not last hop
    });

    it('postproc honors an explicit { policy, psps } object', function () {
      const { postLookup } = normalizeProcessorOptions(
        { postproc: { policy: 'replace', psps: [noop] } }, SINGLE,
      );
      const entry = postLookup('Questionnaire', 'R4', 'R5');
      assert.equal(entry.policy, 'replace');
      assert.deepEqual(entry.processors.map(p => p.name), ['noop']);
    });

    it('bare list PSPE defaults to append, including empty', function () {
      const { postLookup } = normalizeProcessorOptions({ postproc: [] }, SINGLE);
      assert.deepEqual(postLookup('Questionnaire', 'R4', 'R5'), { policy: 'append', processors: [] });
    });
  });

  describe('plural preprocs / postprocs (keyed, canonical keys)', function () {
    it('map is keyed by canonical "type:v1->v2"', function () {
      const { postLookup } = normalizeProcessorOptions(
        { postprocs: { 'Questionnaire:R4->R5': [noop], 'Observation:R3->R4': [other] } }, MULTI,
      );
      assert.deepEqual(postLookup('Questionnaire', 'R4', 'R5').processors.map(p => p.name), ['noop']);
      assert.deepEqual(postLookup('Observation', 'R3', 'R4').processors.map(p => p.name), ['other']);
      assert.equal(postLookup('Questionnaire', 'R3', 'R4'), undefined);
    });

    it('rejects a type-only key (this module requires canonical keys)', function () {
      assert.throws(
        () => normalizeProcessorOptions({ postprocs: { Questionnaire: [noop] } }, SINGLE),
        /expected "Type:v1->v2"/,
      );
    });

    it('throws on a key that is not a planned hop', function () {
      assert.throws(
        () => normalizeProcessorOptions({ postprocs: { 'Questionnaire:R2->R3': [noop] } }, MULTI),
        /not a hop in this conversion/,
      );
    });

    it('throws on a malformed key', function () {
      assert.throws(
        () => normalizeProcessorOptions({ postprocs: { 'Questionnaire-R4-R5': [noop] } }, MULTI),
        /expected "Type:v1->v2"/,
      );
    });

    it('lookup function form is called as (type, v1, v2)', function () {
      const seen = [];
      const { postLookup } = normalizeProcessorOptions(
        {
          postprocs: (type, v1, v2) => {
            seen.push([type, v1, v2]);
            return v1 === 'R4' && v2 === 'R5' ? [noop] : undefined;
          },
        },
        MULTI,
      );
      assert.deepEqual(postLookup('Questionnaire', 'R4', 'R5').processors.map(p => p.name), ['noop']);
      assert.deepEqual(seen[0], ['Questionnaire', 'R4', 'R5']);
      assert.equal(postLookup('Questionnaire', 'R3', 'R4'), undefined);
    });

    it('a type-only lookup function still works (extra args ignored)', function () {
      const { preLookup } = normalizeProcessorOptions(
        { preprocs: type => (type === 'Questionnaire' ? [noop] : undefined) }, SINGLE,
      );
      assert.deepEqual(preLookup('Questionnaire', 'R4', 'R5').map(p => p.name), ['noop']);
      assert.equal(preLookup('Observation', 'R4', 'R5'), undefined);
    });
  });

  describe('function wrapping', function () {
    it('wraps a named post function with its name and neutral coverage', function () {
      function tagIt(r) { return { resource: r, status: 'ok' }; }
      const { postLookup } = normalizeProcessorOptions({ postproc: [tagIt] }, SINGLE);
      const [desc] = postLookup('Questionnaire', 'R4', 'R5').processors;
      assert.equal(desc.name, 'tagIt');
      assert.equal(desc.coverage, 'neutral');
      assert.equal(typeof desc.execute, 'function');
    });

    it('generates a name for an anonymous function', function () {
      const { postLookup } = normalizeProcessorOptions(
        { postprocs: { 'Questionnaire:R4->R5': [r => ({ resource: r, status: 'ok' })] } }, SINGLE,
      );
      const [desc] = postLookup('Questionnaire', 'R4', 'R5').processors;
      assert.equal(desc.name, 'caller-postproc-0');
    });

    it('wraps a pre function without coverage', function () {
      const { preLookup } = normalizeProcessorOptions(
        { preproc: [r => ({ resource: r, status: 'ok' })] }, SINGLE,
      );
      const [desc] = preLookup('Questionnaire', 'R4', 'R5');
      assert.equal(desc.coverage, undefined);
      assert.equal(desc.name, 'caller-preproc-0');
    });
  });

  describe('validation', function () {
    it('rejects mixing functions and descriptors in one list', function () {
      assert.throws(
        () => normalizeProcessorOptions({ postproc: [noop, r => ({ resource: r, status: 'ok' })] }, SINGLE),
        /all functions or all descriptors/,
      );
    });

    it('rejects a non-array PRPE (no single-entry sugar)', function () {
      assert.throws(
        () => normalizeProcessorOptions({ preproc: noop }, SINGLE),
        /PRPE\) must be an array/,
      );
    });

    it('rejects a bad PSPE shape', function () {
      assert.throws(
        () => normalizeProcessorOptions({ postproc: noop }, SINGLE),
        /PSPE\) must be a list or a/,
      );
    });

    it('rejects an invalid policy', function () {
      assert.throws(
        () => normalizeProcessorOptions({ postproc: { policy: 'bogus', psps: [noop] } }, SINGLE),
        /Invalid postproc.policy/,
      );
    });

    it('rejects supplying both singular and plural on a side', function () {
      assert.throws(
        () => normalizeProcessorOptions({ preproc: [noop], preprocs: { 'Questionnaire:R4->R5': [noop] } }, SINGLE),
        /preproc and preprocs are mutually exclusive/,
      );
      assert.throws(
        () => normalizeProcessorOptions({ postproc: [noop], postprocs: {} }, SINGLE),
        /postproc and postprocs are mutually exclusive/,
      );
    });

    it('rejects a plural value that is neither map nor function', function () {
      assert.throws(
        () => normalizeProcessorOptions({ postprocs: [noop] }, SINGLE),
        /must be a map or a lookup function/,
      );
    });
  });

  describe('resolveSingleHopOptionKeys (single-hop key convenience)', function () {
    const hop = ['R4', 'R5'];

    it('canonicalizes type-only keys in postprocs/preprocs maps', function () {
      const out = resolveSingleHopOptionKeys(
        { postprocs: { Questionnaire: [noop] }, preprocs: { Observation: [other] } }, hop,
      );
      assert.deepEqual(Object.keys(out.postprocs), ['Questionnaire:R4->R5']);
      assert.deepEqual(Object.keys(out.preprocs), ['Observation:R4->R5']);
    });

    it('leaves already-canonical keys unchanged', function () {
      const out = resolveSingleHopOptionKeys({ postprocs: { 'Questionnaire:R4->R5': [noop] } }, hop);
      assert.deepEqual(Object.keys(out.postprocs), ['Questionnaire:R4->R5']);
    });

    it('leaves function (non-map) values untouched', function () {
      const fn = type => (type === 'Questionnaire' ? [noop] : undefined);
      const out = resolveSingleHopOptionKeys({ postprocs: fn }, hop);
      assert.equal(out.postprocs, fn);
    });

    it('leaves singular preproc/postproc untouched', function () {
      const out = resolveSingleHopOptionKeys({ postproc: [noop], preproc: [other] }, hop);
      assert.deepEqual(out.postproc, [noop]);
      assert.deepEqual(out.preproc, [other]);
    });

    it('feeds the shared normalizer so type-only single-hop keys resolve', function () {
      const resolved = resolveSingleHopOptionKeys({ postprocs: { Questionnaire: [noop] } }, hop);
      const { postLookup } = normalizeProcessorOptions(resolved, SINGLE);
      assert.deepEqual(postLookup('Questionnaire', 'R4', 'R5').processors.map(p => p.name), ['noop']);
    });
  });
});
