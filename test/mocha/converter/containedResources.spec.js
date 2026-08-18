/**
 * Integration tests for contained-resource conversion and reporting.
 */
import { strict as assert } from 'node:assert';
import { COVERAGE } from '../../../src/converter/coverage.js';
import { MESSAGE_TYPE, STATUS } from '../../../src/converter/diagnostics.js';
import { chainedConverter } from '../../../src/converter/chainedConverter.js';
import { singleHopConverter } from '../../../src/converter/singleHopConverter.js';

/**
 * Build a Questionnaire with one child of every onboarded R3+ resource type.
 *
 * @returns {Object} Minimal R3/R4-compatible Questionnaire fixture.
 */
function makeMixedQuestionnaire() {
  return {
    resourceType: 'Questionnaire',
    id: 'parent',
    status: 'active',
    extension: [{
      url: 'http://example.org/fhir/StructureDefinition/contained-reference',
      valueReference: { reference: '#child-library' },
    }],
    contained: [{
      resourceType: 'Questionnaire',
      id: 'child-questionnaire',
      status: 'active',
      item: [{ linkId: 'choice', type: 'choice' }],
    }, {
      resourceType: 'ValueSet',
      id: 'child-valueset',
      status: 'active',
    }, {
      resourceType: 'CodeSystem',
      id: 'child-codesystem',
      status: 'active',
      content: 'complete',
    }, {
      resourceType: 'Binary',
      id: 'child-binary',
      contentType: 'text/plain',
      data: 'eA==',
    }, {
      resourceType: 'Library',
      id: 'child-library',
      status: 'active',
      type: {
        coding: [{
          system: 'http://terminology.hl7.org/CodeSystem/library-type',
          code: 'logic-library',
        }],
      },
    }],
  };
}

describe('converter contained resources', function () {
  describe('single-hop conversion and reports', function () {
    it('converts every child and returns flat child reports in source order', function () {
      const source = makeMixedQuestionnaire();
      const original = structuredClone(source);
      const result = singleHopConverter.convert(source, 'R4', 'R5');

      assert.deepEqual(source, original);
      assert.deepEqual(
        result.resource.contained.map(child => child.id),
        original.contained.map(child => child.id),
      );
      assert.equal(result.resource.contained[0].item[0].type, 'coding');
      assert.equal(
        result.resource.extension[0].valueReference.reference,
        '#child-library',
      );
      assert.equal(result.contained.length, 5);
      assert.deepEqual(
        result.contained.map(child => child.resource.id),
        original.contained.map(child => child.id),
      );
      for (const child of result.contained) {
        assert.equal('hops' in child, false);
        assert.equal(child.fml_base_conv.name, '_FML_');
      }

      assert.equal(result.coverage, COVERAGE.BEST_EFFORT);
      assert.equal(result.contained[4].coverage, COVERAGE.BEST_EFFORT);
    });

    it('runs parent postprocessors after children and keeps singular processors parent-only', function () {
      const source = makeMixedQuestionnaire();
      let preRuns = 0;
      let postRuns = 0;
      let targetChildType;
      let sourceChildType;
      const pre = {
        name: 'parent-pre',
        execute(resource) {
          preRuns += 1;
          return { resource, status: STATUS.OK };
        },
      };
      const post = {
        name: 'parent-post',
        execute(target, ctx) {
          postRuns += 1;
          targetChildType = target.contained[0].item[0].type;
          sourceChildType = ctx.sourceResource.contained[0].item[0].type;
          const output = structuredClone(target);
          output.contained[0].language = 'de';
          return { resource: output, status: STATUS.OK };
        },
      };

      const result = singleHopConverter.convert(source, 'R4', 'R5', {
        preproc: [pre],
        postproc: [post],
      });

      assert.equal(preRuns, 1);
      assert.equal(postRuns, 1);
      assert.equal(targetChildType, 'coding');
      assert.equal(sourceChildType, 'choice');
      assert.equal(result.resource.contained[0].language, 'de');
      assert.equal(result.contained[0].resource.language, undefined);
    });

    it('runs matching keyed child processors and ignores unused map entries', function () {
      const source = makeMixedQuestionnaire();
      const childPre = {
        name: 'child-pre',
        execute(resource) {
          return { resource: { ...resource, language: 'fr' }, status: STATUS.OK };
        },
      };
      const childPost = {
        name: 'child-post',
        execute(resource) {
          return { resource: { ...resource, language: 'de' }, status: STATUS.OK };
        },
      };

      const result = singleHopConverter.convert(source, 'R4', 'R5', {
        preprocs: {
          Library: [childPre],
          'Observation:R2->R3': [childPre],
        },
        postprocs: {
          Library: [childPost],
          'Observation:R3->R4': [childPost],
        },
      });
      const library = result.contained[4];

      assert.equal(result.resource.language, undefined);
      assert.equal(library.resource.language, 'de');
      assert.equal(library.preprocessors.some(report => report.name === 'child-pre'), true);
      assert.equal(library.postprocessors.some(report => report.name === 'child-post'), true);
    });

    it('rolls child coverage and warnings into the invocation result', function () {
      const source = makeMixedQuestionnaire();
      const warn = {
        name: 'warn-on-library',
        execute(resource) {
          return {
            resource,
            status: STATUS.WARNING,
            messages: [{ type: MESSAGE_TYPE.WARNING, text: 'contained library warning' }],
          };
        },
      };
      const result = singleHopConverter.convert(source, 'R4', 'R5', {
        postprocs: { Library: [warn] },
      });

      assert.equal(result.coverage, COVERAGE.BEST_EFFORT);
      assert.equal(result.contained[4].coverage, COVERAGE.BEST_EFFORT);
      assert.equal(result.contained[4].status, STATUS.WARNING);
      assert.equal(result.status, STATUS.WARNING);
    });

    it('omits child reports when contained is absent or empty', function () {
      const absent = singleHopConverter.convert(
        { resourceType: 'Questionnaire', status: 'active' },
        'R4',
        'R5',
      );
      const empty = singleHopConverter.convert(
        { resourceType: 'Questionnaire', status: 'active', contained: [] },
        'R4',
        'R5',
      );

      assert.equal('contained' in absent, false);
      assert.equal('contained' in empty, false);
      assert.deepEqual(empty.resource.contained, []);
    });
  });

  describe('chained conversion and reports', function () {
    it('includes child resource-hops in effective coverage across the chain', function () {
      const parent = {
        resourceType: 'CodeSystem',
        id: 'parent-codesystem',
        status: 'active',
        content: 'complete',
      };
      const child = {
        resourceType: 'Library',
        id: 'child-library',
        status: 'active',
        type: {
          coding: [{
            system: 'http://hl7.org/fhir/library-type',
            code: 'logic-library',
          }],
        },
      };

      const parentOnly = chainedConverter.convert(parent, 'R3', 'R5');
      const withChild = chainedConverter.convert({ ...parent, contained: [child] }, 'R3', 'R5');

      assert.equal(parentOnly.coverage, COVERAGE.COMPLETE);
      assert.equal(withChild.coverage, COVERAGE.BEST_EFFORT);
      assert.equal(withChild.hops[0].contained[0].coverage, COVERAGE.BEST_EFFORT);
      assert.equal(withChild.hops[1].contained[0].coverage, COVERAGE.BEST_EFFORT);
    });

    it('reports the children converted independently inside each parent hop', function () {
      const result = chainedConverter.convert(makeMixedQuestionnaire(), 'R3', 'R5');

      assert.equal(result.hops.length, 2);
      assert.equal('contained' in result, false);
      for (const hop of result.hops) {
        assert.equal(hop.contained.length, 5);
        assert.deepEqual(
          hop.contained.map(child => child.resource.id),
          makeMixedQuestionnaire().contained.map(child => child.id),
        );
        assert.equal(hop.contained.every(child => !('hops' in child)), true);
        assert.equal(hop.contained.every(child => child.fml_base_conv.name === '_FML_'), true);
      }
      assert.equal(result.hops[1].contained[0].resource.item[0].type, 'coding');
      assert.equal(result.coverage, COVERAGE.BEST_EFFORT);
    });

    it('does not require child reports to stay aligned across parent hops', function () {
      const removeFirstChild = {
        name: 'remove-first-child',
        coverage: COVERAGE.NEUTRAL,
        execute(target) {
          if (target.id !== 'parent') {
            return { resource: target, status: STATUS.OK };
          }

          return {
            resource: {
              ...target,
              contained: target.contained.slice(1),
            },
            status: STATUS.OK,
          };
        },
      };
      const result = chainedConverter.convert(makeMixedQuestionnaire(), 'R3', 'R5', {
        postprocs: {
          'Questionnaire:R3->R4': [removeFirstChild],
        },
      });

      assert.equal(result.hops[0].contained.length, 5);
      assert.equal(result.hops[0].contained[0].resource.id, 'child-questionnaire');
      assert.equal(result.hops[1].contained.length, 4);
      assert.equal(result.hops[1].contained[0].resource.id, 'child-valueset');
      assert.equal(result.resource.contained.length, 4);
    });
  });

  describe('validation and failures', function () {
    it('rejects malformed contained fields and entries', function () {
      assert.throws(
        () => singleHopConverter.convert({
          resourceType: 'Questionnaire',
          status: 'active',
          contained: {},
        }, 'R4', 'R5'),
        /resource\.contained must be an array/,
      );
      assert.throws(
        () => singleHopConverter.convert({
          resourceType: 'Questionnaire',
          status: 'active',
          contained: [{}],
        }, 'R4', 'R5'),
        /contained\[0\] R4->R5 resourceType is required/,
      );
    });

    it('rejects source resources with nested contained resources', function () {
      assert.throws(
        () => singleHopConverter.convert({
          resourceType: 'Questionnaire',
          status: 'active',
          contained: [{
            resourceType: 'Questionnaire',
            id: 'child',
            status: 'active',
            contained: [{ resourceType: 'Binary', id: 'grandchild' }],
          }],
        }, 'R4', 'R5'),
        /contained\[0\].*cannot contain resources.*dom-2/,
      );
    });

    it('adds child context to missing and ambiguous mapping errors', function () {
      assert.throws(
        () => singleHopConverter.convert({
          resourceType: 'Questionnaire',
          status: 'active',
          contained: [{ resourceType: 'NoSuchResource', id: 'missing' }],
        }, 'R4', 'R5'),
        /contained\[0\] \(NoSuchResource#missing\) R4->R5:.*no direct FML mapping/,
      );
      assert.throws(
        () => singleHopConverter.convert({
          resourceType: 'Questionnaire',
          status: 'active',
          contained: [{
            resourceType: 'ServiceRequest',
            id: 'ambiguous',
            status: 'active',
            intent: 'order',
          }],
        }, 'R4', 'R3'),
        /contained\[0\] \(ServiceRequest#ambiguous\) R4->R3:.*targetResourceType is required/,
      );
    });

    it('allows parent postprocessors to restructure contained resources after reporting them', function () {
      const removeChildren = {
        name: 'remove-children',
        execute(target) {
          const output = { ...target };
          delete output.contained;
          return { resource: output, status: STATUS.OK };
        },
      };

      const result = singleHopConverter.convert(makeMixedQuestionnaire(), 'R4', 'R5', {
        postproc: [removeChildren],
      });

      assert.equal('contained' in result.resource, false);
      assert.equal(result.contained.length, 5);
      assert.equal(result.coverage, COVERAGE.BEST_EFFORT);
    });
  });
});
