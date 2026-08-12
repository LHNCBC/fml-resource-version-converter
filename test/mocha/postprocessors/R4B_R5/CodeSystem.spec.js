/**
 * Tests for reviewed CodeSystem conversion between R4B and R5.
 *
 * R4B and R4 declare the same CodeSystem element set, filter operator codes, and
 * error-severity invariants, so both R4B postprocessors reuse the R4 transforms.
 * These tests exercise the R4B hops end to end and pin the reuse so the two
 * version pairs cannot silently fork.
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { COVERAGE } from '../../../../src/converter/coverage.js';
import { MESSAGE_TYPE, STATUS } from '../../../../src/converter/diagnostics.js';
import { singleHopConverter } from '../../../../src/converter/singleHopConverter.js';
import { conv_R4_to_R5, conv_R5_to_R4 } from '../../../../src/postprocessors/R4_R5/CodeSystem.js';
import { conv_R4B_to_R5, conv_R5_to_R4B } from '../../../../src/postprocessors/R4B_R5/CodeSystem.js';

const TEST_DATA = path.resolve(import.meta.dirname, '../../../data');
const r4bCodeSystem = JSON.parse(
  fs.readFileSync(path.join(TEST_DATA, 'codesystem-r4b.json'), 'utf-8'),
);
const r5LossCodeSystem = JSON.parse(
  fs.readFileSync(path.join(TEST_DATA, 'codesystem-r5-loss.json'), 'utf-8'),
);

describe('postprocessors/R4B_R5 CodeSystem', function () {
  describe('R4B -> R5 through singleHopConverter.convert', function () {
    let result;

    before(function () {
      result = singleHopConverter.convert(r4bCodeSystem, 'R4B', 'R5');
    });

    it('reports FML known gaps repaired to complete coverage', function () {
      assert.equal(result.coverage, COVERAGE.COMPLETE);
      assert.equal(result.fml_base_conv.coverage, COVERAGE.KNOWN_GAPS);
      assert.equal(result.postprocessors.length, 1);
      assert.equal(result.postprocessors[0].name, 'CodeSystem_R4B_to_R5');
      assert.equal(result.postprocessors[0].coverage, COVERAGE.COMPLETE);
    });

    it('converts a non-supplement code system without any warning', function () {
      assert.equal(result.status, STATUS.OK);
      assert.deepEqual(result.postprocessors[0].messages, []);
    });

    it('preserves representative root and primitive-companion content', function () {
      assert.equal(result.resource.resourceType, 'CodeSystem');
      assert.equal(result.resource.url, r4bCodeSystem.url);
      assert.equal(result.resource.status, r4bCodeSystem.status);
      assert.deepEqual(result.resource._status, r4bCodeSystem._status);
      assert.deepEqual(result.resource.identifier, r4bCodeSystem.identifier);
    });

    it('rewrites the version-specific meta.profile from 4.3 to 5.0', function () {
      assert.deepEqual(result.resource.meta.profile, [
        'http://hl7.org/fhir/5.0/StructureDefinition/CodeSystem',
      ]);
    });

    it('preserves filters, properties, and nested concepts', function () {
      assert.deepEqual(result.resource.filter, r4bCodeSystem.filter);
      assert.deepEqual(result.resource.property, r4bCodeSystem.property);
      assert.deepEqual(result.resource.concept, r4bCodeSystem.concept);
    });

    it('maps every R4B filter operator without a warning', function () {
      const operators = [
        '=', 'is-a', 'descendent-of', 'is-not-a', 'regex', 'in', 'not-in',
        'generalizes', 'exists',
      ];

      for (const operator of operators) {
        const source = {
          resourceType: 'CodeSystem',
          status: 'active',
          content: 'complete',
          filter: [{ code: 'concept', operator: [operator], value: 'x' }],
        };
        const converted = singleHopConverter.convert(source, 'R4B', 'R5');
        assert.deepEqual(converted.resource.filter[0].operator, [operator]);
        assert.equal(converted.status, STATUS.OK, `unexpected warning for operator ${operator}`);
      }
    });

    it('satisfies csd-4 by marking supplements absent', function () {
      const source = {
        resourceType: 'CodeSystem',
        url: 'http://example.org/fhir/CodeSystem/supplement',
        status: 'active',
        content: 'supplement',
      };
      const converted = singleHopConverter.convert(source, 'R4B', 'R5');

      assert.equal(converted.status, STATUS.WARNING);
      assert.equal('supplements' in converted.resource, false);
      assert.equal(
        converted.resource._supplements.extension[0].url,
        'http://hl7.org/fhir/StructureDefinition/data-absent-reason',
      );
      assert.match(converted.postprocessors[0].messages[0].text, /R4B allows this; R5 requires/);
    });
  });

  describe('R5 -> R4B through singleHopConverter.convert', function () {
    let result;

    before(function () {
      result = singleHopConverter.convert(r5LossCodeSystem, 'R5', 'R4B');
    });

    it('reports FML known gaps and best-effort final coverage', function () {
      assert.equal(result.coverage, COVERAGE.BEST_EFFORT);
      assert.equal(result.fml_base_conv.coverage, COVERAGE.KNOWN_GAPS);
      assert.equal(result.postprocessors.length, 1);
      assert.equal(result.postprocessors[0].name, 'CodeSystem_R5_to_R4B');
      assert.equal(result.postprocessors[0].coverage, COVERAGE.BEST_EFFORT);
    });

    it('reports the R5-only content that was dropped', function () {
      const warning = result.postprocessors[0].messages.find(message =>
        message.type === MESSAGE_TYPE.WARNING && /content was dropped/.test(message.text));

      assert.ok(warning);
      assert.match(
        warning.text,
        /R5-only CodeSystem content was dropped because R4B has no equivalent/,
      );
      assert.match(warning.text, /CodeSystem.versionAlgorithm\[x\]/);
      assert.match(warning.text, /CodeSystem.concept.designation.additionalUse/);
      assert.equal('copyrightLabel' in result.resource, false);
      assert.equal('additionalUse' in result.resource.concept[0].designation[0], false);
    });

    it('removes R5-only operator codes and drops an unrepresentable filter', function () {
      assert.equal(result.status, STATUS.WARNING);
      assert.deepEqual(result.resource.filter[0].operator, ['is-a', 'descendent-of']);
      assert.deepEqual(result.resource.filter.map(entry => entry.code), ['concept', 'display']);
      assert.ok(result.postprocessors[0].messages.some(message =>
        /R4B does not define/.test(message.text)));
    });

    it('still preserves fields shared with R4B', function () {
      assert.equal(result.resource.url, r5LossCodeSystem.url);
      assert.equal(result.resource.version, r5LossCodeSystem.version);
      assert.equal(result.resource.content, r5LossCodeSystem.content);
      assert.deepEqual(result.resource.meta.profile, [
        'http://hl7.org/fhir/4.3/StructureDefinition/CodeSystem',
      ]);
    });
  });

  describe('R4B descriptors', function () {
    it('reuse the R4 transforms verbatim', function () {
      assert.equal(conv_R5_to_R4B.execute, conv_R5_to_R4.execute);
      assert.equal(conv_R5_to_R4B.coverage, conv_R5_to_R4.coverage);
      assert.equal(conv_R4B_to_R5.execute, conv_R4_to_R5.execute);
      assert.equal(conv_R4B_to_R5.coverage, conv_R4_to_R5.coverage);
    });

    it('carry their own names so conversion reports stay accurate', function () {
      assert.equal(conv_R5_to_R4B.name, 'CodeSystem_R5_to_R4B');
      assert.equal(conv_R4B_to_R5.name, 'CodeSystem_R4B_to_R5');
      assert.notEqual(conv_R5_to_R4B.name, conv_R5_to_R4.name);
      assert.notEqual(conv_R4B_to_R5.name, conv_R4_to_R5.name);
      assert.match(conv_R5_to_R4B.description, /R5->R4B/);
      assert.match(conv_R4B_to_R5.description, /R4B code system supplement/);
    });

    it('do not warn when the source contains only R4B-compatible content', function () {
      const target = { resourceType: 'CodeSystem', status: 'active', content: 'complete' };
      const result = conv_R5_to_R4B.execute(target, {
        sourceResource: { resourceType: 'CodeSystem', status: 'active', content: 'complete' },
      });

      assert.equal(result.resource, target);
      assert.equal(result.status, STATUS.OK);
      assert.deepEqual(result.messages, []);
    });
  });
});





