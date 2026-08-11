/**
 * Tests for reviewed ValueSet conversion between R4 and R5.
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { COVERAGE } from '../../../../src/converter/coverage.js';
import { MESSAGE_TYPE, STATUS } from '../../../../src/converter/diagnostics.js';
import { singleHopConverter } from '../../../../src/converter/singleHopConverter.js';
import { conv_R5_to_R4 } from '../../../../src/postprocessors/R4_R5/ValueSet.js';

const TEST_DATA = path.resolve(import.meta.dirname, '../../../data');
const r4ValueSet = JSON.parse(
  fs.readFileSync(path.join(TEST_DATA, 'valueset-r4.json'), 'utf-8'),
);
const r5LossValueSet = JSON.parse(
  fs.readFileSync(path.join(TEST_DATA, 'valueset-r5-loss.json'), 'utf-8'),
);

describe('postprocessors/R4_R5 ValueSet', function () {
  describe('R4 -> R5 through singleHopConverter.convert', function () {
    let result;

    before(function () {
      result = singleHopConverter.convert(r4ValueSet, 'R4', 'R5');
    });

    it('reports complete FML coverage without a postprocessor', function () {
      assert.equal(result.coverage, COVERAGE.COMPLETE);
      assert.equal(result.fml_base_conv.coverage, COVERAGE.COMPLETE);
      assert.equal(result.postprocessors, undefined);
      assert.equal(result.status, STATUS.OK);
    });

    it('preserves representative root and primitive-companion content', function () {
      assert.equal(result.resource.resourceType, 'ValueSet');
      assert.equal(result.resource.url, r4ValueSet.url);
      assert.equal(result.resource.status, r4ValueSet.status);
      assert.deepEqual(result.resource._status, r4ValueSet._status);
      assert.deepEqual(result.resource.meta.profile, [
        'http://hl7.org/fhir/5.0/StructureDefinition/ValueSet',
      ]);
    });

    it('preserves compose include, exclude, filters, and designations', function () {
      assert.deepEqual(result.resource.compose, r4ValueSet.compose);
    });

    it('preserves expansion parameters, recursive contains, and designations', function () {
      assert.deepEqual(result.resource.expansion, r4ValueSet.expansion);
    });

    it('maps every R4 filter operator without a warning', function () {
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
        const converted = singleHopConverter.convert(source, 'R4', 'R5');
        assert.equal(converted.resource.compose.include[0].filter[0].op, op);
        assert.equal(converted.status, STATUS.OK, `unexpected warning for operator ${op}`);
      }
    });
  });

  describe('R5 -> R4 through singleHopConverter.convert', function () {
    let result;

    before(function () {
      result = singleHopConverter.convert(r5LossValueSet, 'R5', 'R4');
    });

    it('reports FML known gaps and best-effort final coverage', function () {
      assert.equal(result.coverage, COVERAGE.BEST_EFFORT);
      assert.equal(result.fml_base_conv.coverage, COVERAGE.KNOWN_GAPS);
      assert.equal(result.postprocessors.length, 1);
      assert.equal(result.postprocessors[0].name, 'ValueSet_R5_to_R4');
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
      assert.match(warning.text, /R5-only ValueSet content was dropped because R4 has no equivalent/);
      assert.equal('scope' in result.resource, false);
      assert.equal('property' in result.resource.expansion.contains[0], false);
    });

    it('approximates an R5-only filter operator with the closest valid R4 operator', function () {
      assert.equal(result.status, STATUS.WARNING);
      assert.equal(result.resource.compose.include[0].filter[0].op, 'descendent-of');
      assert.ok(result.postprocessors[0].messages.some(message =>
        /no exact R4 equivalent/.test(message.text)
        && /approximated as "descendent-of"/.test(message.text)
        && /include additional concepts/.test(message.text)));
    });

    it('still preserves fields shared with R4', function () {
      assert.equal(result.resource.url, r5LossValueSet.url);
      assert.equal(result.resource.version, r5LossValueSet.version);
      assert.equal(result.resource.status, r5LossValueSet.status);
      assert.equal(result.resource.expansion.identifier, r5LossValueSet.expansion.identifier);
    });
  });

  describe('conv_R5_to_R4.execute', function () {
    it('does not warn when the source contains only R4-compatible fields', function () {
      const target = { resourceType: 'ValueSet', status: 'active' };
      const source = { resourceType: 'ValueSet', status: 'active' };
      const result = conv_R5_to_R4.execute(target, { sourceResource: source });

      assert.equal(result.resource, target);
      assert.equal(result.status, STATUS.OK);
      assert.deepEqual(result.messages, []);
    });

    it('reports an extension-only compose.property primitive', function () {
      const source = {
        resourceType: 'ValueSet',
        compose: {
          _property: [{
            extension: [{
              url: 'http://example.org/fhir/StructureDefinition/property-note',
              valueString: 'extension-only property',
            }],
          }],
        },
      };
      const result = conv_R5_to_R4.execute(
        { resourceType: 'ValueSet' },
        { sourceResource: source },
      );

      assert.equal(result.status, STATUS.WARNING);
      assert.match(result.messages[0].text, /ValueSet\.compose\.property/);
    });

    it('approximates include/exclude operators and preserves _op companions', function () {
      const includeCompanion = { id: 'include-op-metadata' };
      const excludeCompanion = { id: 'exclude-op-metadata' };
      const target = {
        resourceType: 'ValueSet',
        compose: {
          include: [{
            system: 'http://example.org/system',
            filter: [{
              property: 'concept',
              op: 'child-of',
              _op: includeCompanion,
              value: 'root',
            }],
          }],
          exclude: [{
            system: 'http://example.org/system',
            filter: [{
              property: 'concept',
              op: 'descendent-leaf',
              _op: excludeCompanion,
              value: 'retired',
            }],
          }],
        },
      };
      const result = conv_R5_to_R4.execute(target, {
        sourceResource: { resourceType: 'ValueSet' },
      });
      const text = result.messages.map(message => message.text).join('\n');

      assert.equal(result.resource, target);
      assert.equal(result.status, STATUS.WARNING);
      assert.equal(target.compose.include[0].filter[0].op, 'descendent-of');
      assert.equal(target.compose.exclude[0].filter[0].op, 'descendent-of');
      assert.deepEqual(target.compose.include[0].filter[0]._op, includeCompanion);
      assert.deepEqual(target.compose.exclude[0].filter[0]._op, excludeCompanion);
      assert.match(text, /ValueSet\.compose\.include\[0\]\.filter\[0\]\.op "child-of"/);
      assert.match(text, /include additional concepts/);
      assert.match(text, /ValueSet\.compose\.exclude\[0\]\.filter\[0\]\.op "descendent-leaf"/);
      assert.match(text, /exclude additional concepts/);
    });

    it('recognizes less-common root additions and nested reverse paths', function () {
      const source = {
        resourceType: 'ValueSet',
        editor: [{ name: 'Editor' }],
        reviewer: [{ name: 'Reviewer' }],
        endorser: [{ name: 'Endorser' }],
        relatedArtifact: [{ type: 'documentation' }],
        compose: {
          exclude: [{
            system: 'http://example.org/system',
            copyright: 'Excluded code system copyright',
            concept: [{
              code: 'x',
              designation: [{ use: { code: 'display' }, additionalUse: [{ code: 'consumer' }] }],
            }],
          }],
        },
        expansion: {
          contains: [{
            code: 'x',
            contains: [{ code: 'y', property: [{ code: 'status', valueCode: 'active' }] }],
          }],
        },
      };
      const result = conv_R5_to_R4.execute(
        { resourceType: 'ValueSet' },
        { sourceResource: source },
      );
      const text = result.messages.map(message => message.text).join('\n');

      assert.equal(result.status, STATUS.WARNING);
      assert.match(text, /ValueSet.editor/);
      assert.match(text, /ValueSet.reviewer/);
      assert.match(text, /ValueSet.endorser/);
      assert.match(text, /ValueSet.relatedArtifact/);
      assert.match(text, /ValueSet\.compose\.exclude\.copyright/);
      assert.match(text, /ValueSet\.compose\.exclude\.concept\.designation\.additionalUse/);
      assert.match(text, /expansion.contains.property/);
    });
  });
});
