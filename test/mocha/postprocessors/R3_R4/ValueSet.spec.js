/**
 * Tests for reviewed ValueSet conversion between STU3 (R3) and R4.
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { COVERAGE } from '../../../../src/converter/coverage.js';
import { MESSAGE_TYPE, STATUS } from '../../../../src/converter/diagnostics.js';
import { singleHopConverter } from '../../../../src/converter/singleHopConverter.js';
import {
  conv_R3_to_R4,
  conv_R4_to_R3,
} from '../../../../src/postprocessors/R3_R4/ValueSet.js';

const TEST_DATA = path.resolve(import.meta.dirname, '../../../data');
const stu3ValueSet = JSON.parse(
  fs.readFileSync(path.join(TEST_DATA, 'valueset-stu3.json'), 'utf-8'),
);
const r4LossValueSet = JSON.parse(
  fs.readFileSync(path.join(TEST_DATA, 'valueset-r4-loss.json'), 'utf-8'),
);

const EXTENSIBLE_IVE =
  'http://hl7.org/fhir/3.0/StructureDefinition/extension-ValueSet.extensible';

describe('postprocessors/R3_R4 ValueSet', function () {
  describe('R3 -> R4 through singleHopConverter.convert', function () {
    let result;

    before(function () {
      result = singleHopConverter.convert(stu3ValueSet, 'R3', 'R4');
    });

    it('reports FML known gaps and best-effort final coverage', function () {
      assert.equal(result.coverage, COVERAGE.BEST_EFFORT);
      assert.equal(result.fml_base_conv.coverage, COVERAGE.KNOWN_GAPS);
      assert.equal(result.postprocessors.length, 1);
      assert.equal(result.postprocessors[0].name, 'ValueSet_R3_to_R4');
      assert.equal(result.postprocessors[0].coverage, COVERAGE.BEST_EFFORT);
    });

    it('treats extensible as lost even though the FML parks it in an IVE', function () {
      // The value physically survives as an inter-version extension, but
      // general R4 tools need not understand those, so it counts as lost.
      assert.equal('extensible' in result.resource, false);
      const ive = result.resource.extension.find(e => e.url === EXTENSIBLE_IVE);
      assert.ok(ive, 'expected the extensible inter-version extension');
      assert.equal(ive.valueBoolean, stu3ValueSet.extensible);

      assert.equal(result.status, STATUS.WARNING);
      const warning = result.postprocessors[0].messages
        .find(m => m.type === MESSAGE_TYPE.WARNING && /extensible/.test(m.text));
      assert.ok(warning);
      assert.match(warning.text, /should be treated as lost/);
      assert.match(warning.text, /not required to understand/);
    });

    it('preserves the root metadata shared with R4', function () {
      for (const field of [
        'url', 'version', 'name', 'title', 'status', 'experimental', 'date',
        'publisher', 'description', 'immutable', 'purpose', 'copyright',
      ]) {
        assert.equal(result.resource[field], stu3ValueSet[field], `lost ${field}`);
      }
      assert.deepEqual(result.resource.identifier, stu3ValueSet.identifier);
      assert.deepEqual(result.resource._status, stu3ValueSet._status);
    });

    it('preserves compose and expansion unchanged', function () {
      assert.deepEqual(result.resource.compose, stu3ValueSet.compose);
      assert.deepEqual(result.resource.expansion, stu3ValueSet.expansion);
    });

    it('warns when a name does not satisfy R4 invariant vsd-0', function () {
      const source = { ...stu3ValueSet, name: 'lower case' };
      const converted = singleHopConverter.convert(source, 'R3', 'R4');

      assert.equal(converted.status, STATUS.WARNING);
      const warning = converted.postprocessors[0].messages
        .find(m => m.type === MESSAGE_TYPE.WARNING && /vsd-0/.test(m.text));
      assert.ok(warning);
      // The name identifies the resource, so it is reported, never rewritten.
      assert.equal(converted.resource.name, 'lower case');
    });

    it('does not warn for a source without extensible or a bad name', function () {
      const source = { ...stu3ValueSet };
      delete source.extensible;
      const converted = singleHopConverter.convert(source, 'R3', 'R4');

      assert.equal(converted.status, STATUS.OK);
      assert.deepEqual(converted.postprocessors[0].messages, []);
    });
  });

  describe('R4 -> R3 through singleHopConverter.convert', function () {
    let result;

    before(function () {
      result = singleHopConverter.convert(r4LossValueSet, 'R4', 'R3');
    });

    it('reports FML known gaps and best-effort final coverage', function () {
      assert.equal(result.coverage, COVERAGE.BEST_EFFORT);
      assert.equal(result.fml_base_conv.coverage, COVERAGE.KNOWN_GAPS);
      assert.equal(result.postprocessors.length, 1);
      assert.equal(result.postprocessors[0].name, 'ValueSet_R4_to_R3');
      assert.equal(result.postprocessors[0].coverage, COVERAGE.BEST_EFFORT);
      assert.equal(result.status, STATUS.WARNING);
    });

    it('normalizes filter values into lexically valid STU3 codes', function () {
      assert.equal(result.resource.compose.include[0].filter[0].value, 'padded code');
      assert.equal(result.resource.compose.exclude[0].filter[0].value, 'trailing space');
    });

    it('leaves an already-valid filter value untouched and unreported', function () {
      assert.equal(result.resource.compose.include[0].filter[1].value, 'already-valid');
      const text = result.postprocessors[0].messages.map(m => m.text).join('\n');
      assert.equal(/already-valid/.test(text), false);
    });

    it('strips canonical versions while preserving any fragment', function () {
      assert.deepEqual(result.resource.compose.include[0].valueSet, [
        'http://example.org/fhir/ValueSet/base',
        'http://example.org/fhir/ValueSet/fragment#part',
        'http://example.org/fhir/ValueSet/unversioned',
      ]);
      const text = result.postprocessors[0].messages.map(m => m.text).join('\n');
      assert.match(text, /pins a canonical version/);
    });

    it('reports the expansion parameter dateTime STU3 cannot carry', function () {
      const text = result.postprocessors[0].messages.map(m => m.text).join('\n');
      assert.match(text, /expansionTime.*valueDateTime/s);
      const parameter = result.resource.expansion.parameter[0];
      assert.equal(parameter.name, 'expansionTime');
      assert.equal('valueDateTime' in parameter, false);
    });

    it('preserves the other expansion parameter and contains entries', function () {
      assert.deepEqual(result.resource.expansion.parameter[1], {
        name: 'limitedExpansion',
        valueBoolean: true,
      });
      assert.deepEqual(result.resource.expansion.contains, r4LossValueSet.expansion.contains);
    });

    it('keeps the valueless parameter valid, retaining id and extension', function () {
      const source = {
        resourceType: 'ValueSet',
        status: 'active',
        expansion: {
          identifier: 'urn:uuid:00000000-0000-0000-0000-000000000006',
          timestamp: '2026-01-02T03:04:05Z',
          parameter: [{
            id: 'p1',
            extension: [{ url: 'http://example.org/x', valueString: 'keep me' }],
            name: 'expansionTime',
            valueDateTime: '2026-01-02T03:04:05Z',
          }],
        },
      };
      const converted = singleHopConverter.convert(source, 'R4', 'R3');
      const parameter = converted.resource.expansion.parameter[0];

      // STU3 types value[x] as 0..1, so a parameter without a value stays valid
      // as long as its required name survives.
      assert.equal(parameter.name, 'expansionTime');
      assert.equal('valueDateTime' in parameter, false);
      assert.equal(parameter.id, 'p1');
      assert.deepEqual(parameter.extension, source.expansion.parameter[0].extension);
    });

    it('emits only warning-level messages', function () {
      const messages = result.postprocessors[0].messages;
      assert.ok(messages.length > 0);
      assert.ok(messages.every(m => m.type === MESSAGE_TYPE.WARNING));
    });
  });

  describe('R4 -> R3 target validity repairs', function () {
    it('generates the expansion identifier STU3 requires (1..1) when R4 omits it', function () {
      const source = {
        resourceType: 'ValueSet',
        status: 'active',
        expansion: {
          timestamp: '2026-01-02T03:04:05Z',
          contains: [{ system: 'http://example.org/cs', code: 'a' }],
        },
      };
      const converted = singleHopConverter.convert(source, 'R4', 'R3');

      assert.match(
        converted.resource.expansion.identifier,
        /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      assert.equal(converted.status, STATUS.WARNING);
      const text = converted.postprocessors[0].messages.map(m => m.text).join('\n');
      assert.match(text, /expansion\.identifier is optional in R4 but required in STU3/);
    });

    it('leaves an existing expansion identifier alone', function () {
      const source = {
        resourceType: 'ValueSet',
        status: 'active',
        expansion: {
          identifier: 'urn:uuid:00000000-0000-0000-0000-000000000007',
          timestamp: '2026-01-02T03:04:05Z',
        },
      };
      const converted = singleHopConverter.convert(source, 'R4', 'R3');

      assert.equal(
        converted.resource.expansion.identifier,
        'urn:uuid:00000000-0000-0000-0000-000000000007',
      );
      assert.equal(converted.status, STATUS.OK);
    });

    it('removes a filter whose value cannot be a valid STU3 code', function () {
      const target = {
        resourceType: 'ValueSet',
        compose: {
          include: [{
            system: 'http://example.org/cs',
            filter: [
              { property: 'concept', op: 'in', value: '   ' },
              { property: 'concept', op: 'is-a', value: 'keep' },
            ],
          }],
        },
      };
      const result2 = conv_R4_to_R3.execute(target, { sourceResource: {} });

      assert.equal(result2.status, STATUS.WARNING);
      assert.deepEqual(target.compose.include[0].filter, [
        { property: 'concept', op: 'is-a', value: 'keep' },
      ]);
      assert.match(result2.messages[0].text, /the filter was removed/);
      assert.match(result2.messages[0].text, /include additional concepts/);
    });

    it('drops the filter element entirely when no filter survives', function () {
      const target = {
        resourceType: 'ValueSet',
        compose: {
          exclude: [{
            system: 'http://example.org/cs',
            filter: [{ property: 'concept', op: 'in', value: '  ' }],
          }],
        },
      };
      const result2 = conv_R4_to_R3.execute(target, { sourceResource: {} });

      assert.equal('filter' in target.compose.exclude[0], false);
      assert.equal(target.compose.exclude[0].system, 'http://example.org/cs');
      assert.match(result2.messages[0].text, /exclude additional concepts/);
    });

    it('generates an empty expansion so a metadata-only source stays valid (vsd-5)', function () {
      const source = {
        resourceType: 'ValueSet',
        status: 'active',
        url: 'http://example.org/fhir/ValueSet/metadata-only',
        name: 'MetadataOnly',
      };
      const converted = singleHopConverter.convert(source, 'R4', 'R3');
      const expansion = converted.resource.expansion;

      // STU3 vsd-5 needs a compose or an expansion. compose cannot be
      // synthesized (compose.include is 1..*), but an expansion carrying only
      // its two required elements is valid and asserts the least.
      assert.ok(expansion, 'expected a generated expansion');
      assert.match(
        expansion.identifier,
        /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      assert.match(expansion.timestamp, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
      assert.equal('contains' in expansion, false);
      assert.equal('compose' in converted.resource, false);

      assert.equal(converted.status, STATUS.WARNING);
      const text = converted.postprocessors[0].messages.map(m => m.text).join('\n');
      assert.match(text, /vsd-5/);
      assert.match(text, /approximates the value set's undefined membership as empty/);
    });

    it('reports the generated expansion once, not also as a missing identifier', function () {
      const target = { resourceType: 'ValueSet', status: 'active' };
      const result2 = conv_R4_to_R3.execute(target, { sourceResource: {} });

      assert.equal(result2.messages.length, 1);
      assert.match(result2.messages[0].text, /vsd-5/);
    });

    it('does not raise vsd-5 when a compose is present', function () {
      const target = {
        resourceType: 'ValueSet',
        compose: { include: [{ system: 'http://example.org/cs' }] },
      };
      const result2 = conv_R4_to_R3.execute(target, { sourceResource: {} });

      assert.equal(result2.status, STATUS.OK);
      assert.deepEqual(result2.messages, []);
    });
  });

  describe('conv_R3_to_R4.execute', function () {
    it('is a no-op for a conforming name and no extensible', function () {
      const target = { resourceType: 'ValueSet', name: 'GoodName_1' };
      const result2 = conv_R3_to_R4.execute(target, {
        fromVer: 'R3',
        toVer: 'R4',
        sourceResource: { resourceType: 'ValueSet' },
      });

      assert.equal(result2.resource, target);
      assert.equal(result2.status, STATUS.OK);
      assert.deepEqual(result2.messages, []);
    });

    it('detects an extension-only extensible primitive on the source', function () {
      const result2 = conv_R3_to_R4.execute({ resourceType: 'ValueSet' }, {
        fromVer: 'R3',
        toVer: 'R4',
        sourceResource: {
          resourceType: 'ValueSet',
          _extensible: { extension: [{ url: 'http://example.org/x' }] },
        },
      });

      assert.equal(result2.status, STATUS.WARNING);
      assert.match(result2.messages[0].text, /ValueSet\.extensible/);
    });

    it('reports both issues independently when both apply', function () {
      const result2 = conv_R3_to_R4.execute({ resourceType: 'ValueSet', name: 'bad name' }, {
        fromVer: 'R3',
        toVer: 'R4',
        sourceResource: { resourceType: 'ValueSet', extensible: true },
      });

      assert.equal(result2.messages.length, 2);
      assert.match(result2.messages[0].text, /extensible/);
      assert.match(result2.messages[1].text, /vsd-0/);
    });
  });

  describe('conv_R4_to_R3.execute', function () {
    it('is a no-op on input with none of the risky shapes', function () {
      const target = {
        resourceType: 'ValueSet',
        status: 'active',
        compose: {
          include: [{
            system: 'http://example.org/cs',
            filter: [{ property: 'concept', op: 'is-a', value: 'root' }],
            valueSet: ['http://example.org/vs'],
          }],
        },
      };
      const result2 = conv_R4_to_R3.execute(target, {
        sourceResource: { resourceType: 'ValueSet', status: 'active' },
      });

      assert.equal(result2.status, STATUS.OK);
      assert.deepEqual(result2.messages, []);
      assert.equal(target.compose.include[0].filter[0].value, 'root');
      assert.deepEqual(target.compose.include[0].valueSet, ['http://example.org/vs']);
    });

    it('leaves a fragment-only reference untouched', function () {
      const target = {
        resourceType: 'ValueSet',
        compose: { include: [{ valueSet: ['http://example.org/vs#part'] }] },
      };
      const result2 = conv_R4_to_R3.execute(target, { sourceResource: {} });

      assert.deepEqual(target.compose.include[0].valueSet, [
        'http://example.org/vs#part',
      ]);
      assert.equal(result2.status, STATUS.OK);
    });
  });
});

