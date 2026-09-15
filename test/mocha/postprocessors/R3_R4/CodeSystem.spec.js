/**
 * Tests for reviewed CodeSystem conversion between STU3 (R3) and R4.
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
} from '../../../../src/postprocessors/R3_R4/CodeSystem.js';

const TEST_DATA = path.resolve(import.meta.dirname, '../../../data');
const stu3CodeSystem = JSON.parse(
  fs.readFileSync(path.join(TEST_DATA, 'codesystem-stu3.json'), 'utf-8'),
);
const r4CodeSystem = JSON.parse(
  fs.readFileSync(path.join(TEST_DATA, 'codesystem-r4.json'), 'utf-8'),
);

describe('postprocessors/R3_R4 CodeSystem', function () {
  describe('R3 -> R4 through singleHopConverter.convert', function () {
    let result;

    before(function () {
      result = singleHopConverter.convert(stu3CodeSystem, 'R3', 'R4');
    });

    it('reports complete FML, postprocessor, and final coverage', function () {
      assert.equal(result.coverage, COVERAGE.COMPLETE);
      assert.equal(result.fml_base_conv.coverage, COVERAGE.COMPLETE);
      assert.equal(result.postprocessors.length, 1);
      assert.equal(result.postprocessors[0].name, 'CodeSystem_R3_to_R4');
      assert.equal(result.postprocessors[0].coverage, COVERAGE.COMPLETE);
    });

    it('converts a conforming CodeSystem without warnings', function () {
      assert.equal(result.status, STATUS.OK);
      assert.deepEqual(result.postprocessors[0].messages, []);
    });

    it('widens the scalar STU3 identifier and preserves shared root content', function () {
      assert.deepEqual(result.resource.identifier, [stu3CodeSystem.identifier]);
      for (const field of [
        'url', 'version', 'name', 'title', 'status', 'experimental', 'date',
        'publisher', 'description', 'purpose', 'copyright', 'caseSensitive',
        'valueSet', 'hierarchyMeaning', 'compositional', 'versionNeeded',
        'content', 'count',
      ]) {
        assert.equal(result.resource[field], stu3CodeSystem[field], `lost ${field}`);
      }
      assert.deepEqual(result.resource._status, stu3CodeSystem._status);
      assert.deepEqual(result.resource.meta.profile, [
        'http://hl7.org/fhir/4.0/StructureDefinition/CodeSystem',
      ]);
    });

    it('preserves filters and their complete shared operator set', function () {
      assert.deepEqual(result.resource.filter, stu3CodeSystem.filter);
    });

    it('preserves properties and recursive polymorphic concept values', function () {
      assert.deepEqual(result.resource.property, stu3CodeSystem.property);
      assert.deepEqual(result.resource.concept, stu3CodeSystem.concept);
      assert.equal(
        result.resource.concept[0].concept[0].concept[0].property[0].valueBoolean,
        false,
      );
    });

    it('reports csd-0 without rewriting the name or lowering coverage', function () {
      const source = { ...stu3CodeSystem, name: 'lower-case-name' };
      const converted = singleHopConverter.convert(source, 'R3', 'R4');

      assert.equal(converted.coverage, COVERAGE.COMPLETE);
      assert.equal(converted.status, STATUS.WARNING);
      assert.equal(converted.resource.name, source.name);
      assert.match(converted.postprocessors[0].messages[0].text, /csd-0/);
    });
  });

  describe('R4 -> R3 through singleHopConverter.convert', function () {
    let result;

    before(function () {
      result = singleHopConverter.convert(r4CodeSystem, 'R4', 'R3');
    });

    it('reports FML known gaps and best-effort final coverage', function () {
      assert.equal(result.coverage, COVERAGE.BEST_EFFORT);
      assert.equal(result.fml_base_conv.coverage, COVERAGE.KNOWN_GAPS);
      assert.equal(result.postprocessors.length, 1);
      assert.equal(result.postprocessors[0].name, 'CodeSystem_R4_to_R3');
      assert.equal(result.postprocessors[0].coverage, COVERAGE.BEST_EFFORT);
    });

    it('narrows identifier to the STU3 scalar shape', function () {
      assert.deepEqual(result.resource.identifier, r4CodeSystem.identifier[0]);
      assert.equal(
        result.postprocessors[0].messages.some(message => /additional identifiers/.test(message.text)),
        false,
      );
    });

    it('approximates decimal declarations and values as strings', function () {
      assert.equal(result.resource.property[1].type, 'string');
      assert.deepEqual(result.resource.concept[0].property[1], {
        code: 'weight',
        valueString: '1.5',
      });
      const text = result.postprocessors[0].messages.map(message => message.text).join('\n');
      assert.match(text, /decimal property type/);
      assert.match(text, /valueDecimal.*approximated as valueString/);
    });

    it('preserves non-decimal recursive polymorphic values', function () {
      assert.deepEqual(result.resource.concept[0].property[2], {
        code: 'retired',
        valueBoolean: false,
      });
      assert.equal(result.resource.concept[0].concept[0].code, 'alpha-1');
    });

    it('preserves shared fields and primitive companions', function () {
      assert.equal(result.resource.url, r4CodeSystem.url);
      assert.equal(result.resource.valueSet, r4CodeSystem.valueSet);
      assert.equal(result.resource.content, r4CodeSystem.content);
      assert.deepEqual(result.resource._status, r4CodeSystem._status);
      assert.deepEqual(result.resource.filter, r4CodeSystem.filter);
      assert.deepEqual(result.resource.meta.profile, [
        'http://hl7.org/fhir/3.0/StructureDefinition/CodeSystem',
      ]);
    });

    it('handles cardinality, canonical, and supplement losses together', function () {
      const contentCompanion = { id: 'content-id' };
      const valueSetCompanion = { id: 'value-set-id' };
      const source = {
        resourceType: 'CodeSystem',
        status: 'active',
        identifier: [{ value: 'first' }, { value: 'second' }],
        valueSet: 'http://example.org/fhir/ValueSet/base|2.0.0#part',
        _valueSet: valueSetCompanion,
        content: 'supplement',
        _content: contentCompanion,
        supplements: 'http://example.org/fhir/CodeSystem/base',
        concept: [{ code: 'local' }],
      };
      const converted = singleHopConverter.convert(source, 'R4', 'R3');
      const text = converted.postprocessors[0].messages.map(message => message.text).join('\n');
      const engineText = converted.fml_base_conv.messages.map(message => message.text).join('\n');

      assert.deepEqual(converted.resource.identifier, source.identifier[0]);
      assert.equal(converted.resource.valueSet, 'http://example.org/fhir/ValueSet/base#part');
      assert.deepEqual(converted.resource._valueSet, valueSetCompanion);
      assert.equal(converted.resource.content, 'fragment');
      assert.deepEqual(converted.resource._content, contentCompanion);
      assert.equal('supplements' in converted.resource, false);
      assert.deepEqual(converted.resource.concept, source.concept);
      assert.match(text, /pins a canonical version/);
      assert.match(text, /supplements has no STU3 equivalent/);
      assert.match(text, /supplement.*approximated as.*fragment/s);

      // The engine enforces STU3's identifier 0..1 while writing and reports
      // the loss, so the postprocessor must not report it a second time.
      assert.match(engineText, /CodeSystem\.identifier accepts at most one value/);
      assert.equal(/identifier/.test(text), false);
    });

    it('preserves all shared hierarchyMeaning codes without warnings', function () {
      for (const hierarchyMeaning of ['grouped-by', 'is-a', 'part-of', 'classified-with']) {
        const source = {
          resourceType: 'CodeSystem',
          status: 'active',
          content: 'complete',
          hierarchyMeaning,
        };
        const converted = singleHopConverter.convert(source, 'R4', 'R3');

        assert.equal(converted.resource.hierarchyMeaning, hierarchyMeaning);
        assert.equal(converted.status, STATUS.OK);
      }
    });
  });

  describe('direct postprocessor branch cases', function () {
    it('R3 -> R4 is a no-op for a conforming name', function () {
      const target = { resourceType: 'CodeSystem', name: 'GoodName_1' };
      const result = conv_R3_to_R4.execute(target, { toVer: 'R4' });

      assert.equal(result.resource, target);
      assert.equal(result.status, STATUS.OK);
      assert.deepEqual(result.messages, []);
    });

    it('R4 -> R3 retains an extension-only decimal as valueString metadata', function () {
      const companion = {
        extension: [{
          url: 'http://example.org/fhir/StructureDefinition/decimal-note',
          valueString: 'value intentionally absent',
        }],
      };
      const source = {
        resourceType: 'CodeSystem',
        concept: [{
          code: 'a',
          property: [{ code: 'weight', _valueDecimal: companion }],
        }],
      };
      const target = {
        resourceType: 'CodeSystem',
        concept: [{ code: 'a', property: [{ code: 'weight' }] }],
      };
      const result = conv_R4_to_R3.execute(target, { sourceResource: source });

      assert.equal(result.status, STATUS.WARNING);
      assert.equal('valueString' in target.concept[0].property[0], false);
      assert.deepEqual(target.concept[0].property[0]._valueString, companion);
    });

    it('R4 -> R3 copies the decimal companion without aliasing the source', function () {
      const source = {
        resourceType: 'CodeSystem',
        concept: [{
          code: 'a',
          property: [{
            code: 'weight',
            valueDecimal: 1.5,
            _valueDecimal: { id: 'dec-id', extension: [{ url: 'http://e.org/x', valueCode: 'v' }] },
          }],
        }],
      };
      const target = {
        resourceType: 'CodeSystem',
        concept: [{ code: 'a', property: [{ code: 'weight' }] }],
      };
      const result = conv_R4_to_R3.execute(target, { sourceResource: source });
      const copied = result.resource.concept[0].property[0]._valueString;
      const original = source.concept[0].property[0]._valueDecimal;

      // Content is carried across in full ...
      assert.equal(copied.id, 'dec-id');
      assert.deepEqual(copied.extension, original.extension);

      // ... but as an independent object, so the read-only source snapshot
      // cannot be corrupted by anything that edits the converted resource.
      assert.notEqual(copied, original);
      copied.extension[0].valueCode = 'mutated';
      assert.equal(original.extension[0].valueCode, 'v');
    });

    it('R4 -> R3 is a no-op when none of the risky shapes is present', function () {
      const target = {
        resourceType: 'CodeSystem',
        identifier: [{ value: 'only' }],
        valueSet: 'http://example.org/fhir/ValueSet/base#part',
        content: 'complete',
        property: [{ code: 'flag', type: 'boolean' }],
      };
      const result = conv_R4_to_R3.execute(target, {
        sourceResource: { resourceType: 'CodeSystem' },
      });

      assert.equal(result.status, STATUS.OK);
      assert.deepEqual(result.messages, []);
      assert.deepEqual(target.identifier, { value: 'only' });
      assert.equal(target.valueSet, 'http://example.org/fhir/ValueSet/base#part');
    });

    it('emits warning-level diagnostics for every lossy or approximate change', function () {
      const source = {
        resourceType: 'CodeSystem',
        identifier: [{ value: 'one' }, { value: 'two' }],
        supplements: 'http://example.org/base',
      };
      const target = {
        resourceType: 'CodeSystem',
        identifier: source.identifier,
      };
      const result = conv_R4_to_R3.execute(target, { sourceResource: source });

      assert.ok(result.messages.length > 0);
      assert.ok(result.messages.every(message => message.type === MESSAGE_TYPE.WARNING));
    });

    it('R4 -> R3 narrows a target that still carries an identifier array', function () {
      const target = {
        resourceType: 'CodeSystem',
        identifier: [{ value: 'one' }, { value: 'two' }],
      };
      const result = conv_R4_to_R3.execute(target, {
        sourceResource: { resourceType: 'CodeSystem', identifier: target.identifier },
      });
      const text = result.messages.map(message => message.text).join('\n');

      assert.deepEqual(result.resource.identifier, { value: 'one' });
      assert.match(text, /additional identifiers were dropped/);
    });

    it('R4 -> R3 does not claim an identifier was retained when none was', function () {
      // The source had two identifiers but the target carries none, so there
      // is nothing for this postprocessor to narrow and nothing it can honestly
      // describe as retained.
      const target = { resourceType: 'CodeSystem' };
      const result = conv_R4_to_R3.execute(target, {
        sourceResource: {
          resourceType: 'CodeSystem',
          identifier: [{ value: 'one' }, { value: 'two' }],
        },
      });

      assert.equal('identifier' in result.resource, false);
      assert.equal(
        result.messages.some(message => /identifier/.test(message.text)),
        false,
      );
    });

    it('R4 -> R3 drops an empty identifier array without reporting a loss', function () {
      const target = { resourceType: 'CodeSystem', identifier: [] };
      const result = conv_R4_to_R3.execute(target, {
        sourceResource: { resourceType: 'CodeSystem' },
      });

      assert.equal('identifier' in result.resource, false);
      assert.deepEqual(result.messages, []);
    });
  });
});
