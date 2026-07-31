/**
 * Tests for the single-hop integration converter.
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { COVERAGE } from '../../../src/converter/coverage.js';
import { MESSAGE_TYPE, STATUS } from '../../../src/converter/diagnostics.js';
import { convertSingleHop } from '../../../src/converter/singleHopConverter.js';

const TEST_DATA = path.resolve(import.meta.dirname, '../../data');
const r4Questionnaire = JSON.parse(
  fs.readFileSync(path.join(TEST_DATA, 'qn-ver-conv-test-r4base.json'), 'utf-8'),
);
const r5Questionnaire = JSON.parse(
  fs.readFileSync(path.join(TEST_DATA, 'qn-ver-conv-test-r5base.json'), 'utf-8'),
);


describe('converter/singleHopConverter', function () {


  // -------- version validation ---------------------------------------------
  describe('version validation', function () {
    // No FML mapping files ship for unsupported/non-adjacent version pairs,
    // so the mapping gate rejects them before any conversion is attempted.
    it('rejects R4 <-> R4B (no mapping ships)', function () {
      assert.throws(() => convertSingleHop(r4Questionnaire, 'R4', 'R4B'), /no direct FML mapping/);
    });

    it('rejects a non-adjacent pair (multi-hop)', function () {
      assert.throws(() => convertSingleHop(r4Questionnaire, 'R3', 'R5'), /no direct FML mapping/);
    });
  });

  // -------- resource validation --------------------------------------------
  describe('resource validation', function () {
    it('rejects non-object resource', function () {
      assert.throws(() => convertSingleHop(null, 'R4', 'R5'), /resourceType is required/);
      assert.throws(() => convertSingleHop('string', 'R4', 'R5'), /resourceType is required/);
      assert.throws(() => convertSingleHop([], 'R4', 'R5'), /resourceType is required/);
    });

    it('rejects resource without resourceType', function () {
      assert.throws(() => convertSingleHop({}, 'R4', 'R5'), /resourceType is required/);
    });

    it('throws when no FML mapping exists for the resource type', function () {
      assert.throws(
        () => convertSingleHop({ resourceType: 'NoSuchResource' }, 'R4', 'R5'),
        /no direct FML mapping for NoSuchResource/,
      );
    });

    it('rejects an invalid targetResourceType option', function () {
      assert.throws(
        () => convertSingleHop(r4Questionnaire, 'R4', 'R5', {
          targetResourceType: '',
        }),
        /targetResourceType must be a non-empty string/,
      );
      assert.throws(
        () => convertSingleHop(r4Questionnaire, 'R4', 'R5', {
          targetResourceType: 42,
        }),
        /targetResourceType must be a non-empty string/,
      );
    });
  });

  // -------- renamed and ambiguous resource mappings -------------------------
  describe('renamed and ambiguous resource mappings', function () {
    it('converts Sequence R3 to MolecularSequence R4', function () {
      const result = convertSingleHop({
        resourceType: 'Sequence',
        id: 'sequence-r3',
        type: 'dna',
        coordinateSystem: 0,
      }, 'R3', 'R4');

      assert.equal(result.resource.resourceType, 'MolecularSequence');
      assert.equal(result.resource.id, 'sequence-r3');
    });

    it('converts MolecularSequence R4 to Sequence R3', function () {
      const result = convertSingleHop({
        resourceType: 'MolecularSequence',
        id: 'sequence-r4',
        type: 'dna',
        coordinateSystem: 0,
      }, 'R4', 'R3');

      assert.equal(result.resource.resourceType, 'Sequence');
      assert.equal(result.resource.id, 'sequence-r4');
    });

    it('rejects an ambiguous source before running preprocessors', function () {
      let preprocessorRan = false;
      const preprocessor = {
        name: 'must-not-run',
        execute(resource) {
          preprocessorRan = true;
          return { resource, status: STATUS.OK };
        },
      };

      assert.throws(
        () => convertSingleHop(
          { resourceType: 'ServiceRequest', status: 'active', intent: 'order' },
          'R4',
          'R3',
          { preprocs: [preprocessor] },
        ),
        /targetResourceType is required.*ProcedureRequest, ReferralRequest/,
      );
      assert.equal(preprocessorRan, false);
    });

    it('uses targetResourceType to select the ServiceRequest target mapping', function () {
      const input = {
        resourceType: 'ServiceRequest',
        id: 'service-request-r4',
        status: 'active',
        intent: 'order',
        subject: { reference: 'Patient/example' },
      };

      const procedure = convertSingleHop(input, 'R4', 'R3', {
        targetResourceType: 'ProcedureRequest',
      });
      const referral = convertSingleHop(input, 'R4', 'R3', {
        targetResourceType: 'ReferralRequest',
      });

      assert.equal(procedure.resource.resourceType, 'ProcedureRequest');
      assert.equal(referral.resource.resourceType, 'ReferralRequest');
    });
  });

  // -------- happy path -----------------------------------------------------
  describe('single hop: Questionnaire R4 -> R5, no processors', function () {
    let result;

    before(function () {
      result = convertSingleHop(r4Questionnaire, 'R4', 'R5');
    });

    it('returns the standard result object shape', function () {
      assert.equal(typeof result, 'object');
      // Environmental noise (absent contained/standalone maps) no longer forces
      // a warning; a fixture may still legitimately warn if a rule hits a lossy
      // translation, so accept either ok or warning and check the invariant.
      assert.ok([STATUS.OK, STATUS.WARNING].includes(result.status));
      assert.equal(result.coverage, COVERAGE.COMPLETE);
      // Flat result: no hops array; the FML report is at the top level.
      assert.equal('hops' in result, false);
      assert.equal(typeof result.fml_base_conv, 'object');
      assert.equal('preprocessors' in result, false);
      assert.equal('postprocessors' in result, false);
    });

    it('converts the resource', function () {
      assert.equal(result.resource.resourceType, 'Questionnaire');
      assert.equal(result.resource.id, r4Questionnaire.id);
    });

    it('does not mutate the caller input', function () {
      // The result.resource must not be the same object as the input.
      assert.notEqual(result.resource, r4Questionnaire);
    });

    it('describes the FML engine step in the result', function () {
      const fml = result.fml_base_conv;
      assert.equal(fml.name, '_FML_');
      assert.equal(fml.coverage, COVERAGE.COMPLETE);
      assert.ok([STATUS.OK, STATUS.WARNING].includes(fml.status));
      assert.equal(Array.isArray(fml.messages), true);
      // Warning-invariant: if status is warning, at least one warning message.
      if (fml.status === STATUS.WARNING) {
        assert.ok(fml.messages.some(m => m.type === MESSAGE_TYPE.WARNING));
      }
      assert.equal('postprocessors' in result, false);
    });
  });

  // -------- environmental noise must not affect conversion status ----------
  describe('clean conversion reports ok (no environmental warning noise)', function () {
    it('a minimal valid Questionnaire R4->R5 has status ok and no warnings', function () {
      const q = {
        resourceType: 'Questionnaire',
        status: 'active',
        item: [{ linkId: 'q1', type: 'choice', answerOption: [{ valueCoding: { code: 'b' } }] }],
      };
      const res = convertSingleHop(q, 'R4', 'R5');
      assert.equal(res.status, STATUS.OK);
      const warnings = res.fml_base_conv.messages.filter(m => m.type === MESSAGE_TYPE.WARNING);
      assert.equal(
        warnings.length, 0,
        'absent contained ConceptMaps must not surface as conversion warnings',
      );
    });

    it('reports complete only while preserving valid primitive metadata', function () {
      /**
       * Build distinctive primitive metadata for one test field.
       *
       * @param {string} label Field label.
       * @returns {Object} Primitive companion.
       */
      const extension = label => ({
        id: `${label}-id`,
        extension: [{
          url: `http://example.org/fhir/StructureDefinition/${label}`,
          valueString: 'kept',
        }],
      });
      const q = {
        resourceType: 'Questionnaire',
        language: 'en',
        _language: extension('language'),
        _implicitRules: extension('implicit-rules-only'),
        status: 'active',
        _status: extension('status'),
        item: [{
          linkId: 'q1',
          _linkId: extension('link-id'),
          type: 'choice',
          _type: extension('type'),
        }, {
          _linkId: extension('link-id-only'),
          type: 'string',
        }],
      };

      const result = convertSingleHop(q, 'R4', 'R5');

      assert.equal(result.status, STATUS.OK);
      assert.equal(result.coverage, COVERAGE.COMPLETE);
      assert.equal(result.resource.language, q.language);
      assert.deepEqual(result.resource._language, q._language);
      assert.equal('implicitRules' in result.resource, false);
      assert.deepEqual(result.resource._implicitRules, q._implicitRules);
      assert.deepEqual(result.resource._status, q._status);
      assert.deepEqual(result.resource.item[0]._linkId, q.item[0]._linkId);
      assert.deepEqual(result.resource.item[0]._type, q.item[0]._type);
      assert.equal('linkId' in result.resource.item[1], false);
      assert.deepEqual(result.resource.item[1]._linkId, q.item[1]._linkId);
    });
  });

  // -------- preprocessors --------------------------------------------------
  describe('preprocessors', function () {
    it('runs a preprocessor before the FML engine and records it', function () {
      let seenCtx = null;
      let seenInput = null;
      const preproc = {
        name: 'tagInput',
        execute(resource, ctx) {
          seenCtx = ctx;
          seenInput = resource;
          const out = { ...resource, language: 'en' };
          return { resource: out, status: STATUS.OK };
        },
      };

      const result = convertSingleHop(r4Questionnaire, 'R4', 'R5', { preprocs: [preproc] });

      assert.deepEqual(seenCtx, { fromVer: 'R4', toVer: 'R5' });
      // Preproc input is the cloned resource, not the caller's object.
      assert.notEqual(seenInput, r4Questionnaire);
      assert.equal(seenInput.resourceType, 'Questionnaire');

      assert.equal(result.preprocessors.length, 1);
      assert.equal(result.preprocessors[0].name, 'tagInput');
      assert.equal(result.preprocessors[0].status, STATUS.OK);
      // Top-level status may be warning (from FML engine); the preproc
      // itself returned ok so its own report status is ok above.
      assert.ok([STATUS.OK, STATUS.WARNING].includes(result.status));
      // The preproc-injected field flows through the FML step.
      assert.equal(result.resource.language, 'en');
    });

    it('propagates a preprocessor warning to the top-level status', function () {
      const preproc = {
        name: 'warner',
        execute(resource) {
          return {
            resource,
            status: STATUS.WARNING,
            messages: [{ type: MESSAGE_TYPE.WARNING, text: 'heads up' }],
          };
        },
      };

      const result = convertSingleHop(r4Questionnaire, 'R4', 'R5', { preprocs: [preproc] });
      assert.equal(result.status, STATUS.WARNING);
      assert.equal(result.preprocessors[0].status, STATUS.WARNING);
    });

    it('rejects a preprocessor that violates the warning invariant', function () {
      const bad = {
        name: 'liar',
        execute(resource) {
          return { resource, status: STATUS.WARNING };   // no warning message
        },
      };
      assert.throws(
        () => convertSingleHop(r4Questionnaire, 'R4', 'R5', { preprocs: [bad] }),
        /liar.*no warning message/,
      );
    });
  });

  // -------- postprocessors -------------------------------------------------
  describe('postprocessors', function () {
    it('runs postprocessors after the FML step with sourceResource in ctx', function () {
      let seenCtx = null;
      let seenTarget = null;
      const post = {
        name: 'stamper',
        coverage: COVERAGE.COMPLETE,
        execute(target, ctx) {
          seenCtx = ctx;
          seenTarget = target;
          return { resource: { ...target, language: 'de' }, status: STATUS.OK };
        },
      };
      const preproc = {
        name: 'seedLanguage',
        execute(resource) {
          return { resource: { ...resource, language: 'fr' }, status: STATUS.OK };
        },
      };

      const result = convertSingleHop(r4Questionnaire, 'R4', 'R5', {
        preprocs: [preproc],
        postprocs: [post],
      });

      // sourceResource for the postproc is the input to the FML step
      // (i.e. after preproc, before FML).
      assert.equal(seenCtx.fromVer, 'R4');
      assert.equal(seenCtx.toVer, 'R5');
      assert.equal(seenCtx.sourceResource.language, 'fr');
      // The target passed in is the FML output.
      assert.equal(seenTarget.resourceType, 'Questionnaire');

      assert.equal(result.postprocessors.length, 1);
      assert.equal(result.postprocessors[0].name, 'stamper');
      assert.equal(result.postprocessors[0].coverage, COVERAGE.COMPLETE);
      assert.equal(result.postprocessors[0].status, STATUS.OK);

      // Hop coverage rolls up to complete (postproc's coverage).
      assert.equal(result.coverage, COVERAGE.COMPLETE);
      // Postproc-injected field is present in final resource.
      assert.equal(result.resource.language, 'de');
    });

    it('defaults missing postprocessor coverage to neutral in the report', function () {
      const post = {
        name: 'noCoverage',
        execute(target) {
          return { resource: target, status: STATUS.OK };
        },
      };
      const result = convertSingleHop(r4Questionnaire, 'R4', 'R5', {
        postprocs: [post],
      });
      assert.equal(result.postprocessors[0].coverage, COVERAGE.NEUTRAL);
    });
  });

  // -------- checkCoverage --------------------------------------------------
  describe('checkCoverage', function () {
    const completeThenKnownGaps = () => [
      { name: 'first',  coverage: COVERAGE.COMPLETE, execute: r => ({ resource: r, status: STATUS.OK }) },
      { name: 'second', coverage: COVERAGE.KNOWN_GAPS, execute: r => ({ resource: r, status: STATUS.OK }) },
    ];

    it('rejects decreasing coverage by default', function () {
      assert.throws(
        () => convertSingleHop(r4Questionnaire, 'R4', 'R5', {
          postprocs: completeThenKnownGaps(),
        }),
        /Coverage decreases at second/,
      );
    });

    it('accepts decreasing coverage when checkCoverage is false', function () {
      assert.doesNotThrow(() => convertSingleHop(r4Questionnaire, 'R4', 'R5', {
        postprocs: completeThenKnownGaps(),
        checkCoverage: false,
      }));
    });
  });

  // -------- postprocessPolicy ----------------------------------------------
  describe('postprocessPolicy', function () {
    it('rejects an invalid postprocessPolicy', function () {
      assert.throws(
        () => convertSingleHop(r4Questionnaire, 'R4', 'R5', { postprocessPolicy: 'bogus' }),
        /Invalid postprocessPolicy/,
      );
    });

    it('runs caller postprocs (append is the default)', function () {
      const post = {
        name: 'tag',
        execute: t => ({ resource: { ...t, language: 'de' }, status: STATUS.OK }),
      };
      const result = convertSingleHop(r4Questionnaire, 'R4', 'R5', { postprocs: [post] });
      assert.equal(result.postprocessors.length, 1);
      assert.equal(result.resource.language, 'de');
    });
  });

  // -------- processor contract enforcement ---------------------------------
  describe('processor contract enforcement', function () {
    it('rejects a non-array preprocs option', function () {
      assert.throws(
        () => convertSingleHop(r4Questionnaire, 'R4', 'R5', { preprocs: {} }),
        /opts\.preprocs must be an array/,
      );
    });

    it('rejects a non-array postprocs option', function () {
      assert.throws(
        () => convertSingleHop(r4Questionnaire, 'R4', 'R5', { postprocs: 'nope' }),
        /opts\.postprocs must be an array/,
      );
    });

    it('rejects a caller postprocessor with an empty name', function () {
      const bad = { name: '', execute: t => ({ resource: t, status: STATUS.OK }) };
      assert.throws(
        () => convertSingleHop(r4Questionnaire, 'R4', 'R5', { postprocs: [bad] }),
        /postprocessor\.name must be a non-empty string/,
      );
    });

    it('rejects a caller processor whose execute is not a function', function () {
      const bad = { name: 'noExec', execute: 'not-a-function' };
      assert.throws(
        () => convertSingleHop(r4Questionnaire, 'R4', 'R5', { postprocs: [bad] }),
        /postprocessor\.execute must be a function/,
      );
    });

    it('rejects a caller postprocessor with an invalid coverage', function () {
      const bad = {
        name: 'badCoverage',
        coverage: 'super-complete',
        execute: t => ({ resource: t, status: STATUS.OK }),
      };
      assert.throws(
        () => convertSingleHop(r4Questionnaire, 'R4', 'R5', { postprocs: [bad] }),
        /coverage/,
      );
    });

    it('rejects a processor result whose messages is not an array', function () {
      const bad = {
        name: 'badMessages',
        execute: t => ({ resource: t, status: STATUS.OK, messages: 'not-an-array' }),
      };
      assert.throws(
        () => convertSingleHop(r4Questionnaire, 'R4', 'R5', { postprocs: [bad] }),
        /messages must be an array/,
      );
    });

    it('treats null preprocs/postprocs as "not provided" (no throw)', function () {
      assert.doesNotThrow(
        () => convertSingleHop(r4Questionnaire, 'R4', 'R5', {
          preprocs: null,
          postprocs: null,
        }),
      );
    });

    it('null postprocs falls back to the registry list (like omitted)', function () {
      const omitted = convertSingleHop(r4Questionnaire, 'R4', 'R5');
      const withNull = convertSingleHop(r4Questionnaire, 'R4', 'R5', { postprocs: null });
      // Questionnaire R4->R5 has no registry postprocessors, so neither reports any.
      assert.equal('postprocessors' in omitted, 'postprocessors' in withNull);
      assert.equal(withNull.coverage, omitted.coverage);
    });

    // R5->R4 has a registry postprocessor (Questionnaire_R5_to_R4), so it
    // distinguishes "not provided" (null/undefined -> use registry) from an
    // explicit empty list under policy 'replace' (-> run none).
    describe('null/undefined vs empty-list (R5->R4 has a registry postprocessor)', function () {
      it('omitted postprocs runs the registry postprocessor', function () {
        const r = convertSingleHop(r5Questionnaire, 'R5', 'R4');
        assert.ok(Array.isArray(r.postprocessors));
        assert.ok(r.postprocessors.some(p => p.name === 'Questionnaire_R5_to_R4'));
      });

      it('null postprocs behaves exactly like undefined (uses the registry)', function () {
        const r = convertSingleHop(r5Questionnaire, 'R5', 'R4', { postprocs: null });
        assert.ok(r.postprocessors?.some(p => p.name === 'Questionnaire_R5_to_R4'));
      });

      it('empty postprocs with policy replace runs none (empty list is meaningful)', function () {
        const r = convertSingleHop(r5Questionnaire, 'R5', 'R4', {
          postprocs: [],
          postprocessPolicy: 'replace',
        });
        assert.equal('postprocessors' in r, false);
      });
    });
  });
});
