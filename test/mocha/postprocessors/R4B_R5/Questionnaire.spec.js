/**
 * Tests for the Questionnaire R4B <-> R5 conversions.
 *
 * R5 -> R4B: R4B is identical to R4 for Questionnaire.item, so the FML mis-narrows
 * item.type the same way as R5 -> R4; the Questionnaire_R5_to_R4B postprocessor
 * (shared logic) corrects it.
 * R4B -> R5: the FML fully covers it (like R4 -> R5); no postprocessor.
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { COVERAGE } from '../../../../src/converter/coverage.js';
import { MESSAGE_TYPE, STATUS } from '../../../../src/converter/diagnostics.js';
import { convertSingleHop } from '../../../../src/converter/singleHopConverter.js';

const TEST_DATA = path.resolve(import.meta.dirname, '../../../data');
const r5Questionnaire = JSON.parse(
  fs.readFileSync(path.join(TEST_DATA, 'qn-ver-conv-test-r5base.json'), 'utf-8'),
);
const r4bQuestionnaire = JSON.parse(
  fs.readFileSync(path.join(TEST_DATA, 'qn-ver-conv-test-r4bbase.json'), 'utf-8'),
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


describe('postprocessors/R4B_R5 Questionnaire R5 -> R4B', function () {
  let result;

  before(function () {
    result = convertSingleHop(r5Questionnaire, 'R5', 'R4B');
  });

  it('registers the postprocessor and reports FML known gaps + best-effort hop', function () {
    assert.equal(result.coverage, COVERAGE.BEST_EFFORT);
    assert.equal(result.fml_base_conv.coverage, COVERAGE.KNOWN_GAPS);
    assert.equal(result.postprocessors.length, 1);
    assert.equal(result.postprocessors[0].name, 'Questionnaire_R5_to_R4B');
    assert.equal(result.postprocessors[0].coverage, COVERAGE.BEST_EFFORT);
  });

  it('corrects item.type narrowing from the R5 source', function () {
    assert.equal(item(result.resource, '/X-003').type, 'open-choice');
    assert.equal(item(result.resource, '/X-010').type, 'integer'); // non-coding + options -> keep base
    assert.equal(item(result.resource, '/X-012').type, 'choice');
  });

  it('leaves every item.type a plain string (no malformed { value } object)', function () {
    for (const it of result.resource.item) {
      assert.equal(typeof it.type, 'string', `item ${it.linkId} type should be a string`);
    }
  });

  it('drops answerConstraint (no R4B equivalent)', function () {
    for (const it of result.resource.item) {
      assert.equal('answerConstraint' in it, false, `item ${it.linkId} kept answerConstraint`);
    }
  });

  it('warns about the lossy optionsOrType narrowing on X-010', function () {
    assert.equal(result.status, STATUS.WARNING);
    const warnings = result.postprocessors[0].messages.filter(m => m.type === MESSAGE_TYPE.WARNING);
    assert.ok(warnings.some(m => /\/X-010/.test(m.text) && /options-only/.test(m.text)));
  });
});


describe('postprocessors/R4B_R5 Questionnaire R4B -> R5 (FML-only)', function () {
  let result;

  before(function () {
    result = convertSingleHop(r4bQuestionnaire, 'R4B', 'R5');
  });

  it('is registered complete with no postprocessor', function () {
    assert.equal(result.coverage, COVERAGE.COMPLETE);
    assert.equal(result.fml_base_conv.coverage, COVERAGE.COMPLETE);
    assert.equal('postprocessors' in result, false);
  });

  it('maps choice/open-choice to coding + answerConstraint', function () {
    assert.equal(item(result.resource, '/X-003').type, 'coding');
    assert.equal(item(result.resource, '/X-003').answerConstraint, 'optionsOnly');
    assert.equal(item(result.resource, '/X-010').type, 'coding');
    assert.equal(item(result.resource, '/X-010').answerConstraint, 'optionsOrString');
  });
});

