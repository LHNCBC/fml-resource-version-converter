/**
 * Tests for reviewed ValueSet conversion between R4B and R5.
 *
 * R4B and R4 have the same ValueSet element set and filter operator codes, so
 * the R5 -> R4B postprocessor reuses the R5 -> R4 transform. These tests
 * exercise the R4B hops end to end and pin the reuse so the two directions
 * cannot silently fork.
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { COVERAGE } from '../../../../src/converter/coverage.js';
import { MESSAGE_TYPE, STATUS } from '../../../../src/converter/diagnostics.js';
import { singleHopConverter } from '../../../../src/converter/singleHopConverter.js';
import { conv_R5_to_R4 } from '../../../../src/postprocessors/R4_R5/ValueSet.js';
import { conv_R5_to_R4B } from '../../../../src/postprocessors/R4B_R5/ValueSet.js';

const TEST_DATA = path.resolve(import.meta.dirname, '../../../data');
const r4bValueSet = JSON.parse(
  fs.readFileSync(path.join(TEST_DATA, 'valueset-r4b.json'), 'utf-8'),
);
const r5LossValueSet = JSON.parse(
  fs.readFileSync(path.join(TEST_DATA, 'valueset-r5-loss.json'), 'utf-8'),
);

describe('postprocessors/R4B_R5 ValueSet', function () {
  describe('R4B -> R5 through singleHopConverter.convert', function () {
    let result;

    before(function () {
      result = singleHopConverter.convert(r4bValueSet, 'R4B', 'R5');
    });

    it('reports complete FML coverage without a postprocessor', function () {
      assert.equal(result.coverage, COVERAGE.COMPLETE);
      assert.equal(result.fml_base_conv.coverage, COVERAGE.COMPLETE);
      assert.equal(result.postprocessors, undefined);
      assert.equal(result.status, STATUS.OK);
    });

    it('preserves representative root and primitive-companion content', function () {
      assert.equal(result.resource.resourceType, 'ValueSet');
      assert.equal(result.resource.url, r4bValueSet.url);
      assert.equal(result.resource.status, r4bValueSet.status);
      assert.deepEqual(result.resource._status, r4bValueSet._status);
    });

    it('rewrites the version-specific meta.profile from 4.3 to 5.0', function () {
      assert.deepEqual(result.resource.meta.profile, [
        'http://hl7.org/fhir/5.0/StructureDefinition/ValueSet',
      ]);
    });

    it('preserves compose include, exclude, filters, and designations', function () {
      assert.deepEqual(result.resource.compose, r4bValueSet.compose);
    });

    it('preserves expansion parameters, recursive contains, and designations', function () {
      assert.deepEqual(result.resource.expansion, r4bValueSet.expansion);
    });

    it('maps every R4B filter operator without a warning', function () {
      const operators = [
        '=', 'is-a', 'descendent-of', 'is-not-a', 'regex', 'in', 'not-in',
        'generalizes', 'exists',
      ];

      for (const op of operators) {
        const source = {
          resourceType: 'ValueSet',
          status: 'active',
          compose: {
            include: [{
              system: 'http://example.org/fhir/CodeSystem/example',
              filter: [{ property: 'concept', op, value: 'x' }],
            }],
          },
        };
        const converted = singleHopConverter.convert(source, 'R4B', 'R5');
        assert.equal(converted.resource.compose.include[0].filter[0].op, op);
        assert.equal(converted.status, STATUS.OK, `unexpected warning for operator ${op}`);
      }
    });
  });

  describe('R5 -> R4B through singleHopConverter.convert', function () {
    let result;

    before(function () {
      result = singleHopConverter.convert(r5LossValueSet, 'R5', 'R4B');
    });

    it('reports FML known gaps and best-effort final coverage', function () {
      assert.equal(result.coverage, COVERAGE.BEST_EFFORT);
      assert.equal(result.fml_base_conv.coverage, COVERAGE.KNOWN_GAPS);
      assert.equal(result.postprocessors.length, 1);
      assert.equal(result.postprocessors[0].name, 'ValueSet_R5_to_R4B');
      assert.equal(result.postprocessors[0].coverage, COVERAGE.BEST_EFFORT);
    });

    it('reports the R5-only content that was dropped', function () {
      const warning = result.postprocessors[0].messages.find(message =>
        message.type === MESSAGE_TYPE.WARNING && /content was dropped/.test(message.text));

      assert.ok(warning);
      assert.match(warning.text, /ValueSet.versionAlgorithm\[x\]/);
      assert.match(warning.text, /ValueSet.compose.property/);
      assert.match(warning.text, /ValueSet.expansion.contains.property/);
      assert.match(warning.text, /ValueSet.scope/);
      assert.match(warning.text, /R5-only ValueSet content was dropped because R4B has no equivalent/);
      assert.equal('scope' in result.resource, false);
      assert.equal('property' in result.resource.expansion.contains[0], false);
    });

    it('approximates an R5-only filter operator with the closest valid R4B operator', function () {
      assert.equal(result.status, STATUS.WARNING);
      assert.equal(result.resource.compose.include[0].filter[0].op, 'descendent-of');
      assert.ok(result.postprocessors[0].messages.some(message =>
        /no exact R4B equivalent/.test(message.text)
        && /approximated as "descendent-of"/.test(message.text)
        && /include additional concepts/.test(message.text)));
    });

    it('still preserves fields shared with R4B', function () {
      assert.equal(result.resource.url, r5LossValueSet.url);
      assert.equal(result.resource.version, r5LossValueSet.version);
      assert.equal(result.resource.status, r5LossValueSet.status);
      assert.equal(result.resource.expansion.identifier, r5LossValueSet.expansion.identifier);
    });
  });

  describe('conv_R5_to_R4B descriptor', function () {
    it('reuses the R5 -> R4 transform verbatim', function () {
      assert.equal(conv_R5_to_R4B.execute, conv_R5_to_R4.execute);
      assert.equal(conv_R5_to_R4B.coverage, conv_R5_to_R4.coverage);
    });

    it('carries its own name so conversion reports stay accurate', function () {
      assert.equal(conv_R5_to_R4B.name, 'ValueSet_R5_to_R4B');
      assert.notEqual(conv_R5_to_R4B.name, conv_R5_to_R4.name);
      assert.match(conv_R5_to_R4B.description, /R5->R4B/);
    });

    it('does not warn when the source contains only R4B-compatible fields', function () {
      const target = { resourceType: 'ValueSet', status: 'active' };
      const result = conv_R5_to_R4B.execute(target, {
        sourceResource: { resourceType: 'ValueSet', status: 'active' },
      });

      assert.equal(result.resource, target);
      assert.equal(result.status, STATUS.OK);
      assert.deepEqual(result.messages, []);
    });

    it('approximates include/exclude operators and preserves _op companions', function () {
      const target = {
        resourceType: 'ValueSet',
        compose: {
          include: [{
            system: 'http://example.org/system',
            filter: [{ property: 'concept', op: 'child-of', _op: { id: 'inc' }, value: 'root' }],
          }],
          exclude: [{
            system: 'http://example.org/system',
            filter: [{
              property: 'concept',
              op: 'descendent-leaf',
              _op: { id: 'exc' },
              value: 'retired',
            }],
          }],
        },
      };
      const result = conv_R5_to_R4B.execute(target, {
        sourceResource: { resourceType: 'ValueSet' },
      });
      const text = result.messages.map(message => message.text).join('\n');

      assert.equal(result.status, STATUS.WARNING);
      assert.equal(target.compose.include[0].filter[0].op, 'descendent-of');
      assert.equal(target.compose.exclude[0].filter[0].op, 'descendent-of');
      assert.deepEqual(target.compose.include[0].filter[0]._op, { id: 'inc' });
      assert.deepEqual(target.compose.exclude[0].filter[0]._op, { id: 'exc' });
      assert.match(text, /ValueSet\.compose\.include\[0\]\.filter\[0\]\.op "child-of"/);
      assert.match(text, /ValueSet\.compose\.exclude\[0\]\.filter\[0\]\.op "descendent-leaf"/);
    });
  });
});
