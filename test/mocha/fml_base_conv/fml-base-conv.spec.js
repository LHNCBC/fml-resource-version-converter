/**
 * Tests for the fml_base_conv module: engine factory, single-hop conversion,
 * hop-math (planHops), meta.profile handling, and ConceptMap translation.
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createFmlEngineFactory, planHops } from '../../../src/fml_base_conv/create_converter.js';
import { compileFmlXver } from '../../../src/fml_base_conv/fml_xver_engine.js';

const { createEngine } = createFmlEngineFactory();

const TEST_DATA = path.resolve(import.meta.dirname, '../../data');
const r4Questionnaire = JSON.parse(fs.readFileSync(path.join(TEST_DATA, 'qn-ver-conv-test-r4base.json'), 'utf-8'));

// ---------- createFmlEngineFactory / createEngine --------------------------

describe('fml_base_conv/createEngine', function () {
  it('creates an engine for Questionnaire R4->R5', function () {
    const engine = createEngine('Questionnaire', 'R4', 'R5');
    assert.equal(typeof engine.convert, 'function', 'engine should expose convert()');
  });

  it('creates an engine for Questionnaire R4B->R5', function () {
    const engine = createEngine('Questionnaire', 'R4B', 'R5');
    assert.ok(engine.convert);
  });

  it('creates an engine for Questionnaire R5->R4', function () {
    const engine = createEngine('Questionnaire', 'R5', 'R4');
    assert.ok(engine.convert);
  });

  it('reports mapping availability via hasMapping', function () {
    const factory = createFmlEngineFactory();
    assert.equal(factory.hasMapping('Questionnaire', 'R4', 'R5'), true);
    assert.equal(factory.hasMapping('NoSuchResource', 'R4', 'R5'), false);
  });

  it('throws for unknown resource type', function () {
    assert.throws(() => createEngine('NoSuchResource', 'R4', 'R5'), /FML file not found/);
  });

  it('throws for unknown FHIR version', function () {
    assert.throws(() => createEngine('Questionnaire', 'R4', 'R99'), /not found|Unknown/);
  });
});

// ---------- ConceptMap path resolution -------------------------------------

describe('fml_base_conv: ConceptMap path resolution', function () {
  // The data-type / resource-type ConceptMaps referenced by translate() live in
  // types/ and resources/, not codes/; the resolver routes by id prefix. This
  // guards that such a map resolves (no "not found" warning) and translates.
  it('resolves a types-* ConceptMap referenced by translate() (OperationDefinition R4->R5)', function () {
    const input = {
      resourceType: 'OperationDefinition', name: 'Test', status: 'active',
      kind: 'operation', code: 'test', system: false, type: false, instance: true,
      parameter: [{ name: 'subject', use: 'in', min: 1, max: '1', type: 'Reference' }],
    };
    const warnings = [];
    const engine = createEngine('OperationDefinition', 'R4', 'R5', { onWarning: m => warnings.push(m) });
    const output = engine.convert({ input });

    assert.equal(output.parameter[0].type, 'Reference');
    const typeMapNotFound = warnings.filter(
      w => /not found/.test(w) && /ConceptMap-(types|resources)-/.test(w),
    );
    assert.equal(typeMapNotFound.length, 0, 'types-/resources- ConceptMaps should resolve');
  });
});

// ---------- Basic conversion R4->R5 -----------------------------------------

describe('fml_base_conv: Questionnaire R4->R5 conversion', function () {
  let engine;
  let output;
  const warnings = [];

  before(function () {
    engine = createEngine('Questionnaire', 'R4', 'R5', {
      onWarning: msg => warnings.push(msg),
    });
    output = engine.convert({ input: r4Questionnaire });
  });

  it('preserves resourceType', function () {
    assert.equal(output.resourceType, 'Questionnaire');
  });

  it('copies top-level fields', function () {
    assert.equal(output.id, 'qn-ver-conv-test-r4base');
    assert.equal(output.url, r4Questionnaire.url);
    assert.equal(output.status, 'draft');
    assert.equal(output.title, 'Demo form');
    // Questionnaire.derivedFrom is 0..* in R4 and R5. The test input
    // carries a (malformed) scalar value; the engine normalises to an
    // array per R5 cardinality.
    assert.deepEqual(output.derivedFrom, [r4Questionnaire.derivedFrom]);
  });

  it('copies DomainResource base fields (id, meta, extension)', function () {
    assert.ok(output.id);
    assert.ok(output.meta);
  });

  it('converts item array', function () {
    assert.ok(Array.isArray(output.item));
    assert.equal(output.item.length, r4Questionnaire.item.length);
  });

  it('preserves item.linkId and item.text', function () {
    assert.equal(output.item[0].linkId, '/X-001');
    assert.equal(output.item[0].text, 'Favorite dessert (try ice cream)');
  });

  it('translates item.type "choice" to "coding"', function () {
    const choiceItem = output.item.find(i => i.linkId === '/X-003');
    assert.equal(choiceItem.type, 'coding');
  });

  it('sets answerConstraint for choice items', function () {
    const choiceItem = output.item.find(i => i.linkId === '/X-003');
    assert.equal(choiceItem.answerConstraint, 'optionsOnly');
  });

  it('translates item.type "open-choice" to "coding"', function () {
    const ocItem = output.item.find(i => i.linkId === '/X-010');
    assert.equal(ocItem.type, 'coding');
  });

  it('sets answerConstraint for open-choice items', function () {
    const ocItem = output.item.find(i => i.linkId === '/X-010');
    assert.equal(ocItem.answerConstraint, 'optionsOrString');
  });

  it('preserves enableWhen with polymorphic answer fields', function () {
    const item = output.item.find(i => i.linkId === '/X-002');
    assert.ok(item.enableWhen);
    assert.equal(item.enableWhen[0].answerString, 'ice cream');
    assert.equal(item.enableWhen[0].operator, '=');
  });

  it('preserves enableWhen with answerCoding', function () {
    const item = output.item.find(i => i.linkId === '/X-004');
    assert.deepEqual(item.enableWhen[0].answerCoding, { code: 'c' });
  });

  it('preserves enableWhen with answerDecimal', function () {
    const item = output.item.find(i => i.linkId === '/X-006');
    assert.equal(item.enableWhen[0].answerDecimal, 10);
  });

  it('preserves initial values', function () {
    const item = output.item.find(i => i.linkId === '/X-002');
    assert.deepEqual(item.initial, [{ valueString: 'Mint' }]);
  });

  it('preserves answerOption with valueCoding', function () {
    const item = output.item.find(i => i.linkId === '/X-003');
    assert.ok(item.answerOption);
    assert.equal(item.answerOption[0].valueCoding.display, 'Green');
  });

  it('preserves answerValueSet', function () {
    const item = output.item.find(i => i.linkId === '/X-012');
    assert.equal(item.answerValueSet, 'http://ocean-beach.com/ValueSet/beach');
  });

  it('preserves meta.tag', function () {
    assert.ok(output.meta.tag);
    assert.equal(output.meta.tag[0].code, 'born-r4');
  });
});

// ---------- meta.profile update --------------------------------------------

describe('fml_base_conv: meta.profile handling', function () {
  it('updates standard R4 profile to R5', function () {
    const engine = createEngine('Questionnaire', 'R4', 'R5');
    const out = engine.convert({ input: r4Questionnaire });
    assert.ok(out.meta.profile.includes('http://hl7.org/fhir/5.0/StructureDefinition/Questionnaire'));
    assert.ok(!out.meta.profile.includes('http://hl7.org/fhir/4.0/StructureDefinition/Questionnaire'));
  });

  it('adds target profile when source has no profile', function () {
    const input = { resourceType: 'Questionnaire', status: 'draft' };
    const engine = createEngine('Questionnaire', 'R4', 'R5');
    const out = engine.convert({ input });
    assert.deepEqual(out.meta.profile, ['http://hl7.org/fhir/5.0/StructureDefinition/Questionnaire']);
  });

  it('preserves non-standard profiles', function () {
    const input = {
      ...r4Questionnaire,
      meta: {
        ...r4Questionnaire.meta,
        profile: [
          'http://hl7.org/fhir/4.0/StructureDefinition/Questionnaire',
          'http://myorg.com/fhir/StructureDefinition/CustomQuestionnaire',
        ],
      },
    };
    const engine = createEngine('Questionnaire', 'R4', 'R5');
    const out = engine.convert({ input });
    assert.ok(out.meta.profile.includes('http://myorg.com/fhir/StructureDefinition/CustomQuestionnaire'));
    assert.ok(out.meta.profile.includes('http://hl7.org/fhir/5.0/StructureDefinition/Questionnaire'));
    assert.ok(!out.meta.profile.includes('http://hl7.org/fhir/4.0/StructureDefinition/Questionnaire'));
  });
});

// ---------- planHops (version-graph hop-math) ------------------------------
// Multi-hop chaining now lives in the integration layer; the engine module
// only provides the pure hop-math. End-to-end chained conversion tests will
// be added with the integration layer.

describe('fml_base_conv/planHops', function () {
  it('throws for same source and target version', function () {
    assert.throws(() => planHops('R4', 'R4'), /source and target versions are the same/);
  });

  it('adjacent versions yield a single hop', function () {
    assert.deepEqual(planHops('R4', 'R5'), [['R4', 'R5']]);
  });

  it('R3->R5 routes through R4', function () {
    assert.deepEqual(planHops('R3', 'R5'), [['R3', 'R4'], ['R4', 'R5']]);
  });

  it('keeps R4B for direct R4B<->R5 conversions', function () {
    assert.deepEqual(planHops('R4B', 'R5'), [['R4B', 'R5']]);
    assert.deepEqual(planHops('R5', 'R4B'), [['R5', 'R4B']]);
  });

  it('throws for R4<->R4B (near-equivalent, no conversion between them)', function () {
    assert.throws(() => planHops('R4', 'R4B'), /no conversion between them/);
    assert.throws(() => planHops('R4B', 'R4'), /no conversion between them/);
  });

  it('throws for R4B paired with R2 or R3 (unsupported)', function () {
    assert.throws(() => planHops('R3', 'R4B'), /Unsupported conversion/);
    assert.throws(() => planHops('R4B', 'R3'), /Unsupported conversion/);
    assert.throws(() => planHops('R2', 'R4B'), /Unsupported conversion/);
  });

  it('throws on unknown version', function () {
    assert.throws(() => planHops('R4', 'R99'), /Unknown FHIR version/);
  });
});

// ---------- compileFmlXver directly ----------------------------------------

describe('fml_base_conv/compileFmlXver', function () {
  it('compiles minimal FML text', function () {
    const fml = `
/// url = "http://test/Map1"
/// name = "Test1"

group Test(source src, target tgt) extends DomainResource {
  src.name -> tgt.name;
}
`;
    const engine = compileFmlXver({ fmlText: fml });
    assert.ok(engine.convert);
    assert.ok(engine.groups.includes('Test'));
    assert.equal(engine.metadata.name, 'Test1');
  });

  it('handles translate with ConceptMap', function () {
    const fml = `
/// url = "http://test/Map2"
/// name = "Test2"

group Test(source src, target tgt) extends DomainResource {
  src.status as v -> tgt.status = translate(v, 'http://test/cm1', 'code');
}
`;
    const cm = {
      url: 'http://test/cm1',
      group: [{
        element: [{
          code: 'active',
          target: [{ code: 'final', relationship: 'equivalent' }],
        }],
      }],
    };
    const engine = compileFmlXver({ fmlText: fml, conceptMaps: [cm] });
    const out = engine.convert({ input: { resourceType: 'Test', status: 'active' } });
    assert.equal(out.status, 'final');
  });

  it('copies polymorphic fields', function () {
    const fml = `
/// url = "http://test/Map3"
/// name = "Test3"

group Test(source src, target tgt) extends DomainResource {
  src.item as s -> tgt.item as t then Item(s, t);
}

group Item(source src, target tgt) extends BackboneElement {
  src.value : boolean -> tgt.value "valueBoolean";
  src.value : string -> tgt.value "valueString";
}
`;
    const engine = compileFmlXver({ fmlText: fml });
    const out = engine.convert({
      input: { resourceType: 'Test', item: [{ valueBoolean: true }, { valueString: 'hello' }] },
    });
    assert.equal(out.item[0].valueBoolean, true);
    assert.equal(out.item[1].valueString, 'hello');
  });
});



