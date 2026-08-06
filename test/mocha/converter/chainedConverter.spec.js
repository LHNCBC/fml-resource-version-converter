/**
 * Tests for the multi-hop chained converter.
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { COVERAGE } from '../../../src/converter/coverage.js';
import { STATUS } from '../../../src/converter/diagnostics.js';
import { chainedConverter } from '../../../src/converter/chainedConverter.js';

const { convert } = chainedConverter;

const TEST_DATA = path.resolve(import.meta.dirname, '../../data');
const load = f => JSON.parse(fs.readFileSync(path.join(TEST_DATA, f), 'utf-8'));
const r3Questionnaire = load('qn-ver-conv-test-stu3base.json');
const r4Questionnaire = load('qn-ver-conv-test-r4base.json');

const KNOWN_COVERAGES = new Set(Object.values(COVERAGE));


describe('converter/chainedConverter', function () {

  // -------- version validation (delegated to planHops) ---------------------
  describe('version validation', function () {
    it('rejects same-version conversion', function () {
      assert.throws(() => convert(r4Questionnaire, 'R4', 'R4'),
        /source and target versions are the same/);
    });

    it('rejects R4 <-> R4B (no conversion between them)', function () {
      assert.throws(() => convert(r4Questionnaire, 'R4', 'R4B'), /no conversion between them/);
    });

    it('rejects a resource without resourceType (for a valid pair)', function () {
      assert.throws(() => convert({}, 'R3', 'R5'), /resourceType is required/);
    });
  });

  // -------- multi-hop chain ------------------------------------------------
  describe('R3 -> R5 (two hops)', function () {
    let result;
    before(function () { result = convert(r3Questionnaire, 'R3', 'R5'); });

    it('produces one report per hop, in order', function () {
      assert.equal(result.hops.length, 2);
      assert.equal(result.hops[0].fromVer, 'R3');
      assert.equal(result.hops[0].toVer, 'R4');
      assert.equal(result.hops[1].fromVer, 'R4');
      assert.equal(result.hops[1].toVer, 'R5');
      for (const hop of result.hops) {
        assert.equal(hop.fml_base_conv.name, '_FML_');
      }
    });

    it('returns the final converted resource and a rolled-up coverage/status', function () {
      assert.equal(result.resource.resourceType, 'Questionnaire');
      assert.ok(KNOWN_COVERAGES.has(result.coverage));
      assert.ok([STATUS.OK, STATUS.WARNING].includes(result.status));
      // No top-level preprocessors list on the multi-hop result.
      assert.equal('preprocessors' in result, false);
    });
  });

  // -------- single hop is a chain of one ------------------------------------
  describe('R4 -> R5 (chain of length 1)', function () {
    it('produces a single hop entry', function () {
      const result = convert(r4Questionnaire, 'R4', 'R5');
      assert.equal(result.hops.length, 1);
      assert.equal(result.hops[0].fromVer, 'R4');
      assert.equal(result.hops[0].toVer, 'R5');
    });
  });

  // -------- keyed postprocessors target specific hops ----------------------
  describe('hop-keyed postprocs', function () {
    it('runs a caller postproc only on the named hop', function () {
      const stamp = {
        name: 'stamp',
        execute: t => ({ resource: { ...t, language: 'de' }, status: STATUS.OK }),
      };
      const result = convert(r3Questionnaire, 'R3', 'R5', {
        postprocs: { 'Questionnaire:R4->R5': [stamp] },
      });
      const hop0Post = result.hops[0].postprocessors || [];
      const hop1Post = result.hops[1].postprocessors || [];
      assert.equal(hop0Post.some(p => p.name === 'stamp'), false);
      assert.equal(hop1Post.some(p => p.name === 'stamp'), true);
      assert.equal(result.resource.language, 'de');
    });

    it('throws on a postprocs key that is not a planned hop', function () {
      assert.throws(
        () => convert(r3Questionnaire, 'R3', 'R5', {
          postprocs: { 'Questionnaire:R2->R3': [] },
        }),
        /not a hop in this conversion/,
      );
    });

    it('rejects a type-only postprocs key (convert requires tuple keys)', function () {
      assert.throws(
        () => convert(r3Questionnaire, 'R3', 'R5', { postprocs: { Questionnaire: [] } }),
        /expected "Type:v1->v2"/,
      );
    });
  });

  // -------- outer-boundary preproc / postproc ------------------------------
  describe('outer-boundary preproc (PRP) and postproc (PSP)', function () {
    it('runs preproc on the first hop and postproc on the last hop', function () {
      const pre = {
        name: 'seedLang',
        execute: r => ({ resource: { ...r, language: 'fr' }, status: STATUS.OK }),
      };
      const post = {
        name: 'stampLast',
        execute: t => ({ resource: { ...t, title: 'done' }, status: STATUS.OK }),
      };
      const result = convert(r3Questionnaire, 'R3', 'R5', { preproc: [pre], postproc: [post] });

      // PRP lands in hops[0].preprocessors; hops[1] has no preprocessors.
      assert.equal(result.hops[0].preprocessors.some(p => p.name === 'seedLang'), true);
      assert.equal('preprocessors' in result.hops[1], false);

      // PSP lands in the last hop's postprocessors.
      assert.equal(result.hops[1].postprocessors.some(p => p.name === 'stampLast'), true);
      assert.equal((result.hops[0].postprocessors || []).some(p => p.name === 'stampLast'), false);
    });
  });
});
