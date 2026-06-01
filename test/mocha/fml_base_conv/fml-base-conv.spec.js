/**
 * Tests for the fml_base_conv module: engine compilation, single-hop
 * conversion, chained conversion, meta.profile handling, and ConceptMap
 * translation.
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createFmlEngine, createConverter, createChainedConverter } from '../../../src/fml_base_conv/create_converter.js';
import { compileFmlXver } from '../../../src/fml_base_conv/fml_xver_engine.js';

const TEST_DATA = path.resolve(import.meta.dirname, '../../data');
const r4Questionnaire = JSON.parse(fs.readFileSync(path.join(TEST_DATA, 'qn-ver-conv-test-r4base.json'), 'utf-8'));
const stu3Questionnaire = JSON.parse(fs.readFileSync(path.join(TEST_DATA, 'qn-ver-conv-test-stu3base.json'), 'utf-8'));

// ---------- createChainedConverter ---------------------------------------------------

describe('fml_base_conv/createFmlEngine', function () {
  it('creates an engine for Questionnaire R4->R5', function () {
    const engine = createFmlEngine('Questionnaire', 'R4', 'R5');
    assert.ok(engine.convert, 'engine should have a convert function');
    assert.ok(Array.isArray(engine.groups), 'engine should expose groups');
    assert.ok(engine.groups.includes('Questionnaire'));
  });

  it('creates an engine for Questionnaire R4B->R5', function () {
    const engine = createFmlEngine('Questionnaire', 'R4B', 'R5');
    assert.ok(engine.convert);
  });

  it('creates an engine for Questionnaire R5->R4', function () {
    const engine = createFmlEngine('Questionnaire', 'R5', 'R4');
    assert.ok(engine.convert);
  });

  it('throws for unknown resource type', function () {
    assert.throws(() => createFmlEngine('NoSuchResource', 'R4', 'R5'), /FML file not found/);
  });

  it('throws for unknown FHIR version', function () {
    assert.throws(() => createFmlEngine('Questionnaire', 'R4', 'R99'), /not found|Unknown/);
  });
});

// ---------- Basic conversion R4->R5 -----------------------------------------

describe('fml_base_conv: Questionnaire R4->R5 conversion', function () {
  let engine;
  let output;
  const warnings = [];

  before(function () {
    engine = createFmlEngine('Questionnaire', 'R4', 'R5', {
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
    assert.equal(output.derivedFrom, r4Questionnaire.derivedFrom);
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
    const engine = createFmlEngine('Questionnaire', 'R4', 'R5');
    const out = engine.convert({ input: r4Questionnaire });
    assert.ok(out.meta.profile.includes('http://hl7.org/fhir/5.0/StructureDefinition/Questionnaire'));
    assert.ok(!out.meta.profile.includes('http://hl7.org/fhir/4.0/StructureDefinition/Questionnaire'));
  });

  it('adds target profile when source has no profile', function () {
    const input = { resourceType: 'Questionnaire', status: 'draft' };
    const engine = createFmlEngine('Questionnaire', 'R4', 'R5');
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
    const engine = createFmlEngine('Questionnaire', 'R4', 'R5');
    const out = engine.convert({ input });
    assert.ok(out.meta.profile.includes('http://myorg.com/fhir/StructureDefinition/CustomQuestionnaire'));
    assert.ok(out.meta.profile.includes('http://hl7.org/fhir/5.0/StructureDefinition/Questionnaire'));
    assert.ok(!out.meta.profile.includes('http://hl7.org/fhir/4.0/StructureDefinition/Questionnaire'));
  });
});

// ---------- createChainedEngine --------------------------------------------

describe('fml_base_conv/createChainedConverter', function () {
  it('same version returns input unchanged', function () {
    const engine = createChainedConverter('Questionnaire', 'R4', 'R4');
    assert.deepEqual(engine.hops, []);
    const out = engine.convert({ input: r4Questionnaire });
    assert.deepEqual(out, r4Questionnaire);
  });

  it('adjacent versions produce single hop', function () {
    const engine = createChainedConverter('Questionnaire', 'R4', 'R5');
    assert.equal(engine.hops.length, 2); // R4->R4B, R4B->R5
    assert.ok(engine.convert);
  });

  it('R3->R5 chains through R4', function () {
    const engine = createChainedConverter('Questionnaire', 'R3', 'R5');
    assert.ok(engine.hops.length >= 2);
    assert.ok(engine.convert);
  });

  it('R4->R4B emits compatibility warning', function () {
    const warnings = [];
    const engine = createChainedConverter('Questionnaire', 'R4', 'R4B', {
      onWarning: msg => warnings.push(msg),
    });
    assert.ok(warnings.some(w => w.includes('not guaranteed')));
  });

  it('chained R3->R5 produces valid output', function () {
    const engine = createChainedConverter('Questionnaire', 'R3', 'R5');
    const out = engine.convert({ input: stu3Questionnaire });
    assert.ok(out);
    assert.equal(out.resourceType, 'Questionnaire');
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



