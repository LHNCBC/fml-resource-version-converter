/**
 * Tests for the Questionnaire R4 <-> R5 postprocessors.
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { COVERAGE } from '../../../../src/converter/coverage.js';
import { MESSAGE_TYPE, STATUS } from '../../../../src/converter/diagnostics.js';
import { singleHopConverter } from '../../../../src/converter/singleHopConverter.js';
import {
  conv_R4_to_R5,
  conv_R5_to_R4,
} from '../../../../src/postprocessors/R4_R5/Questionnaire.js';
import { DATA_ABSENT_REASON_URL } from '../../../../src/postprocessors/util/elements.js';

const TEST_DATA = path.resolve(import.meta.dirname, '../../../data');
const r5Questionnaire = JSON.parse(
  fs.readFileSync(path.join(TEST_DATA, 'qn-ver-conv-test-r5base.json'), 'utf-8'),
);

/**
 * Find a top-level item by linkId.
 *
 * @param {Object} resource Questionnaire resource.
 * @param {string} linkId Item linkId.
 * @returns {Object|undefined} The matching item.
 */
function item(resource, linkId) {
  return resource.item.find(it => it.linkId === linkId);
}


describe('postprocessors/R4_R5 Questionnaire R4 -> R5', function () {
  const source = {
    resourceType: 'Questionnaire',
    status: 'active',
    item: [
      { linkId: 'trigger', type: 'boolean' },
      {
        linkId: 'conditional',
        type: 'string',
        enableWhen: [
          { question: 'trigger', operator: '=', answerBoolean: true },
          { question: 'trigger', operator: '!=', answerBoolean: false },
        ],
      },
    ],
  };

  it('repairs the two-condition que-12 gap through the conversion pipeline', function () {
    const result = singleHopConverter.convert(source, 'R4', 'R5');
    const conditional = item(result.resource, 'conditional');

    assert.equal(result.coverage, COVERAGE.COMPLETE);
    assert.equal(result.fml_base_conv.coverage, COVERAGE.KNOWN_GAPS);
    assert.equal(result.postprocessors.length, 1);
    assert.equal(result.postprocessors[0].name, 'Questionnaire_R4_to_R5');
    assert.equal(result.postprocessors[0].coverage, COVERAGE.COMPLETE);
    assert.equal(result.status, STATUS.WARNING);
    assert.equal('enableBehavior' in conditional, false);
    assert.deepEqual(conditional._enableBehavior, {
      extension: [{ url: DATA_ABSENT_REASON_URL, valueCode: 'unknown' }],
    });
    assert.ok(result.postprocessors[0].messages.some(message =>
      message.type === MESSAGE_TYPE.WARNING && /R5 requires enableBehavior/.test(message.text)));
  });

  describe('conv_R4_to_R5.execute (branch cases)', function () {
    /**
     * Run the postprocessor against an R5 target.
     *
     * @param {Object} target FML-converted R5 target resource.
     * @returns {Object} The processor result.
     */
    function run(target) {
      return conv_R4_to_R5.execute(target, { fromVer: 'R4', toVer: 'R5' });
    }

    it('repairs nested items recursively', function () {
      const target = {
        resourceType: 'Questionnaire',
        item: [{
          linkId: 'group',
          type: 'group',
          item: [{
            linkId: 'nested',
            type: 'string',
            enableWhen: [{ question: 'a' }, { question: 'b' }],
          }],
        }],
      };
      const result = run(target);

      assert.equal(result.status, STATUS.WARNING);
      assert.equal(
        result.resource.item[0].item[0]._enableBehavior.extension[0].url,
        DATA_ABSENT_REASON_URL,
      );
    });

    it('leaves a value or extension-only enableBehavior unchanged', function () {
      const companion = { extension: [{ url: 'http://example.org/behavior', valueCode: 'known' }] };
      const target = {
        resourceType: 'Questionnaire',
        item: [
          {
            linkId: 'valued', type: 'string', enableBehavior: 'all',
            enableWhen: [{ question: 'a' }, { question: 'b' }],
          },
          {
            linkId: 'extension-only', type: 'string', _enableBehavior: companion,
            enableWhen: [{ question: 'a' }, { question: 'b' }],
          },
        ],
      };
      const result = run(target);

      assert.equal(result.status, STATUS.OK);
      assert.equal(result.messages.length, 0);
      assert.equal(result.resource.item[0].enableBehavior, 'all');
      assert.deepEqual(result.resource.item[1]._enableBehavior, companion);
    });
  });
});


describe('postprocessors/R4_R5 Questionnaire R5 -> R4', function () {

  // -------- through the single-hop pipeline --------------------------------
  describe('via singleHopConverter.convert', function () {
    let result;

    before(function () {
      result = singleHopConverter.convert(r5Questionnaire, 'R5', 'R4');
    });

    it('registers the postprocessor and reports FML known gaps + best-effort hop', function () {
      assert.equal(result.coverage, COVERAGE.BEST_EFFORT);
      assert.equal(result.fml_base_conv.coverage, COVERAGE.KNOWN_GAPS);
      assert.equal(result.postprocessors.length, 1);
      assert.equal(result.postprocessors[0].name, 'Questionnaire_R5_to_R4');
      assert.equal(result.postprocessors[0].coverage, COVERAGE.BEST_EFFORT);
    });

    it('corrects item.type narrowing from the R5 source', function () {
      // coding + optionsOrString + options -> open-choice
      assert.equal(item(result.resource, '/X-003').type, 'open-choice');
      // non-coding (integer) + optionsOrType + options -> keep base type
      assert.equal(item(result.resource, '/X-010').type, 'integer');
      // coding + answerValueSet (no constraint) -> choice
      assert.equal(item(result.resource, '/X-012').type, 'choice');
    });

    it('leaves every item.type a plain string (no malformed { value } object)', function () {
      for (const it of result.resource.item) {
        assert.equal(typeof it.type, 'string', `item ${it.linkId} type should be a string`);
      }
    });

    it('drops answerConstraint (no R4 equivalent)', function () {
      for (const it of result.resource.item) {
        assert.equal('answerConstraint' in it, false, `item ${it.linkId} kept answerConstraint`);
      }
    });

    it('warns about the lossy optionsOrType narrowing on X-010', function () {
      assert.equal(result.status, STATUS.WARNING);
      const warnings = result.postprocessors[0].messages
        .filter(m => m.type === MESSAGE_TYPE.WARNING);
      assert.ok(warnings.some(m => /\/X-010/.test(m.text) && /options-only/.test(m.text)));
    });

    it('does not inject a conversion provenance meta.tag', function () {
      const inputTags = (r5Questionnaire.meta?.tag ?? []).length;
      const outputTags = (result.resource.meta?.tag ?? []).length;
      assert.equal(outputTags, inputTags);
    });

    it('warns when the FML drops R5-only Questionnaire content', function () {
      const source = {
        resourceType: 'Questionnaire',
        status: 'active',
        versionAlgorithmString: 'semver',
        copyrightLabel: 'Example copyright',
        item: [{ linkId: 'a', type: 'string', disabledDisplay: 'hidden' }],
      };
      const converted = singleHopConverter.convert(source, 'R5', 'R4');
      const messages = converted.postprocessors[0].messages
        .map(message => message.text)
        .join('\n');

      assert.equal(converted.status, STATUS.WARNING);
      assert.equal('versionAlgorithmString' in converted.resource, false);
      assert.equal('copyrightLabel' in converted.resource, false);
      assert.equal('disabledDisplay' in converted.resource.item[0], false);
      assert.match(messages, /Questionnaire\.versionAlgorithm\[x\]/);
      assert.match(messages, /Questionnaire\.copyrightLabel/);
      assert.match(messages, /Questionnaire\.item\.disabledDisplay/);
    });
  });

  // -------- direct unit coverage of the branch cases -----------------------
  describe('conv_R5_to_R4.execute (branch cases)', function () {
    /**
     * Run the postprocessor against a target/source pair.
     *
     * @param {Object} target FML-converted target resource.
     * @param {Object} source R5 source resource.
     * @returns {Object} The processor result.
     */
    function run(target, source) {
      return conv_R5_to_R4.execute(target, { sourceResource: source, fromVer: 'R5', toVer: 'R4' });
    }

    it('maps coding without options to choice (info message)', function () {
      const source = { resourceType: 'Questionnaire', item: [{ linkId: 'a', type: 'coding' }] };
      const target = { resourceType: 'Questionnaire', item: [{ linkId: 'a', type: { value: 'open-choice' } }] };
      const res = run(target, source);
      assert.equal(res.resource.item[0].type, 'choice');
      assert.equal(res.status, STATUS.OK);
      assert.ok(res.messages.some(m => m.type === MESSAGE_TYPE.INFO && /\ba\b/.test(m.text)));
    });

    it('maps coding + optionsOrType to open-choice (warning message)', function () {
      const source = {
        resourceType: 'Questionnaire',
        item: [{ linkId: 'a', type: 'coding', answerConstraint: 'optionsOrType', answerOption: [{ valueCoding: { code: 'x' } }] }],
      };
      const target = { resourceType: 'Questionnaire', item: [{ linkId: 'a', type: { value: 'open-choice' }, answerConstraint: 'optionsOrType' }] };
      const res = run(target, source);
      assert.equal(res.resource.item[0].type, 'open-choice');
      assert.equal('answerConstraint' in res.resource.item[0], false);
      assert.equal(res.status, STATUS.WARNING);
      assert.ok(res.messages.some(m =>
        m.type === MESSAGE_TYPE.WARNING
        && /optionsOrType/.test(m.text)
        && /R5 allows any coding but R4 open-choice/.test(m.text)));
    });

    it('recurses into nested items', function () {
      const source = {
        resourceType: 'Questionnaire',
        item: [{
          linkId: 'g', type: 'group',
          item: [{ linkId: 'c', type: 'coding', answerValueSet: 'vs' }],
        }],
      };
      const target = {
        resourceType: 'Questionnaire',
        item: [{
          linkId: 'g', type: 'group',
          item: [{ linkId: 'c', type: { value: 'open-choice' } }],
        }],
      };
      const res = run(target, source);
      assert.equal(res.resource.item[0].item[0].type, 'choice');
    });

    it('reports extension-only R5 fields, including a nested disabledDisplay', function () {
      const extension = { extension: [{ url: 'http://example.org/metadata', valueString: 'x' }] };
      const source = {
        resourceType: 'Questionnaire',
        _versionAlgorithmString: extension,
        _copyrightLabel: extension,
        item: [{
          linkId: 'group',
          type: 'group',
          item: [{ linkId: 'nested', type: 'string', _disabledDisplay: extension }],
        }],
      };
      const target = {
        resourceType: 'Questionnaire',
        item: [{
          linkId: 'group',
          type: 'group',
          item: [{ linkId: 'nested', type: 'string' }],
        }],
      };
      const res = run(target, source);
      const text = res.messages.map(message => message.text).join('\n');

      assert.equal(res.status, STATUS.WARNING);
      assert.match(text, /Questionnaire\.versionAlgorithm\[x\]/);
      assert.match(text, /Questionnaire\.copyrightLabel/);
      assert.match(text, /Questionnaire\.item\.disabledDisplay/);
    });
  });
});
