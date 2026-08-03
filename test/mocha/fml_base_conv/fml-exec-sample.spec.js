/**
 * Execution smoke test: run targeted, non-skipping conversions with simple,
 * realistic resource payloads. This suite validates that known mappings execute
 * and that core fields survive conversion.
 */
import { strict as assert } from 'node:assert';
import { createFmlEngineFactory } from '../../../src/fml_base_conv/create_converter.js';
import { compileFmlXver } from '../../../src/fml_base_conv/fml_xver_engine.js';

const { createEngine } = createFmlEngineFactory();

/** @type {Array<{from: string, to: string}>} */
const DIRECTIONS = [
  { from: 'R2', to: 'R3' },
  { from: 'R3', to: 'R2' },
  { from: 'R3', to: 'R4' },
  { from: 'R4', to: 'R3' },
  { from: 'R4', to: 'R5' },
  { from: 'R5', to: 'R4' },
  { from: 'R4B', to: 'R5' },
  { from: 'R5', to: 'R4B' },
];

const UNKNOWN_TRANSFORM_WARNING = 'Unknown transform function';


/**
 * Return a simple but realistic Questionnaire for the source FHIR version.
 *
 * @param {string} version Source FHIR version label.
 * @returns {object}
 */
function makeQuestionnaireInput(version) {
  const statusByVersion = {
    R2: 'published',
    R3: 'active',
    R4: 'active',
    R4B: 'active',
    R5: 'active',
  };

  if (version === 'R2') {
    return {
      resourceType: 'Questionnaire',
      id: 'questionnaire-r2-smoke',
      status: statusByVersion.R2,
      date: '2024-01-01',
      group: {
        linkId: 'root',
        title: 'Root Group',
        required: false,
        repeats: false,
        question: [{
          linkId: 'q1',
          text: 'Favorite color?',
          type: 'choice',
          required: false,
        }],
      },
    };
  }

  // R3 needs a group-type item for R3->R2 mapping (which filters on type='group')
  if (version === 'R3') {
    return {
      resourceType: 'Questionnaire',
      id: 'questionnaire-r3-smoke',
      status: statusByVersion.R3,
      title: 'Questionnaire R3 smoke',
      item: [{
        linkId: 'root',
        text: 'Root Group',
        type: 'group',
        item: [{
          linkId: 'q1',
          text: 'Favorite color?',
          type: 'choice',
        }],
      }],
    };
  }

  const itemType = version === 'R5' ? 'coding' : 'choice';

  return {
    resourceType: 'Questionnaire',
    id: `questionnaire-${version.toLowerCase()}-smoke`,
    status: statusByVersion[version] ?? 'active',
    title: `Questionnaire ${version} smoke`,
    item: [{
      linkId: 'q1',
      text: 'Favorite color?',
      type: itemType,
      answerOption: [{ valueCoding: { code: 'blue', display: 'Blue' } }],
    }],
  };
}


/**
 * Return a simple but realistic Observation for the source FHIR version.
 *
 * @param {string} version Source FHIR version label.
 * @returns {object}
 */
function makeObservationInput(version) {
  return {
    resourceType: 'Observation',
    id: `observation-${version.toLowerCase()}-smoke`,
    status: 'final',
    code: {
      coding: [{
        system: 'http://loinc.org',
        code: '8310-5',
        display: 'Body temperature',
      }],
    },
    subject: { reference: 'Patient/example' },
    effectiveDateTime: '2024-01-01T10:00:00Z',
    valueString: 'normal',
  };
}


/**
 * Convert one resource with warning capture.
 *
 * @param {string} resourceType FHIR resource type.
 * @param {string} from Source FHIR version.
 * @param {string} to Target FHIR version.
 * @param {object} input Source resource input.
 * @returns {{ output: object, warnings: string[] }}
 */
function convertWithWarnings(resourceType, from, to, input) {
  const warnings = [];
  const engine = createEngine(resourceType, from, to, {
    onWarning: msg => warnings.push(msg),
  });

  const output = engine.convert({ input });
  return { output, warnings };
}


/**
 * Validate common output and fail on unknown transform warnings.
 *
 * @param {string[]} failures Failure accumulator.
 * @param {string} label Case label for failure reporting.
 * @param {object} output Converted resource.
 * @param {string[]} warnings Captured warnings.
 */
function validateCommon(failures, label, output, warnings) {
  if (!output || typeof output !== 'object') {
    failures.push(`${label}: output is not an object`);
    return;
  }

  if (!output.resourceType) {
    failures.push(`${label}: output missing resourceType`);
  }

  const fatal = warnings.find(w => w.includes(UNKNOWN_TRANSFORM_WARNING));
  if (fatal) {
    failures.push(`${label}: ${fatal}`);
  }
}


describe('FML exec: targeted conversions', function () {
  for (const { from, to } of DIRECTIONS) {
    it(`executes Questionnaire and Observation in ${from}->${to}`, function () {
      const failures = [];

      try {
        const questionnaireInput = makeQuestionnaireInput(from);
        const { output, warnings } = convertWithWarnings('Questionnaire', from, to, questionnaireInput);

        validateCommon(failures, `Questionnaire ${from}->${to}`, output, warnings);

        if (output?.resourceType !== 'Questionnaire') {
          failures.push(`Questionnaire ${from}->${to}: unexpected resourceType ${output?.resourceType}`);
        }

        if (!output?.status) {
          failures.push(`Questionnaire ${from}->${to}: output.status is missing`);
        }

        if (from === 'R2' && to === 'R3') {
          if (output?.status !== 'active') {
            failures.push(`Questionnaire ${from}->${to}: expected status active, got ${output?.status}`);
          }

          if (!output?.item) {
            failures.push(`Questionnaire ${from}->${to}: output.item is missing`);
          }
        } else if (from === 'R3' && to === 'R2') {
          if (output?.status !== 'published') {
            failures.push(`Questionnaire ${from}->${to}: expected status published, got ${output?.status}`);
          }

          if (!output?.group || typeof output.group !== 'object') {
            failures.push(`Questionnaire ${from}->${to}: output.group is missing (R2 uses group, not item)`);
          }
        } else if (!Array.isArray(output?.item) || output.item.length === 0) {
          failures.push(`Questionnaire ${from}->${to}: output.item is empty`);
        }

        if (to === 'R5' && output?.item?.[0]?.type !== 'coding') {
          failures.push(`Questionnaire ${from}->${to}: expected first item.type to be coding, got ${output?.item?.[0]?.type}`);
        }
      } catch (e) {
        failures.push(`Questionnaire ${from}->${to}: ${e.message}`);
      }

      try {
        const observationInput = makeObservationInput(from);
        const { output, warnings } = convertWithWarnings('Observation', from, to, observationInput);

        validateCommon(failures, `Observation ${from}->${to}`, output, warnings);

        if (output?.resourceType !== 'Observation') {
          failures.push(`Observation ${from}->${to}: unexpected resourceType ${output?.resourceType}`);
        }

        if (!output?.status) {
          failures.push(`Observation ${from}->${to}: output.status is missing`);
        }

        if (!output?.code) {
          failures.push(`Observation ${from}->${to}: output.code is missing`);
        }
      } catch (e) {
        failures.push(`Observation ${from}->${to}: ${e.message}`);
      }

      assert.deepEqual(
        failures,
        [],
        `${failures.length} conversion(s) failed in ${from}->${to}:\n  ${failures.join('\n  ')}`,
      );
    });
  }
});

describe('fml_base_conv: STU3->R4 polymorphic initial conversion', () => {
  it('converts initialString to initial[{valueString}] array form', function () {
    const engine = createEngine('Questionnaire', 'R3', 'R4');
    const input = {
      resourceType: 'Questionnaire',
      status: 'draft',
      item: [{
        linkId: '/test',
        type: 'string',
        initialString: 'Mint',
      }],
    };
    const output = engine.convert({ input });
    assert.ok(Array.isArray(output.item), 'item should be an array');
    const item = output.item[0];
    assert.ok(Array.isArray(item.initial), 'item.initial should be an array');
    assert.equal(item.initial.length, 1);
    assert.equal(item.initial[0].valueString, 'Mint');
  });
});


/**
 * Compile a raw FML string and run one conversion, capturing warnings.
 *
 * Uses compileFmlXver directly (no version-specific mapping files) so a tiny,
 * self-contained group can exercise engine features in isolation.
 *
 * @param {string} fmlText FML mapping source.
 * @param {object} input Source resource (its resourceType names the entry group).
 * @returns {{ output: object, warnings: string[] }}
 */
function runRawFml(fmlText, input) {
  const warnings = [];
  const engine = compileFmlXver({ fmlText, onWarning: msg => warnings.push(msg) });
  const output = engine.convert({ input });
  return { output, warnings };
}

describe('fml_base_conv: source list mode only_one', function () {
  // A single-rule group that copies a repeating source field to the target.
  const groupWith = clause =>
    `group TestRes(source src, target tgt) {\n  src.tag ${clause} -> tgt.picked = vs;\n}`;

  it('collapses a multi-item source to the first item and warns', function () {
    const { output, warnings } = runRawFml(
      groupWith('only_one as vs'),
      { resourceType: 'TestRes', tag: ['a', 'b', 'c'] },
    );

    // only_one keeps exactly the first item.
    assert.deepEqual(output.picked, ['a']);

    // Exactly one warning, naming the mode, the source path, and the count.
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /only_one/);
    assert.match(warnings[0], /src\.tag/);
    assert.match(warnings[0], /3 items/);
  });

  it('passes a single-item source through without warning', function () {
    const { output, warnings } = runRawFml(
      groupWith('only_one as vs'),
      { resourceType: 'TestRes', tag: ['a'] },
    );

    assert.deepEqual(output.picked, ['a']);
    assert.equal(warnings.length, 0);
  });

  it('without only_one, all items pass through (guards against regression)', function () {
    const { output, warnings } = runRawFml(
      groupWith('as vs'),
      { resourceType: 'TestRes', tag: ['a', 'b', 'c'] },
    );

    // Contrast case: the plain alias keeps every item. This is what only_one
    // must narrow, and documents why the only_one handling is needed.
    assert.deepEqual(output.picked, ['a', 'b', 'c']);
    assert.equal(warnings.length, 0);
  });
});


