/**
 * Tests for the Questionnaire R5 -> R4 postprocessor.
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { COVERAGE } from '../../../../src/converter/coverage.js';
import { MESSAGE_TYPE, STATUS } from '../../../../src/converter/diagnostics.js';
import { singleHopConverter } from '../../../../src/converter/singleHopConverter.js';
import { conv_R5_to_R4 } from '../../../../src/postprocessors/R4_R5/Questionnaire.js';

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

    it('maps coding + optionsOrType to open-choice (info message)', function () {
      const source = {
        resourceType: 'Questionnaire',
        item: [{ linkId: 'a', type: 'coding', answerConstraint: 'optionsOrType', answerOption: [{ valueCoding: { code: 'x' } }] }],
      };
      const target = { resourceType: 'Questionnaire', item: [{ linkId: 'a', type: { value: 'open-choice' }, answerConstraint: 'optionsOrType' }] };
      const res = run(target, source);
      assert.equal(res.resource.item[0].type, 'open-choice');
      assert.equal('answerConstraint' in res.resource.item[0], false);
      assert.ok(res.messages.some(m => m.type === MESSAGE_TYPE.INFO && /optionsOrType/.test(m.text)));
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
  });
});

