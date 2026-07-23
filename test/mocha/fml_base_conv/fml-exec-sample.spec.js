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


describe('fml_base_conv: multi-target then-rule (intermediate target binding)', function () {
  // A helper group that copies `text` from source to target; used as the
  // `then` group so we can observe whether the intermediate alias was bound.
  const FILL = 'group Fill(source src, target tgt) {\n  src.text -> tgt.text;\n}';

  it('binds an intermediate target alias so the then-group fills it (scalar)', function () {
    const fml = [
      'group TestRes(source src, target tgt) {',
      '  src.item as s -> tgt.wrap as t, t.inner as tc then Fill(s, tc);',
      '}',
      FILL,
    ].join('\n');

    const { output, warnings } = runRawFml(fml, {
      resourceType: 'TestRes',
      item: { text: 'hello' },
    });

    // Before the fix `t.inner as tc` was ignored: `tc` was unbound, Fill ran
    // on `undefined`, and `tgt.wrap.inner` never received the value.
    assert.equal(output?.wrap?.inner?.text, 'hello');

    // No "not in scope" warnings (the old bug signature).
    assert.deepEqual(warnings.filter(w => /not in scope/.test(w)), []);
  });

  it('binds intermediate aliases per item (array context)', function () {
    const fml = [
      'group TestRes(source src, target tgt) {',
      '  src.items as s -> tgt.out as t, t.inner as tc then Fill(s, tc);',
      '}',
      FILL,
    ].join('\n');

    const { output, warnings } = runRawFml(fml, {
      resourceType: 'TestRes',
      items: [{ text: 'a' }, { text: 'b' }],
    });

    assert.ok(Array.isArray(output.out), 'out should be an array');
    assert.equal(output.out.length, 2);
    assert.equal(output.out[0].inner.text, 'a');
    assert.equal(output.out[1].inner.text, 'b');
    assert.deepEqual(warnings.filter(w => /not in scope/.test(w)), []);
  });

  it('binds a bare-transform intermediate alias (create ... as v)', function () {
    // Mirrors the R2->R3 StructureDefinition idiom:
    //   ... -> tgt.a as t, create('boolean') as flag, flag.value = 'true'
    //          then Fill3(s, t, flag);
    const fml = [
      'group TestRes(source src, target tgt) {',
      "  src.item as s -> tgt.a as t, create('boolean') as flag, flag.value = 'true' then Fill3(s, t, flag);",
      '}',
      'group Fill3(source src, target tgt, source flag) {',
      '  src.text -> tgt.text;',
      '  flag.value as fv -> tgt.flagged = fv;',
      '}',
    ].join('\n');

    const { output, warnings } = runRawFml(fml, {
      resourceType: 'TestRes',
      item: { text: 'x' },
    });

    assert.equal(output?.a?.text, 'x');
    assert.equal(output?.a?.flagged, 'true');
    assert.deepEqual(warnings.filter(w => /not in scope/.test(w)), []);
  });

  it('binds a parenthesized FHIRPath intermediate target (expr) as v', function () {
    // Mirrors the R3->R2 ValueSet idiom:
    //   ... -> vst.codeSystem as vt, (vs.system.resolve()) as cs
    //          then codeSystem(cs, vt);
    const fml = [
      'group TestRes(source src, target tgt) {',
      '  src.item as s -> tgt.a as t, (s.code) as cs then Fill2(cs, t);',
      '}',
      'group Fill2(source src, target tgt) {',
      '  src.value as v -> tgt.picked = v;',
      '}',
    ].join('\n');

    const { output, warnings } = runRawFml(fml, {
      resourceType: 'TestRes',
      item: { code: 'C' },
    });

    // `cs` is the FHIRPath result 'C'; Fill2 receives it and copies it.
    assert.equal(output?.a?.picked, 'C');
    assert.deepEqual(warnings.filter(w => /not in scope/.test(w)), []);
  });
});


describe('fml_base_conv: target list mode parsing', function () {
  it('parses a target list mode without mis-consuming the next target', function () {
    // `tgt.x as t first, tgt.y = ...`: the `first` keyword must be consumed
    // as a target list mode, not left to terminate the target list (which
    // previously caused the remainder of the rule to be mis-parsed).
    const fml = [
      'group TestRes(source src, target tgt) {',
      '  src.a as s -> tgt.x as t first, tgt.y = s;',
      '}',
    ].join('\n');

    const { output, warnings } = runRawFml(fml, {
      resourceType: 'TestRes',
      a: 'v',
    });

    // The second target still executes (was dropped by the old mis-parse).
    assert.equal(output.y, 'v');
    // `first` on a non-then target is recognised but not applied (warned).
    assert.ok(warnings.some(w => /list mode "first"/.test(w)));
  });
});


describe('fml_base_conv: unsupported top-level constructs warn cleanly', function () {
  it('emits one clear warning for `let` and skips it (rest still runs)', function () {
    const fml = [
      'let base = src.url;',
      'group TestRes(source src, target tgt) {',
      '  src.a -> tgt.b;',
      '}',
    ].join('\n');

    const { output, warnings } = runRawFml(fml, { resourceType: 'TestRes', a: 'x' });

    // The following group still parses and runs.
    assert.equal(output.b, 'x');
    // Exactly one clear "not yet supported" message; no token-by-token noise.
    assert.equal(warnings.filter(w => /'let' constants are not yet supported/.test(w)).length, 1);
    assert.deepEqual(warnings.filter(w => /unexpected token/.test(w)), []);
  });

  it('emits one clear warning for inline `conceptmap` and skips the block', function () {
    const fml = [
      'conceptmap "http://x" {',
      '  prefix s = "http://sys"',
      '  s:foo == t:bar',
      '}',
      'group TestRes(source src, target tgt) {',
      '  src.a -> tgt.b;',
      '}',
    ].join('\n');

    const { output, warnings } = runRawFml(fml, { resourceType: 'TestRes', a: 'x' });

    assert.equal(output.b, 'x');
    assert.equal(warnings.filter(w => /inline 'conceptmap' is not yet supported/.test(w)).length, 1);
    assert.deepEqual(warnings.filter(w => /unexpected token/.test(w)), []);
  });
});


describe('fml_base_conv: datatype-internal array wrapping', function () {
  it('wraps a datatype-internal array field via datatype re-rooting', function () {
    // Mirrors R4B->R5 Encounter.class: build a CodeableConcept and fill its
    // `coding`, which is 0..* on the CodeableConcept datatype. The engine
    // composes the resource-rooted path `TestRes.field.coding`, which is not
    // in arrayPaths; it must re-root at the datatype boundary
    // (`TestRes.field` -> CodeableConcept) to find `CodeableConcept.coding`.
    const fml = [
      'group TestRes(source src, target tgt) {',
      "  src.c as s -> tgt.field = create('CodeableConcept') as t, t.coding as tc then FillCoding(s, tc);",
      '}',
      'group FillCoding(source src, target tgt) {',
      '  src.code -> tgt.code;',
      '}',
    ].join('\n');

    const tgtDefs = {
      arrayPaths: ['CodeableConcept.coding'],
      elementTypes: { 'TestRes.field': 'CodeableConcept' },
    };
    const engine = compileFmlXver({ fmlText: fml, tgtDefs });
    const output = engine.convert({ input: { resourceType: 'TestRes', c: { code: 'x' } } });

    // `coding` is wrapped as an array; the scalar `code` inside stays scalar.
    assert.ok(Array.isArray(output.field.coding), 'field.coding should be an array');
    assert.equal(output.field.coding.length, 1);
    assert.equal(output.field.coding[0].code, 'x');
  });
});


describe('fml_base_conv: create() resourceType handling', function () {
  const fml = [
    'group TestRes(source src, target tgt) {',
    "  src.a -> tgt.dt = create('CodeableConcept');",
    "  src.b -> tgt.res = create('CareTeam');",
    "  src.c -> tgt.prim = create('boolean');",
    '}',
  ].join('\n');

  it('omits resourceType for datatypes and primitives, keeps it for resources', function () {
    // Resource classification is read from the FHIR defs (resourceTypes);
    // pass a minimal tgtDefs so CareTeam is recognised as a resource.
    const engine = compileFmlXver({ fmlText: fml, tgtDefs: { resourceTypes: ['CareTeam'] } });
    const output = engine.convert({ input: { resourceType: 'TestRes', a: 1, b: 1, c: 1 } });

    // Datatype and primitive: bare object, no resourceType.
    assert.deepEqual(output.dt, {});
    assert.deepEqual(output.prim, {});
    // Resource: carries resourceType.
    assert.deepEqual(output.res, { resourceType: 'CareTeam' });
  });
});


describe('fml_base_conv: log clause and backtick identifiers', function () {
  it('parses a source `log (...)` clause without disrupting the rule', function () {
    const fml = [
      'group TestRes(source src, target tgt) {',
      '  src.a as s log (s) -> tgt.b = s;',
      '}',
    ].join('\n');

    const { output, warnings } = runRawFml(fml, {
      resourceType: 'TestRes',
      a: 'v',
    });

    // The rule still runs: the log clause is parsed and ignored.
    assert.equal(output.b, 'v');
    assert.deepEqual(warnings, []);
  });

  it('tokenises a backtick-delimited identifier in a bare path', function () {
    // `div` is a FHIRPath reserved word; backticks quote it as a field name.
    const fml = [
      'group TestRes(source src, target tgt) {',
      '  src.`div` -> tgt.out;',
      '}',
    ].join('\n');

    const { output, warnings } = runRawFml(fml, {
      resourceType: 'TestRes',
      div: 'hello',
    });

    assert.equal(output.out, 'hello');
    // No "unrecognised character" tokenizer warning.
    assert.deepEqual(warnings, []);
  });

  it('emits a source `log (...)` value via onInfo', function () {
    const fml = [
      'group TestRes(source src, target tgt) {',
      '  src.a as s log (s) -> tgt.b = s;',
      '}',
    ].join('\n');

    const infos = [];
    const engine = compileFmlXver({ fmlText: fml, onInfo: m => infos.push(m) });
    engine.convert({ input: { resourceType: 'TestRes', a: 'v' } });

    // The log clause value is surfaced as an info-level diagnostic.
    assert.ok(infos.some(m => /^log: v$/.test(m)), `infos: ${JSON.stringify(infos)}`);
  });

  it('accepts an unparenthesized string literal in log', function () {
    const fml = [
      'group TestRes(source src, target tgt) {',
      "  src.a as s log 'processing item' -> tgt.b = s;",
      '}',
    ].join('\n');

    const infos = [];
    const warnings = [];
    const engine = compileFmlXver({
      fmlText: fml,
      onInfo: m => infos.push(m),
      onWarning: m => warnings.push(m),
    });
    const output = engine.convert({ input: { resourceType: 'TestRes', a: 'v' } });

    // Parses (no throw), the rule runs, and the literal is logged.
    assert.equal(output.b, 'v');
    assert.ok(infos.some(m => /^log: processing item$/.test(m)), `infos: ${JSON.stringify(infos)}`);
    assert.deepEqual(warnings, []);
  });
});


describe('fml_base_conv: target list mode single', function () {
  it('collapses a multi-item source to one target element and warns', function () {
    const fml = [
      'group TestRes(source src, target tgt) {',
      '  src.items as s -> tgt.out as t single then Fill(s, t);',
      '}',
      'group Fill(source src, target tgt) {',
      '  src.text -> tgt.text;',
      '}',
    ].join('\n');

    const { output, warnings } = runRawFml(fml, {
      resourceType: 'TestRes',
      items: [{ text: 'A' }, { text: 'B' }],
    });

    // Only the first item becomes a target element.
    assert.equal(output.out.length, 1);
    assert.equal(output.out[0].text, 'A');
    // The count violation is reported...
    assert.ok(warnings.some(w => /"single"/.test(w) && /2/.test(w)));
    // ...but not the generic "not yet applied" diagnostic (single is applied).
    assert.deepEqual(warnings.filter(w => /not yet applied/.test(w)), []);
  });

  it('passes a single-item source through without warning', function () {
    const fml = [
      'group TestRes(source src, target tgt) {',
      '  src.items as s -> tgt.out as t single then Fill(s, t);',
      '}',
      'group Fill(source src, target tgt) {',
      '  src.text -> tgt.text;',
      '}',
    ].join('\n');

    const { output, warnings } = runRawFml(fml, {
      resourceType: 'TestRes',
      items: [{ text: 'A' }],
    });

    assert.equal(output.out.length, 1);
    assert.equal(output.out[0].text, 'A');
    assert.deepEqual(warnings, []);
  });
});


describe('fml_base_conv: target list mode first/last reuse', function () {
  it('merges every item into the first existing list element (first)', function () {
    // Mirrors R3->R2 HealthcareService: one rule builds `list` entries, a
    // second rule (`first`) merges into the first existing entry rather than
    // appending new ones.
    const fml = [
      'group TestRes(source src, target tgt) {',
      '  src.a as s -> tgt.list as t, t.x as v then Fill(s, v);',
      '  src.b as s -> tgt.list as t first, t.y as v then Fill(s, v);',
      '}',
      'group Fill(source src, target tgt) {',
      '  src.text -> tgt.text;',
      '}',
    ].join('\n');

    const { output, warnings } = runRawFml(fml, {
      resourceType: 'TestRes',
      a: [{ text: 'A1' }, { text: 'A2' }],
      b: [{ text: 'B1' }, { text: 'B2' }],
    });

    // No new elements appended by the `first` rule: still 2 entries.
    assert.equal(output.list.length, 2);
    // First entry gains `y` from both `b` items; second is untouched.
    assert.equal(output.list[0].x.text, 'A1');
    assert.equal(output.list[0].y.text, 'B2'); // last write wins into shared slot
    assert.equal(output.list[1].x.text, 'A2');
    assert.ok(output.list[1].y === undefined);
    // first-mode reuse is implemented, so no unhandled-list-mode warning.
    assert.deepEqual(warnings.filter(w => /list mode/.test(w)), []);
  });
});

