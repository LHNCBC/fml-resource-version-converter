/**
 * Tests for the shared per-hop conversion core.
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { COVERAGE } from '../../../src/converter/coverage.js';
import { MESSAGE_TYPE, STATUS } from '../../../src/converter/diagnostics.js';
import { runHop } from '../../../src/converter/runHop.js';

const TEST_DATA = path.resolve(import.meta.dirname, '../../data');
const r4Questionnaire = JSON.parse(
  fs.readFileSync(path.join(TEST_DATA, 'qn-ver-conv-test-r4base.json'), 'utf-8'),
);

/** Fresh, mutation-safe copy of the fixture (runHop does not clone). */
function q() {
  return structuredClone(r4Questionnaire);
}

/** Build a caller pre lookup that answers for the given (type, v1, v2). */
function preLookupFor(type, v1, v2, list) {
  return (t, a, b) => (t === type && a === v1 && b === v2 ? list : undefined);
}

/** Build a caller post lookup that answers for the given (type, v1, v2). */
function postLookupFor(type, v1, v2, entry) {
  return (t, a, b) => (t === type && a === v1 && b === v2 ? entry : undefined);
}


describe('converter/runHop', function () {

  describe('validation', function () {
    it('requires a resourceType', function () {
      assert.throws(() => runHop({}, 'R4', 'R5'), /resourceType is required/);
    });

    it('throws when no FML mapping exists', function () {
      assert.throws(
        () => runHop({ resourceType: 'NoSuchResource' }, 'R4', 'R5'),
        /no direct FML mapping for NoSuchResource/,
      );
    });
  });

  describe('basic hop (Questionnaire R4 -> R5, no processors)', function () {
    let out;
    before(function () { out = runHop(q(), 'R4', 'R5'); });

    it('returns the converted resource and hop coverage', function () {
      assert.equal(out.resource.resourceType, 'Questionnaire');
      assert.equal(out.hopCoverage, COVERAGE.COMPLETE);
      assert.ok([STATUS.OK, STATUS.WARNING].includes(out.status));
    });

    it('produces a fragment with the _FML_ report and no processor arrays', function () {
      assert.deepEqual(Object.keys(out.fragment).filter(k => k !== 'fml_base_conv'),
        ['fromVer', 'toVer']);
      assert.equal(out.fragment.fromVer, 'R4');
      assert.equal(out.fragment.toVer, 'R5');
      assert.equal(out.fragment.fml_base_conv.name, '_FML_');
      assert.equal(out.fragment.fml_base_conv.coverage, COVERAGE.COMPLETE);
      assert.equal('preprocessors' in out.fragment, false);
      assert.equal('postprocessors' in out.fragment, false);
    });
  });

  describe('preprocessors (from preLookup)', function () {
    it('runs them before FML and records a fragment.preprocessors entry', function () {
      let seenCtx = null;
      const pre = {
        name: 'seedLang',
        execute(resource, ctx) {
          seenCtx = ctx;
          return { resource: { ...resource, language: 'fr' }, status: STATUS.OK };
        },
      };
      const out = runHop(q(), 'R4', 'R5', {
        preLookup: preLookupFor('Questionnaire', 'R4', 'R5', [pre]),
      });
      assert.deepEqual(seenCtx, { fromVer: 'R4', toVer: 'R5' });
      assert.equal(out.fragment.preprocessors.length, 1);
      assert.equal(out.fragment.preprocessors[0].name, 'seedLang');
      assert.equal(out.resource.language, 'fr');
    });
  });

  describe('postprocessors (from postLookup)', function () {
    it('combines with the registry (append) and sees sourceResource', function () {
      let seenCtx = null;
      const pre = {
        name: 'seedLang',
        execute: r => ({ resource: { ...r, language: 'fr' }, status: STATUS.OK }),
      };
      const post = {
        name: 'stamp',
        coverage: COVERAGE.COMPLETE,
        execute(target, ctx) {
          seenCtx = ctx;
          return { resource: { ...target, language: 'de' }, status: STATUS.OK };
        },
      };
      const out = runHop(q(), 'R4', 'R5', {
        preLookup: preLookupFor('Questionnaire', 'R4', 'R5', [pre]),
        postLookup: postLookupFor('Questionnaire', 'R4', 'R5', {
          policy: 'append', processors: [post],
        }),
      });
      // sourceResource is the FML input (post-preproc).
      assert.equal(seenCtx.sourceResource.language, 'fr');
      assert.equal(seenCtx.fromVer, 'R4');
      assert.equal(out.fragment.postprocessors.length, 1);
      assert.equal(out.fragment.postprocessors[0].coverage, COVERAGE.COMPLETE);
      assert.equal(out.resource.language, 'de');
    });

    it('defaults missing postprocessor coverage to neutral in the report', function () {
      const post = { name: 'noCov', execute: t => ({ resource: t, status: STATUS.OK }) };
      const out = runHop(q(), 'R4', 'R5', {
        postLookup: postLookupFor('Questionnaire', 'R4', 'R5', { processors: [post] }),
      });
      assert.equal(out.fragment.postprocessors[0].coverage, COVERAGE.NEUTRAL);
    });
  });

  describe('checkCoverage', function () {
    const decreasing = {
      policy: 'append',
      processors: [
        { name: 'a', coverage: COVERAGE.COMPLETE, execute: r => ({ resource: r, status: STATUS.OK }) },
        { name: 'b', coverage: COVERAGE.KNOWN_GAPS, execute: r => ({ resource: r, status: STATUS.OK }) },
      ],
    };

    it('rejects decreasing coverage by default', function () {
      assert.throws(
        () => runHop(q(), 'R4', 'R5', {
          postLookup: postLookupFor('Questionnaire', 'R4', 'R5', decreasing),
        }),
        /Coverage decreases at b/,
      );
    });

    it('accepts decreasing coverage when checkCoverage is false', function () {
      assert.doesNotThrow(() => runHop(q(), 'R4', 'R5', {
        checkCoverage: false,
        postLookup: postLookupFor('Questionnaire', 'R4', 'R5', decreasing),
      }));
    });
  });

  describe('warning invariant', function () {
    it('rejects a processor claiming warning with no warning message', function () {
      const bad = { name: 'liar', execute: r => ({ resource: r, status: STATUS.WARNING }) };
      assert.throws(
        () => runHop(q(), 'R4', 'R5', {
          postLookup: postLookupFor('Questionnaire', 'R4', 'R5', { processors: [bad] }),
        }),
        /liar.*no warning message/,
      );
    });

    it('propagates a preprocessor warning to the hop status', function () {
      const warner = {
        name: 'warner',
        execute: r => ({
          resource: r,
          status: STATUS.WARNING,
          messages: [{ type: MESSAGE_TYPE.WARNING, text: 'heads up' }],
        }),
      };
      const out = runHop(q(), 'R4', 'R5', {
        preLookup: preLookupFor('Questionnaire', 'R4', 'R5', [warner]),
      });
      assert.equal(out.status, STATUS.WARNING);
    });
  });
});

