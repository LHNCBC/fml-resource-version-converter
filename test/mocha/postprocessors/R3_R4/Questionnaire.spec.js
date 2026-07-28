/**
 * Tests for the Questionnaire R3 <-> R4 conversions.
 *
 * R3 -> R4: the FML mapping covers the common cases but has known gaps for
 * enableWhen answer types STU3 has and R4 removed (uri, Attachment); the
 * Questionnaire_R3_to_R4 postprocessor drops those.
 *
 * R4 -> R3: the FML mapping has known gaps (malformed options, invalid enableWhen,
 * dropped initialSelected); the Questionnaire_R4_to_R3 postprocessor corrects it.
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { COVERAGE } from '../../../../src/converter/coverage.js';
import { MESSAGE_TYPE, STATUS } from '../../../../src/converter/diagnostics.js';
import { singleHopConverter } from '../../../../src/converter/singleHopConverter.js';
import { conv_R3_to_R4, conv_R4_to_R3 } from '../../../../src/postprocessors/R3_R4/Questionnaire.js';

const TEST_DATA = path.resolve(import.meta.dirname, '../../../data');
const r3Questionnaire = JSON.parse(
  fs.readFileSync(path.join(TEST_DATA, 'qn-ver-conv-test-stu3base.json'), 'utf-8'),
);
const r4Questionnaire = JSON.parse(
  fs.readFileSync(path.join(TEST_DATA, 'qn-ver-conv-test-r4base.json'), 'utf-8'),
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


describe('postprocessors/R3_R4 Questionnaire R3 -> R4', function () {
  let result;

  before(function () {
    result = singleHopConverter.convert(r3Questionnaire, 'R3', 'R4');
  });

  it('registers the postprocessor and reports FML known gaps + best-effort hop', function () {
    assert.equal(result.coverage, COVERAGE.BEST_EFFORT);
    assert.equal(result.fml_base_conv.coverage, COVERAGE.KNOWN_GAPS);
    assert.equal(result.postprocessors.length, 1);
    assert.equal(result.postprocessors[0].name, 'Questionnaire_R3_to_R4');
    assert.equal(result.postprocessors[0].coverage, COVERAGE.BEST_EFFORT);
  });

  it('rewrites meta.profile to the R4 base profile', function () {
    assert.ok(result.resource.meta.profile.includes(
      'http://hl7.org/fhir/4.0/StructureDefinition/Questionnaire',
    ));
  });

  it('converts STU3 enableWhen hasAnswer to operator:exists + answerBoolean', function () {
    const ew = item(result.resource, '/X-011').enableWhen[0];
    assert.equal(ew.operator, 'exists');
    assert.equal(ew.answerBoolean, true);
    assert.equal('hasAnswer' in ew, false);
    assert.equal('answer' in ew, false);   // not the malformed bare field
  });

  it('converts STU3 answer[x] enableWhen to operator:= ', function () {
    const ew = item(result.resource, '/X-002').enableWhen[0];
    assert.equal(ew.operator, '=');
    assert.equal(ew.answerString, 'ice cream');
  });

  it('converts option -> answerOption and options.reference -> answerValueSet', function () {
    assert.ok(Array.isArray(item(result.resource, '/X-003').answerOption));
    assert.equal('option' in item(result.resource, '/X-003'), false);
    assert.equal(
      item(result.resource, '/X-012').answerValueSet,
      'http://ocean-beach.com/ValueSet/beach',
    );
  });

  it('converts initial[x] to the R4 initial[] array', function () {
    assert.deepEqual(item(result.resource, '/X-002').initial, [{ valueString: 'Mint' }]);
    assert.equal('initialString' in item(result.resource, '/X-002'), false);
  });

  it('does not inject a conversion provenance meta.tag', function () {
    const inputTags = (r3Questionnaire.meta?.tag ?? []).length;
    const outputTags = (result.resource.meta?.tag ?? []).length;
    assert.equal(outputTags, inputTags);
  });

  // -------- direct unit coverage of the drop cases -------------------------
  describe('conv_R3_to_R4.execute (branch cases)', function () {
    /**
     * Run the postprocessor against a target/source pair.
     *
     * @param {Object} target FML-converted R4 target resource.
     * @param {Object} source STU3 source resource.
     * @returns {Object} The processor result.
     */
    function run(target, source) {
      return conv_R3_to_R4.execute(target, { sourceResource: source, fromVer: 'R3', toVer: 'R4' });
    }

    it('drops enableWhen answerUri (no R4 equivalent) with a warning', function () {
      const source = {
        resourceType: 'Questionnaire',
        item: [{
          linkId: 'a', type: 'string',
          enableWhen: [
            { question: 'q', answerUri: 'http://x' },
            { question: 'q', answerString: 'keep' },
          ],
        }],
      };
      const target = {
        resourceType: 'Questionnaire',
        item: [{
          linkId: 'a', type: 'string',
          enableWhen: [
            { question: 'q', operator: '=', answerUri: 'http://x' },
            { question: 'q', operator: '=', answerString: 'keep' },
          ],
        }],
      };
      const res = run(target, source);
      assert.deepEqual(res.resource.item[0].enableWhen, [
        { question: 'q', operator: '=', answerString: 'keep' },
      ]);
      assert.equal(res.status, STATUS.WARNING);
      assert.ok(res.messages.some(m => m.type === MESSAGE_TYPE.WARNING && /answerUri/.test(m.text)));
    });

    it('drops the malformed enableWhen answerAttachment entry with a warning', function () {
      const source = {
        resourceType: 'Questionnaire',
        item: [{
          linkId: 'a', type: 'string',
          enableWhen: [{ question: 'q', answerAttachment: { url: 'http://a' } }],
        }],
      };
      const target = {
        resourceType: 'Questionnaire',
        // FML leaves a malformed entry with only `question`.
        item: [{ linkId: 'a', type: 'string', enableWhen: [{ question: 'q' }] }],
      };
      const res = run(target, source);
      assert.equal('enableWhen' in res.resource.item[0], false);
      assert.equal(res.status, STATUS.WARNING);
      assert.ok(res.messages.some(m => m.type === MESSAGE_TYPE.WARNING && /answerAttachment/.test(m.text)));
    });

    it('leaves representable enableWhen untouched (no messages)', function () {
      const source = {
        resourceType: 'Questionnaire',
        item: [{ linkId: 'a', type: 'string', enableWhen: [{ question: 'q', answerString: 's' }] }],
      };
      const target = {
        resourceType: 'Questionnaire',
        item: [{ linkId: 'a', type: 'string', enableWhen: [{ question: 'q', operator: '=', answerString: 's' }] }],
      };
      const res = run(target, source);
      assert.deepEqual(res.resource.item[0].enableWhen, [
        { question: 'q', operator: '=', answerString: 's' },
      ]);
      assert.equal(res.status, STATUS.OK);
      assert.equal(res.messages.length, 0);
    });

    it('recurses into nested items', function () {
      const source = {
        resourceType: 'Questionnaire',
        item: [{
          linkId: 'g', type: 'group',
          item: [{ linkId: 'c', type: 'string', enableWhen: [{ question: 'q', answerUri: 'http://x' }] }],
        }],
      };
      const target = {
        resourceType: 'Questionnaire',
        item: [{
          linkId: 'g', type: 'group',
          item: [{ linkId: 'c', type: 'string', enableWhen: [{ question: 'q', operator: '=', answerUri: 'http://x' }] }],
        }],
      };
      const res = run(target, source);
      assert.equal('enableWhen' in res.resource.item[0].item[0], false);
    });

    it('adds enableBehavior "any" for multiple enableWhen (info, no data loss)', function () {
      const source = {
        resourceType: 'Questionnaire',
        item: [{
          linkId: 'a', type: 'string',
          enableWhen: [
            { question: 'q1', answerString: 's1' },
            { question: 'q2', answerString: 's2' },
          ],
        }],
      };
      const target = {
        resourceType: 'Questionnaire',
        item: [{
          linkId: 'a', type: 'string',
          enableWhen: [
            { question: 'q1', operator: '=', answerString: 's1' },
            { question: 'q2', operator: '=', answerString: 's2' },
          ],
        }],
      };
      const res = run(target, source);
      assert.equal(res.resource.item[0].enableBehavior, 'any');
      assert.equal(res.status, STATUS.OK);
      assert.ok(res.messages.some(m => m.type === MESSAGE_TYPE.INFO && /enableBehavior "any"/.test(m.text)));
    });

    it('does not add enableBehavior for a single enableWhen', function () {
      const source = {
        resourceType: 'Questionnaire',
        item: [{ linkId: 'a', type: 'string', enableWhen: [{ question: 'q', answerString: 's' }] }],
      };
      const target = {
        resourceType: 'Questionnaire',
        item: [{ linkId: 'a', type: 'string', enableWhen: [{ question: 'q', operator: '=', answerString: 's' }] }],
      };
      const res = run(target, source);
      assert.equal('enableBehavior' in res.resource.item[0], false);
      assert.equal(res.status, STATUS.OK);
      assert.equal(res.messages.length, 0);
    });

    it('does not add enableBehavior when filtering leaves a single condition', function () {
      const source = {
        resourceType: 'Questionnaire',
        item: [{
          linkId: 'a', type: 'string',
          enableWhen: [
            { question: 'q1', answerUri: 'http://x' },
            { question: 'q2', answerString: 'keep' },
          ],
        }],
      };
      const target = {
        resourceType: 'Questionnaire',
        item: [{
          linkId: 'a', type: 'string',
          enableWhen: [
            { question: 'q1', operator: '=', answerUri: 'http://x' },
            { question: 'q2', operator: '=', answerString: 'keep' },
          ],
        }],
      };
      const res = run(target, source);
      assert.deepEqual(res.resource.item[0].enableWhen, [
        { question: 'q2', operator: '=', answerString: 'keep' },
      ]);
      assert.equal('enableBehavior' in res.resource.item[0], false);
    });
  });
});


describe('postprocessors/R3_R4 Questionnaire R4 -> R3', function () {

  // -------- through the single-hop pipeline --------------------------------
  describe('via singleHopConverter.convert', function () {
    let result;

    before(function () {
      result = singleHopConverter.convert(r4Questionnaire, 'R4', 'R3');
    });

    it('registers the postprocessor and reports FML known gaps + best-effort hop', function () {
      assert.equal(result.coverage, COVERAGE.BEST_EFFORT);
      assert.equal(result.fml_base_conv.coverage, COVERAGE.KNOWN_GAPS);
      assert.equal(result.postprocessors.length, 1);
      assert.equal(result.postprocessors[0].name, 'Questionnaire_R4_to_R3');
      assert.equal(result.postprocessors[0].coverage, COVERAGE.BEST_EFFORT);
    });

    it('fixes options to the STU3 Reference shape', function () {
      assert.deepEqual(item(result.resource, '/X-012').options, {
        reference: 'http://ocean-beach.com/ValueSet/beach',
      });
    });

    it('keeps operator = enableWhen (operator stripped, answer kept)', function () {
      const ew = item(result.resource, '/X-002').enableWhen[0];
      assert.equal(ew.answerString, 'ice cream');
      assert.equal('operator' in ew, false);
      assert.equal('hasAnswer' in ew, false);
    });

    it('maps operator exists enableWhen to hasAnswer', function () {
      const ew = item(result.resource, '/X-011').enableWhen[0];
      assert.equal(ew.hasAnswer, true);
      assert.equal('operator' in ew, false);
      assert.equal('answerBoolean' in ew, false);
    });

    it('drops enableWhen whose operator has no STU3 equivalent', function () {
      assert.equal('enableWhen' in item(result.resource, '/X-006'), false);
    });

    it('re-derives initial[x] from answerOption.initialSelected', function () {
      assert.deepEqual(item(result.resource, '/X-003').initialCoding, {
        code: 'c',
        display: 'Green',
      });
    });

    it('warns about the dropped un-representable enableWhen on X-006', function () {
      assert.equal(result.status, STATUS.WARNING);
      const warnings = result.postprocessors[0].messages
        .filter(m => m.type === MESSAGE_TYPE.WARNING);
      assert.ok(warnings.some(m => /\/X-006/.test(m.text) && /no STU3 equivalent/.test(m.text)));
    });

    it('does not inject a conversion provenance meta.tag', function () {
      const inputTags = (r4Questionnaire.meta?.tag ?? []).length;
      const outputTags = (result.resource.meta?.tag ?? []).length;
      assert.equal(outputTags, inputTags);
    });
  });

  // -------- direct unit coverage of the branch cases -----------------------
  describe('conv_R4_to_R3.execute (branch cases)', function () {
    /**
     * Run the postprocessor against a target/source pair.
     *
     * @param {Object} target FML-converted target resource.
     * @param {Object} source R4 source resource.
     * @returns {Object} The processor result.
     */
    function run(target, source) {
      return conv_R4_to_R3.execute(target, { sourceResource: source, fromVer: 'R4', toVer: 'R3' });
    }

    it('maps answerValueSet to options.reference (info message)', function () {
      const source = {
        resourceType: 'Questionnaire',
        item: [{ linkId: 'a', type: 'choice', answerValueSet: 'vs' }],
      };
      const target = {
        resourceType: 'Questionnaire',
        item: [{ linkId: 'a', type: 'choice', options: 'vs' }],
      };
      const res = run(target, source);
      assert.deepEqual(res.resource.item[0].options, { reference: 'vs' });
      assert.equal('answerValueSet' in res.resource.item[0], false);
      assert.equal(res.status, STATUS.OK);
      assert.ok(res.messages.some(m => m.type === MESSAGE_TYPE.INFO && /options\.reference/.test(m.text)));
    });

    it('drops enableWhen with an un-representable operator (warning)', function () {
      const source = {
        resourceType: 'Questionnaire',
        item: [{ linkId: 'a', type: 'decimal', enableWhen: [{ question: 'q', operator: '>', answerDecimal: 10 }] }],
      };
      const target = {
        resourceType: 'Questionnaire',
        item: [{ linkId: 'a', type: 'decimal', enableWhen: [{ question: 'q' }] }],
      };
      const res = run(target, source);
      assert.equal('enableWhen' in res.resource.item[0], false);
      assert.equal(res.status, STATUS.WARNING);
      assert.ok(res.messages.some(m => m.type === MESSAGE_TYPE.WARNING && /operator/.test(m.text)));
    });

    it('moves _answerBoolean to _hasAnswer and discards _operator (warning)', function () {
      const source = {
        resourceType: 'Questionnaire',
        item: [{
          linkId: 'a', type: 'boolean',
          enableWhen: [{
            question: 'q', operator: 'exists', answerBoolean: true,
            _operator: { extension: [{ url: 'http://x', valueString: 'why' }] },
            _answerBoolean: { id: 'ab1' },
          }],
        }],
      };
      const target = {
        resourceType: 'Questionnaire',
        item: [{ linkId: 'a', type: 'boolean', enableWhen: [{ question: 'q' }] }],
      };
      const res = run(target, source);
      const ew = res.resource.item[0].enableWhen[0];

      assert.equal(ew.hasAnswer, true);
      assert.deepEqual(ew._hasAnswer, { id: 'ab1' });   // metadata relocated
      assert.equal('_answerBoolean' in ew, false);
      assert.equal('answerBoolean' in ew, false);
      assert.equal('operator' in ew, false);
      assert.equal('_operator' in ew, false);           // orphan removed

      assert.equal(res.status, STATUS.WARNING);
      assert.ok(res.messages.some(m => m.type === MESSAGE_TYPE.WARNING && /_operator/.test(m.text)));
    });

    it('discards _operator on "=" but keeps the answer primitive metadata', function () {
      const source = {
        resourceType: 'Questionnaire',
        item: [{
          linkId: 'a', type: 'string',
          enableWhen: [{
            question: 'q', operator: '=', answerString: 'x',
            _operator: { id: 'op1' },
            _answerString: { id: 'as1' },
          }],
        }],
      };
      const target = {
        resourceType: 'Questionnaire',
        item: [{ linkId: 'a', type: 'string', enableWhen: [{ question: 'q' }] }],
      };
      const res = run(target, source);
      const ew = res.resource.item[0].enableWhen[0];

      assert.equal(ew.answerString, 'x');
      assert.deepEqual(ew._answerString, { id: 'as1' }); // answer metadata kept
      assert.equal('operator' in ew, false);
      assert.equal('_operator' in ew, false);            // orphan removed

      assert.equal(res.status, STATUS.WARNING);
      assert.ok(res.messages.some(m => m.type === MESSAGE_TYPE.WARNING && /_operator/.test(m.text)));
    });

    it('does not warn when a removed operator has no _operator companion', function () {
      const source = {
        resourceType: 'Questionnaire',
        item: [{ linkId: 'a', type: 'string', enableWhen: [{ question: 'q', operator: '=', answerString: 'x' }] }],
      };
      const target = {
        resourceType: 'Questionnaire',
        item: [{ linkId: 'a', type: 'string', enableWhen: [{ question: 'q' }] }],
      };
      const res = run(target, source);
      assert.equal(res.resource.item[0].enableWhen[0].answerString, 'x');
      assert.equal(res.status, STATUS.OK);
      assert.ok(!res.messages.some(m => /_operator/.test(m.text)));
    });

    it('keeps the first initialSelected and warns about additional ones', function () {
      const source = {
        resourceType: 'Questionnaire',
        item: [{
          linkId: 'a', type: 'choice',
          answerOption: [
            { valueCoding: { code: 'c' }, initialSelected: true },
            { valueCoding: { code: 'o' }, initialSelected: true },
          ],
        }],
      };
      const target = {
        resourceType: 'Questionnaire',
        item: [{ linkId: 'a', type: 'choice', option: [{ valueCoding: { code: 'c' } }, { valueCoding: { code: 'o' } }] }],
      };
      const res = run(target, source);
      assert.deepEqual(res.resource.item[0].initialCoding, { code: 'c' });
      assert.equal(res.status, STATUS.WARNING);
      assert.ok(res.messages.some(m => m.type === MESSAGE_TYPE.WARNING && /additional answerOption\.initialSelected/.test(m.text)));
    });

    it('drops the empty option entry left for answerOption.valueReference (warning)', function () {
      const source = {
        resourceType: 'Questionnaire',
        item: [{
          linkId: 'a', type: 'choice',
          answerOption: [{ valueString: 'keep' }, { valueReference: { reference: 'Patient/1' } }],
        }],
      };
      const target = {
        resourceType: 'Questionnaire',
        // FML maps answerOption -> option 1:1; valueReference yields an empty {}.
        item: [{ linkId: 'a', type: 'choice', option: [{ valueString: 'keep' }, {}] }],
      };
      const res = run(target, source);
      assert.deepEqual(res.resource.item[0].option, [{ valueString: 'keep' }]);
      assert.equal(res.status, STATUS.WARNING);
      assert.ok(res.messages.some(m => m.type === MESSAGE_TYPE.WARNING && /valueReference/.test(m.text)));
    });

    it('deletes option entirely when every entry is unrepresentable', function () {
      const source = {
        resourceType: 'Questionnaire',
        item: [{ linkId: 'a', type: 'choice', answerOption: [{ valueReference: { reference: 'Patient/1' } }] }],
      };
      const target = {
        resourceType: 'Questionnaire',
        item: [{ linkId: 'a', type: 'choice', option: [{}] }],
      };
      const res = run(target, source);
      assert.equal('option' in res.resource.item[0], false);
      assert.equal(res.status, STATUS.WARNING);
    });

    it('reduces multiple initial values to the first and warns', function () {
      const source = {
        resourceType: 'Questionnaire',
        item: [{ linkId: 'a', type: 'string', initial: [{ valueString: 'first' }, { valueString: 'second' }] }],
      };
      const target = {
        resourceType: 'Questionnaire',
        // FML lets the last value win.
        item: [{ linkId: 'a', type: 'string', initialString: 'second' }],
      };
      const res = run(target, source);
      assert.equal(res.resource.item[0].initialString, 'first');
      assert.equal(res.status, STATUS.WARNING);
      assert.ok(res.messages.some(m => m.type === MESSAGE_TYPE.WARNING && /single initial value/.test(m.text)));
    });

    it('recurses into nested items', function () {
      const source = {
        resourceType: 'Questionnaire',
        item: [{
          linkId: 'g', type: 'group',
          item: [{ linkId: 'c', type: 'choice', answerValueSet: 'vs' }],
        }],
      };
      const target = {
        resourceType: 'Questionnaire',
        item: [{
          linkId: 'g', type: 'group',
          item: [{ linkId: 'c', type: 'choice', options: 'vs' }],
        }],
      };
      const res = run(target, source);
      assert.deepEqual(res.resource.item[0].item[0].options, { reference: 'vs' });
    });

    it('warns when R4 enableBehavior "all" cannot be represented in STU3', function () {
      const source = {
        resourceType: 'Questionnaire',
        item: [{
          linkId: 'a', type: 'string', enableBehavior: 'all',
          enableWhen: [
            { question: 'q1', operator: '=', answerString: 's1' },
            { question: 'q2', operator: '=', answerString: 's2' },
          ],
        }],
      };
      const target = {
        resourceType: 'Questionnaire',
        item: [{ linkId: 'a', type: 'string', enableWhen: [{ question: 'q1' }, { question: 'q2' }] }],
      };
      const res = run(target, source);
      assert.equal('enableBehavior' in res.resource.item[0], false);
      assert.equal(res.status, STATUS.WARNING);
      assert.ok(res.messages.some(m => m.type === MESSAGE_TYPE.WARNING && /enableBehavior "all"/.test(m.text)));
    });

    it('drops R4 enableBehavior "any" losslessly (info, status ok)', function () {
      const source = {
        resourceType: 'Questionnaire',
        item: [{
          linkId: 'a', type: 'string', enableBehavior: 'any',
          enableWhen: [
            { question: 'q1', operator: '=', answerString: 's1' },
            { question: 'q2', operator: '=', answerString: 's2' },
          ],
        }],
      };
      const target = {
        resourceType: 'Questionnaire',
        item: [{ linkId: 'a', type: 'string', enableWhen: [{ question: 'q1' }, { question: 'q2' }] }],
      };
      const res = run(target, source);
      assert.equal('enableBehavior' in res.resource.item[0], false);
      assert.equal(res.status, STATUS.OK);
      assert.ok(res.messages.some(m => m.type === MESSAGE_TYPE.INFO && /enableBehavior "any" dropped/.test(m.text)));
    });

    it('does not flag enableBehavior when only one condition remains after filtering', function () {
      const source = {
        resourceType: 'Questionnaire',
        item: [{
          linkId: 'a', type: 'string', enableBehavior: 'all',
          enableWhen: [
            { question: 'q1', operator: '=', answerString: 's1' },
            { question: 'q2', operator: '>', answerDecimal: 3 },
          ],
        }],
      };
      const target = {
        resourceType: 'Questionnaire',
        item: [{ linkId: 'a', type: 'string', enableWhen: [{ question: 'q1' }, { question: 'q2' }] }],
      };
      const res = run(target, source);
      // The '>' condition has no STU3 equivalent and is dropped, leaving one, so
      // enableBehavior is moot and must not be flagged.
      assert.deepEqual(res.resource.item[0].enableWhen, [{ question: 'q1', answerString: 's1' }]);
      assert.ok(!res.messages.some(m => /enableBehavior/.test(m.text)));
      assert.ok(res.messages.some(m => m.type === MESSAGE_TYPE.WARNING && /operator/.test(m.text)));
    });
  });
});


