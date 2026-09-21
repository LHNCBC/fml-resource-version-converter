/**
 * Tests for reviewed CodeSystem conversion between R4 and R5.
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { COVERAGE } from '../../../../src/converter/coverage.js';
import { MESSAGE_TYPE, STATUS } from '../../../../src/converter/diagnostics.js';
import { singleHopConverter } from '../../../../src/converter/singleHopConverter.js';
import { conv_R4_to_R5, conv_R5_to_R4 } from '../../../../src/postprocessors/R4_R5/CodeSystem.js';

const TEST_DATA = path.resolve(import.meta.dirname, '../../../data');
const r4CodeSystem = JSON.parse(
  fs.readFileSync(path.join(TEST_DATA, 'codesystem-r4.json'), 'utf-8'),
);
const r5LossCodeSystem = JSON.parse(
  fs.readFileSync(path.join(TEST_DATA, 'codesystem-r5-loss.json'), 'utf-8'),
);

describe('postprocessors/R4_R5 CodeSystem', function () {
  describe('R4 -> R5 through singleHopConverter.convert', function () {
    let result;

    before(function () {
      result = singleHopConverter.convert(r4CodeSystem, 'R4', 'R5');
    });

    it('reports FML known gaps repaired to complete coverage', function () {
      assert.equal(result.coverage, COVERAGE.COMPLETE);
      assert.equal(result.fml_base_conv.coverage, COVERAGE.KNOWN_GAPS);
      assert.equal(result.postprocessors.length, 1);
      assert.equal(result.postprocessors[0].name, 'CodeSystem_R4_to_R5');
      assert.equal(result.postprocessors[0].coverage, COVERAGE.COMPLETE);
    });

    it('converts a non-supplement code system without any warning', function () {
      assert.equal(result.status, STATUS.OK);
      assert.deepEqual(result.postprocessors[0].messages, []);
    });

    it('preserves representative root and primitive-companion content', function () {
      assert.equal(result.resource.resourceType, 'CodeSystem');
      assert.equal(result.resource.url, r4CodeSystem.url);
      assert.equal(result.resource.status, r4CodeSystem.status);
      assert.deepEqual(result.resource._status, r4CodeSystem._status);
      assert.deepEqual(result.resource.identifier, r4CodeSystem.identifier);
      assert.equal(result.resource.content, r4CodeSystem.content);
      assert.equal(result.resource.count, r4CodeSystem.count);
      assert.deepEqual(result.resource.meta.profile, [
        'http://hl7.org/fhir/5.0/StructureDefinition/CodeSystem',
      ]);
    });

    it('preserves filters, properties, and nested concepts', function () {
      assert.deepEqual(result.resource.filter, r4CodeSystem.filter);
      assert.deepEqual(result.resource.property, r4CodeSystem.property);
      assert.deepEqual(result.resource.concept, r4CodeSystem.concept);
    });

    it('maps every R4 filter operator without a warning', function () {
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
        const converted = singleHopConverter.convert(source, 'R4', 'R5');
        assert.deepEqual(converted.resource.filter[0].operator, [operator]);
        assert.equal(converted.status, STATUS.OK, `unexpected warning for operator ${operator}`);
      }
    });

    it('maps every R4 property type without a warning', function () {
      const types = ['code', 'Coding', 'string', 'integer', 'boolean', 'dateTime', 'decimal'];

      for (const type of types) {
        const source = {
          resourceType: 'CodeSystem',
          status: 'active',
          content: 'complete',
          property: [{ code: 'p', type }],
        };
        const converted = singleHopConverter.convert(source, 'R4', 'R5');
        assert.equal(converted.resource.property[0].type, type);
        assert.equal(converted.status, STATUS.OK, `unexpected warning for property type ${type}`);
      }
    });

    it('satisfies csd-4 by marking supplements absent, without inventing a canonical', function () {
      const source = {
        resourceType: 'CodeSystem',
        url: 'http://example.org/fhir/CodeSystem/supplement',
        status: 'active',
        content: 'supplement',
      };
      const converted = singleHopConverter.convert(source, 'R4', 'R5');

      assert.equal(converted.status, STATUS.WARNING);
      assert.equal(converted.resource.content, 'supplement');
      assert.equal('supplements' in converted.resource, false);
      assert.deepEqual(converted.resource._supplements, {
        extension: [{
          url: 'http://hl7.org/fhir/StructureDefinition/data-absent-reason',
          valueCode: 'unknown',
        }],
      });
      assert.match(converted.postprocessors[0].messages[0].text, /csd-4/);
      assert.match(converted.postprocessors[0].messages[0].text, /data-absent-reason/);
    });

    it('does not warn or alter a supplement that names what it supplements', function () {
      const source = {
        resourceType: 'CodeSystem',
        url: 'http://example.org/fhir/CodeSystem/supplement',
        status: 'active',
        content: 'supplement',
        supplements: 'http://example.org/fhir/CodeSystem/base',
      };
      const converted = singleHopConverter.convert(source, 'R4', 'R5');

      assert.equal(converted.status, STATUS.OK);
      assert.equal(converted.resource.supplements, source.supplements);
      assert.equal('_supplements' in converted.resource, false);
    });
  });

  describe('csd-4 repair judges presence by ele-1, not by companion keys', function () {
    /**
     * Run the R4 -> R5 postprocessor directly on a supplement target.
     *
     * The repair decision is made on the FML output, so it is exercised here
     * without the engine, which may itself drop a value-less companion.
     *
     * @param {Object} companion Value of `_supplements`, or undefined for none.
     * @returns {Object} Postprocessor result.
     */
    function repair(companion) {
      const target = { resourceType: 'CodeSystem', status: 'active', content: 'supplement' };
      if (companion !== undefined) target._supplements = companion;
      return conv_R4_to_R5.execute(target, { sourceResource: {}, fromVer: 'R4', toVer: 'R5' });
    }

    const DAR = 'http://hl7.org/fhir/StructureDefinition/data-absent-reason';

    it('repairs an id-only companion, which alone does not satisfy ele-1', function () {
      const result = repair({ id: 'supplements-id' });

      assert.equal(result.status, STATUS.WARNING);
      assert.match(result.messages[0].text, /csd-4/);
      assert.equal(
        result.resource._supplements.extension.some(entry => entry.url === DAR),
        true,
        'expected the data-absent-reason extension to be added',
      );
    });

    it('keeps the element id while repairing it', function () {
      const result = repair({ id: 'supplements-id' });

      assert.equal(result.resource._supplements.id, 'supplements-id');
    });

    it('repairs an empty companion', function () {
      const result = repair({});

      assert.equal(result.status, STATUS.WARNING);
      assert.equal(result.resource._supplements.extension[0].url, DAR);
    });

    it('leaves an extension-only companion alone, since it satisfies ele-1', function () {
      const extension = [{ url: 'http://example.org/ext', valueCode: 'x' }];
      const result = repair({ extension });

      assert.equal(result.status, STATUS.OK);
      assert.equal(result.messages.length, 0);
      assert.deepEqual(result.resource._supplements.extension, extension);
    });

    it('leaves a real canonical value alone', function () {
      const target = {
        resourceType: 'CodeSystem',
        status: 'active',
        content: 'supplement',
        supplements: 'http://example.org/fhir/CodeSystem/base',
        _supplements: { id: 'supplements-id' },
      };
      const result = conv_R4_to_R5.execute(target, {
        sourceResource: {},
        fromVer: 'R4',
        toVer: 'R5',
      });

      assert.equal(result.status, STATUS.OK);
      assert.equal(result.resource.supplements, 'http://example.org/fhir/CodeSystem/base');
      assert.deepEqual(result.resource._supplements, { id: 'supplements-id' });
    });
  });

  describe('R5 -> R4 through singleHopConverter.convert', function () {
    let result;

    before(function () {
      result = singleHopConverter.convert(r5LossCodeSystem, 'R5', 'R4');
    });

    it('reports FML known gaps and best-effort final coverage', function () {
      assert.equal(result.coverage, COVERAGE.BEST_EFFORT);
      assert.equal(result.fml_base_conv.coverage, COVERAGE.KNOWN_GAPS);
      assert.equal(result.postprocessors.length, 1);
      assert.equal(result.postprocessors[0].name, 'CodeSystem_R5_to_R4');
      assert.equal(result.postprocessors[0].coverage, COVERAGE.BEST_EFFORT);
    });

    it('reports the R5-only content that was dropped', function () {
      const warning = result.postprocessors[0].messages.find(message =>
        message.type === MESSAGE_TYPE.WARNING && /content was dropped/.test(message.text));

      assert.ok(warning);
      assert.match(warning.text, /R5-only CodeSystem content was dropped because R4 has no equivalent/);
      for (const path of [
        'CodeSystem.versionAlgorithm\\[x\\]',
        'CodeSystem.copyrightLabel',
        'CodeSystem.approvalDate',
        'CodeSystem.lastReviewDate',
        'CodeSystem.effectivePeriod',
        'CodeSystem.topic',
        'CodeSystem.author',
        'CodeSystem.editor',
        'CodeSystem.reviewer',
        'CodeSystem.endorser',
        'CodeSystem.relatedArtifact',
        'CodeSystem.concept.designation.additionalUse',
      ]) {
        assert.match(warning.text, new RegExp(path));
      }
    });

    it('actually removes the dropped content from the converted resource', function () {
      assert.equal('copyrightLabel' in result.resource, false);
      assert.equal('approvalDate' in result.resource, false);
      assert.equal('relatedArtifact' in result.resource, false);
      assert.equal('additionalUse' in result.resource.concept[0].designation[0], false);
      assert.equal(
        'additionalUse' in result.resource.concept[0].concept[0].designation[0],
        false,
      );
    });

    it('removes R5-only operator codes but keeps the representable ones', function () {
      assert.equal(result.status, STATUS.WARNING);
      assert.deepEqual(result.resource.filter[0].operator, ['is-a', 'descendent-of']);
      assert.ok(result.postprocessors[0].messages.some(message =>
        /CodeSystem\.filter\[0\]\.operator: removed "child-of", "descendent-leaf"/.test(message.text)
        && /still declares its remaining operators/.test(message.text)));
    });

    it('drops a filter whose only operator has no R4 equivalent', function () {
      const codes = result.resource.filter.map(entry => entry.code);

      assert.deepEqual(codes, ['concept', 'display']);
      assert.ok(result.postprocessors[0].messages.some(message =>
        /CodeSystem\.filter\[1\] \(code "leaves"\) was dropped/.test(message.text)
        && /operator is required/.test(message.text)));
    });

    it('leaves a fully representable filter untouched', function () {
      const displayFilter = result.resource.filter.find(entry => entry.code === 'display');

      assert.deepEqual(displayFilter.operator, ['=', 'regex']);
    });

    it('still preserves fields shared with R4', function () {
      assert.equal(result.resource.url, r5LossCodeSystem.url);
      assert.equal(result.resource.version, r5LossCodeSystem.version);
      assert.equal(result.resource.status, r5LossCodeSystem.status);
      assert.equal(result.resource.content, r5LossCodeSystem.content);
      assert.equal(result.resource.hierarchyMeaning, r5LossCodeSystem.hierarchyMeaning);
      assert.deepEqual(result.resource.property, r5LossCodeSystem.property);
      assert.equal(result.resource.concept[0].code, 'alpha');
      assert.deepEqual(result.resource.meta.profile, [
        'http://hl7.org/fhir/4.0/StructureDefinition/CodeSystem',
      ]);
    });
  });

  describe('conv_R5_to_R4.execute', function () {
    it('does not warn when the source contains only R4-compatible fields', function () {
      const target = { resourceType: 'CodeSystem', status: 'active', content: 'complete' };
      const source = { resourceType: 'CodeSystem', status: 'active', content: 'complete' };
      const result = conv_R5_to_R4.execute(target, { sourceResource: source });

      assert.equal(result.resource, target);
      assert.equal(result.status, STATUS.OK);
      assert.deepEqual(result.messages, []);
    });

    it('reports an extension-only copyrightLabel primitive', function () {
      const source = {
        resourceType: 'CodeSystem',
        _copyrightLabel: {
          extension: [{
            url: 'http://example.org/fhir/StructureDefinition/label-note',
            valueString: 'extension-only label',
          }],
        },
      };
      const result = conv_R5_to_R4.execute(
        { resourceType: 'CodeSystem' },
        { sourceResource: source },
      );

      assert.equal(result.status, STATUS.WARNING);
      assert.match(result.messages[0].text, /CodeSystem\.copyrightLabel/);
    });

    it('reports a versionAlgorithmCoding choice', function () {
      const source = {
        resourceType: 'CodeSystem',
        versionAlgorithmCoding: { system: 'http://example.org', code: 'natural' },
      };
      const result = conv_R5_to_R4.execute(
        { resourceType: 'CodeSystem' },
        { sourceResource: source },
      );

      assert.equal(result.status, STATUS.WARNING);
      assert.match(result.messages[0].text, /CodeSystem\.versionAlgorithm\[x\]/);
    });

    it('keeps the _operator companion aligned when an operator is removed', function () {
      const companion = { id: 'is-a-metadata' };
      const target = {
        resourceType: 'CodeSystem',
        filter: [{
          code: 'concept',
          operator: ['child-of', 'is-a'],
          _operator: [null, companion],
          value: 'root',
        }],
      };
      const result = conv_R5_to_R4.execute(target, {
        sourceResource: { resourceType: 'CodeSystem' },
        fromVer: 'R5',
        toVer: 'R4',
      });

      assert.equal(result.status, STATUS.WARNING);
      assert.deepEqual(target.filter[0].operator, ['is-a']);
      assert.deepEqual(target.filter[0]._operator, [companion]);
    });

    it('removes the filter array entirely when every filter is dropped', function () {
      const target = {
        resourceType: 'CodeSystem',
        filter: [
          { code: 'a', operator: ['child-of'], value: 'x' },
          { code: 'b', operator: ['descendent-leaf'], value: 'y' },
        ],
      };
      const result = conv_R5_to_R4.execute(target, {
        sourceResource: { resourceType: 'CodeSystem' },
        fromVer: 'R5',
        toVer: 'R4',
      });

      assert.equal(result.status, STATUS.WARNING);
      assert.equal('filter' in target, false);
      assert.equal(result.messages.length, 2);
    });

    it('names the actual hop versions in its diagnostics', function () {
      const target = {
        resourceType: 'CodeSystem',
        filter: [{ code: 'a', operator: ['child-of'], value: 'x' }],
      };
      const result = conv_R5_to_R4.execute(target, {
        sourceResource: { resourceType: 'CodeSystem', topic: [{ text: 'x' }] },
        fromVer: 'R5',
        toVer: 'R4B',
      });
      const text = result.messages.map(message => message.text).join('\n');

      assert.match(text, /R5-only CodeSystem content was dropped because R4B has no equivalent/);
      assert.match(text, /R4B does not define it/);
    });
  });

  describe('conv_R4_to_R5.execute', function () {
    it('does not warn for a code system that is not a supplement', function () {
      const target = { resourceType: 'CodeSystem', status: 'active', content: 'complete' };
      const result = conv_R4_to_R5.execute(target, { sourceResource: target });

      assert.equal(result.resource, target);
      assert.equal(result.status, STATUS.OK);
      assert.deepEqual(result.messages, []);
      assert.equal('_supplements' in target, false);
    });

    it('leaves an extension-only supplements primitive alone', function () {
      const companion = {
        extension: [{
          url: 'http://example.org/fhir/StructureDefinition/supplements-note',
          valueString: 'extension-only canonical',
        }],
      };
      const target = {
        resourceType: 'CodeSystem',
        content: 'supplement',
        _supplements: companion,
      };
      const result = conv_R4_to_R5.execute(target, { sourceResource: target });

      assert.equal(result.status, STATUS.OK);
      assert.deepEqual(result.messages, []);
      assert.deepEqual(target._supplements, companion);
    });

    it('is idempotent when run twice over the same resource', function () {
      const target = { resourceType: 'CodeSystem', content: 'supplement' };
      conv_R4_to_R5.execute(target, { sourceResource: target });
      const second = conv_R4_to_R5.execute(target, { sourceResource: target });

      assert.equal(target._supplements.extension.length, 1);
      assert.equal(second.status, STATUS.OK);
      assert.deepEqual(second.messages, []);
    });

    it('names the actual hop versions in its diagnostics', function () {
      const target = { resourceType: 'CodeSystem', content: 'supplement' };
      const result = conv_R4_to_R5.execute(target, {
        sourceResource: target,
        fromVer: 'R4B',
        toVer: 'R5',
      });

      assert.equal(result.status, STATUS.WARNING);
      assert.match(result.messages[0].text, /R4B allows this; R5 requires supplements/);
    });
  });
});
