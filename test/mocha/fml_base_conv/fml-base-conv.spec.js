/**
 * Tests for the fml_base_conv module: engine factory, single-hop conversion,
 * hop-math (planHops), meta.profile handling, and ConceptMap translation.
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
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
    assert.equal(factory.hasMapping('Sequence', 'R3', 'R4'), true);
    assert.equal(factory.hasMapping('NoSuchResource', 'R4', 'R5'), false);
  });

  it('throws for unknown resource type', function () {
    assert.throws(() => createEngine('NoSuchResource', 'R4', 'R5'), /FML mapping not found/);
  });

  it('throws for unknown FHIR version', function () {
    assert.throws(() => createEngine('Questionnaire', 'R4', 'R99'), /not found|Unknown/);
  });
});

// ---------- resource mapping discovery and selection ------------------------

describe('fml_base_conv: resource mapping discovery and selection', function () {
  it('does not cache a partially scanned direction after an FML parse error', function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fml-catalog-'));
    try {
      const direction = path.join(root, 'R4toR5');
      fs.mkdirSync(direction);

      const validFml = `
/// url = "http://example.org/StructureMap/Patient4to5"
/// name = "Patient4to5"

uses "http://hl7.org/fhir/4.0/StructureDefinition/Patient" alias PatientR4 as source
uses "http://hl7.org/fhir/5.0/StructureDefinition/Patient" alias PatientR5 as target

group Patient(source src : PatientR4, target tgt : PatientR5) extends DomainResource <<type+>> {
  src.id -> tgt.id;
}
`;
      fs.writeFileSync(path.join(direction, 'AValid.fml'), validFml, 'utf-8');
      fs.writeFileSync(path.join(direction, 'ZInvalid.fml'), 'group Broken(', 'utf-8');

      const factory = createFmlEngineFactory({ xverInputRoot: root });
      const inspect = () => factory.hasMapping('Patient', 'R4', 'R5');

      assert.throws(inspect, /failed to inspect.*ZInvalid\.fml/);
      assert.throws(
        inspect,
        /failed to inspect.*ZInvalid\.fml/,
        'a second lookup must retry the failed scan rather than use a partial cache',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('discovers a renamed resource by its FML source declaration', function () {
    const factory = createFmlEngineFactory();
    const mapping = factory.resolveMapping('Sequence', 'R3', 'R4');

    assert.equal(mapping.structureMapName, 'Sequence3to4');
    assert.equal(mapping.entryGroup, 'Sequence');
    assert.equal(mapping.sourceResourceType, 'Sequence');
    assert.equal(mapping.targetResourceType, 'MolecularSequence');
  });

  it('uses the declared entry group and target type in both rename directions', function () {
    const toR4 = createEngine('Sequence', 'R3', 'R4');
    const r4 = toR4.convert({
      input: {
        resourceType: 'Sequence',
        id: 'sequence-r3',
        type: 'dna',
        coordinateSystem: 0,
      },
    });

    assert.equal(r4.resourceType, 'MolecularSequence');
    assert.equal(r4.id, 'sequence-r3');
    assert.deepEqual(
      r4.meta.profile,
      ['http://hl7.org/fhir/4.0/StructureDefinition/MolecularSequence'],
    );

    const toR3 = createEngine('MolecularSequence', 'R4', 'R3');
    const r3 = toR3.convert({
      input: {
        resourceType: 'MolecularSequence',
        id: 'sequence-r4',
        type: 'dna',
        coordinateSystem: 0,
      },
    });

    assert.equal(r3.resourceType, 'Sequence');
    assert.equal(r3.id, 'sequence-r4');
    assert.deepEqual(
      r3.meta.profile,
      ['http://hl7.org/fhir/3.0/StructureDefinition/Sequence'],
    );
  });

  it('requires targetResourceType for a one-to-many source mapping', function () {
    const factory = createFmlEngineFactory();

    assert.throws(
      () => factory.resolveMapping('ServiceRequest', 'R4', 'R3'),
      /targetResourceType is required.*ProcedureRequest, ReferralRequest/,
    );
  });

  it('selects each ServiceRequest target by targetResourceType', function () {
    const factory = createFmlEngineFactory();
    const procedure = factory.resolveMapping('ServiceRequest', 'R4', 'R3', {
      targetResourceType: 'ProcedureRequest',
    });
    const referral = factory.resolveMapping('ServiceRequest', 'R4', 'R3', {
      targetResourceType: 'ReferralRequest',
    });

    assert.equal(procedure.entryGroup, 'ServiceRequestPR');
    assert.equal(procedure.targetResourceType, 'ProcedureRequest');
    assert.equal(referral.entryGroup, 'ServiceRequestR');
    assert.equal(referral.targetResourceType, 'ReferralRequest');
  });

  it('rejects a target type that no candidate declares', function () {
    const factory = createFmlEngineFactory();

    assert.throws(
      () => factory.resolveMapping('Questionnaire', 'R4', 'R5', {
        targetResourceType: 'Patient',
      }),
      /targeting Patient.*Available targets: Questionnaire/,
    );
  });

  it('fails closed when targetResourceType still leaves duplicate maps', function () {
    const factory = createFmlEngineFactory();

    assert.throws(
      () => factory.resolveMapping('ProcedureRequest', 'R3', 'R2', {
        targetResourceType: 'DiagnosticOrder',
      }),
      /Multiple FML StructureMaps.*DiagnosticOrder3to2, ProcedureRequestDO3to2/,
    );
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

// ---------- repeating type coercion -----------------------------------------

describe('fml_base_conv: repeating type coercion', function () {
  it('coerces each ActivityDefinition.library Reference to a canonical', function () {
    const input = {
      resourceType: 'ActivityDefinition',
      status: 'draft',
      library: [
        { reference: 'Library/one' },
        { reference: 'Library/two' },
      ],
    };
    const engine = createEngine('ActivityDefinition', 'R3', 'R4');
    const out = engine.convert({ input });

    assert.deepEqual(out.library, ['Library/one', 'Library/two']);
  });

  it('coerces each array element when the source rule declares an alias', function () {
    const fml = `
/// url = "http://test/AliasedArrayMap"
/// name = "AliasedArrayMap"

group Test(source src, target tgt) {
  src.value as v -> tgt.value;
}
`;
    const coercion = `
uses "http://test/StructureDefinition/string" alias stringSource as source
uses "http://test/StructureDefinition/code" alias codeTarget as target

group string2code(source src : stringSource, target tgt : codeTarget) extends Element <<types>> {
  src.value -> tgt.value = 'coerced';
}
`;
    const engine = compileFmlXver({
      fmlText: fml,
      importedFmlTexts: [coercion],
      srcDefs: {
        polyPaths: {},
        elementTypes: { 'Test.value': 'string' },
        arrayPaths: ['Test.value'],
      },
      tgtDefs: {
        polyPaths: {},
        elementTypes: { 'Test.value': 'code' },
        arrayPaths: ['Test.value'],
      },
    });
    const out = engine.convert({
      input: { resourceType: 'Test', value: ['first', 'second'] },
    });

    assert.deepEqual(out.value, ['coerced', 'coerced']);
  });

  it('reports a missing aliased-array coercion group once per conversion', function () {
    const fml = `
/// url = "http://test/MissingAliasedArrayMap"
/// name = "MissingAliasedArrayMap"

group Test(source src, target tgt) {
  src.value as v -> tgt.value;
}
`;
    const unrelatedCoercion = `
uses "http://test/StructureDefinition/integer" alias integerSource as source
uses "http://test/StructureDefinition/boolean" alias booleanTarget as target

group integer2boolean(source src : integerSource, target tgt : booleanTarget) extends Element <<types>> {
  src.value -> tgt.value;
}
`;
    const info = [];
    const engine = compileFmlXver({
      fmlText: fml,
      importedFmlTexts: [unrelatedCoercion],
      srcDefs: {
        polyPaths: {},
        elementTypes: { 'Test.value': 'string' },
        arrayPaths: ['Test.value'],
      },
      tgtDefs: {
        polyPaths: {},
        elementTypes: { 'Test.value': 'code' },
        arrayPaths: ['Test.value'],
      },
      onInfo: message => info.push(message),
    });

    engine.convert({
      input: { resourceType: 'Test', value: ['one', 'two', 'three'] },
    });
    assert.equal(info.length, 1);

    info.length = 0;
    engine.convert({
      input: {
        resourceType: 'Test',
        value: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
      },
    });
    assert.equal(info.length, 1, 'a reused engine must report once for each resource');
  });
});

// ---------- then-clause / poly-suffix / array-transform correctness ---------

describe('fml_base_conv: then-clause and target-path correctness', function () {
  it('runs a <<types>> conversion group instead of shortcut-copying the primitive', function () {
    // R4 GuidanceResponse.moduleCanonical (canonical) must become an R3
    // Reference via canonical2Reference - not be copied through as a string.
    const engine = createEngine('GuidanceResponse', 'R4', 'R3');
    const out = engine.convert({
      input: { resourceType: 'GuidanceResponse', status: 'success', moduleCanonical: 'Library/123' },
    });
    assert.deepEqual(out.module, { reference: 'Library/123' });
  });

  it('does not leak a source polymorphic suffix onto a fixed target field', function () {
    // R3 GuidanceResponse.module is a fixed Reference, not module[x]; the
    // source "Canonical" suffix must not create a `moduleCanonical` field.
    const engine = createEngine('GuidanceResponse', 'R4', 'R3');
    const out = engine.convert({
      input: { resourceType: 'GuidanceResponse', status: 'success', moduleCanonical: 'Library/123' },
    });
    assert.equal(out.moduleCanonical, undefined);
    assert.ok(out.module && typeof out.module === 'object');
  });

  it('applies a transformed primary target in a repeating then-rule', function () {
    const fml = `
group T(source src, target tgt) {
  src.items as s -> tgt.flag = true, tgt.out as o then Fill(s, o);
}
group Fill(source src, target tgt) { src.v -> tgt.v; }
`;
    const engine = compileFmlXver({ fmlText: fml });
    const out = engine.convert({
      input: { resourceType: 'T', items: [{ v: 'a' }, { v: 'b' }] },
    });
    // The transformed primary (flag = true) must be assigned, not turned into
    // an array of empty then-children.
    assert.equal(out.flag, true);
  });

  it('leaves no empty element when every first/last item is filtered out', function () {
    const fml = `
group T(source src, target tgt) {
  src.more as s where (s.keep = true) -> tgt.list as l first, l.w as w then Fill(s, w);
}
group Fill(source src, target tgt) { src.x -> tgt.x; }
`;
    const engine = compileFmlXver({
      fmlText: fml,
      tgtDefs: { polyPaths: {}, elementTypes: {}, arrayPaths: ['T.list'] },
    });
    const out = engine.convert({
      input: { resourceType: 'T', more: [{ keep: false, x: 'z' }] },
    });
    assert.equal(out.list, undefined);
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
    // Questionnaire.derivedFrom is 0..* in R4 and R5; a well-formed input
    // passes through unchanged.
    assert.deepEqual(output.derivedFrom, r4Questionnaire.derivedFrom);
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

  it('preserves primitive companions on copied, translated, and polymorphic fields', function () {
    /**
     * Build distinctive primitive metadata for one test field.
     *
     * @param {string} label Field label.
     * @returns {Object} Primitive companion.
     */
    const primitiveMetadata = label => ({
      id: `${label}-id`,
      extension: [{
        url: `http://example.org/fhir/StructureDefinition/${label}`,
        valueString: label,
      }],
    });
    const input = {
      resourceType: 'Questionnaire',
      language: 'en',
      _language: primitiveMetadata('language'),
      _implicitRules: primitiveMetadata('implicit-rules-only'),
      status: 'active',
      _status: primitiveMetadata('status'),
      subjectType: ['Patient', null, 'Encounter'],
      _subjectType: [
        null,
        primitiveMetadata('subject-type-only'),
        primitiveMetadata('subject-type'),
      ],
      item: [{
        linkId: 'q1',
        _linkId: primitiveMetadata('link-id'),
        type: 'choice',
        _type: primitiveMetadata('type'),
        answerOption: [{
          valueString: 'option',
          _valueString: primitiveMetadata('value-string'),
        }, {
          _valueString: primitiveMetadata('value-string-only'),
        }],
      }, {
        _linkId: primitiveMetadata('link-id-only'),
        type: 'string',
      }, {
        linkId: 'q3',
        _type: primitiveMetadata('type-only'),
      }],
    };

    const converted = engine.convert({ input });

    assert.equal(converted.language, input.language);
    assert.deepEqual(converted._language, input._language);
    assert.equal('implicitRules' in converted, false);
    assert.deepEqual(converted._implicitRules, input._implicitRules);
    assert.deepEqual(converted._status, input._status);
    assert.deepEqual(converted.subjectType, input.subjectType);
    assert.deepEqual(converted._subjectType, input._subjectType);
    assert.deepEqual(converted.item[0]._linkId, input.item[0]._linkId);
    assert.deepEqual(converted.item[0]._type, input.item[0]._type);
    assert.deepEqual(
      converted.item[0].answerOption[0]._valueString,
      input.item[0].answerOption[0]._valueString,
    );
    assert.equal('valueString' in converted.item[0].answerOption[1], false);
    assert.deepEqual(
      converted.item[0].answerOption[1]._valueString,
      input.item[0].answerOption[1]._valueString,
    );
    assert.equal('linkId' in converted.item[1], false);
    assert.deepEqual(converted.item[1]._linkId, input.item[1]._linkId);
    assert.equal('type' in converted.item[2], false);
    assert.deepEqual(converted.item[2]._type, input.item[2]._type);
    assert.equal('_answerConstraint' in converted.item[0], false);
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

  it('replaces a renamed source profile with the declared target profile', function () {
    const input = {
      resourceType: 'Sequence',
      type: 'dna',
      coordinateSystem: 0,
      meta: {
        profile: ['http://hl7.org/fhir/3.0/StructureDefinition/Sequence'],
      },
    };
    const engine = createEngine('Sequence', 'R3', 'R4');
    const out = engine.convert({ input });

    assert.deepEqual(
      out.meta.profile,
      ['http://hl7.org/fhir/4.0/StructureDefinition/MolecularSequence'],
    );
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

  it('round-trips primitive companions through an explicit primitive group', function () {
    const fml = `
/// url = "http://test/Map4"
/// name = "Test4"

group Test(source src, target tgt) {
  src.value : string as vs -> tgt.value = create('string') as vt then string(vs, vt) "valueString";
}
`;
    const primitives = `
uses "http://test/StructureDefinition/string-source" alias stringSource as source
uses "http://test/StructureDefinition/string-target" alias stringTarget as target

group string(source src : stringSource, target tgt : stringTarget) extends Element <<type+>> {
  src.value -> tgt.value;
}
`;
    const defs = {
      polyPaths: { 'Test.value': ['string'] },
      elementTypes: {},
      arrayPaths: [],
    };
    const companion = {
      id: 'value-id',
      extension: [{
        url: 'http://example.org/fhir/StructureDefinition/value-metadata',
        valueString: 'kept',
      }],
    };
    const engine = compileFmlXver({
      fmlText: fml,
      importedFmlTexts: [primitives],
      srcDefs: defs,
      tgtDefs: defs,
    });
    const out = engine.convert({
      input: {
        resourceType: 'Test',
        valueString: 'hello',
        _valueString: companion,
      },
    });

    assert.equal(out.valueString, 'hello');
    assert.deepEqual(out._valueString, companion);

    const companionOnly = engine.convert({
      input: {
        resourceType: 'Test',
        _valueString: companion,
      },
    });

    assert.equal('valueString' in companionOnly, false);
    assert.deepEqual(companionOnly._valueString, companion);
  });

  it('preserves primitive companions through type coercion groups', function () {
    const fml = `
/// url = "http://test/Map5"
/// name = "Test5"

group Test(source src, target tgt) {
  src.value -> tgt.value;
}
`;
    const coercion = `
uses "http://test/StructureDefinition/string" alias stringSource as source
uses "http://test/StructureDefinition/code" alias codeTarget as target

group string2code(source src : stringSource, target tgt : codeTarget) extends Element <<types>> {
  src.value -> tgt.value;
}
`;
    const companion = {
      id: 'coerced-id',
      extension: [{
        url: 'http://example.org/fhir/StructureDefinition/coercion-metadata',
        valueString: 'kept',
      }],
    };
    const engine = compileFmlXver({
      fmlText: fml,
      importedFmlTexts: [coercion],
      srcDefs: {
        polyPaths: {},
        elementTypes: { 'Test.value': 'string' },
        arrayPaths: [],
      },
      tgtDefs: {
        polyPaths: {},
        elementTypes: { 'Test.value': 'code' },
        arrayPaths: [],
      },
    });
    const out = engine.convert({
      input: {
        resourceType: 'Test',
        value: 'active',
        _value: companion,
      },
    });

    assert.equal(out.value, 'active');
    assert.deepEqual(out._value, companion);

    const companionOnly = engine.convert({
      input: {
        resourceType: 'Test',
        _value: companion,
      },
    });

    assert.equal('value' in companionOnly, false);
    assert.deepEqual(companionOnly._value, companion);
  });

  it('keeps repeating primitive companions aligned through list modes', function () {
    const fml = `
/// url = "http://test/Map6"
/// name = "Test6"

group Test(source src, target tgt) {
  src.code first as value -> tgt.code = value;
}
`;
    const firstCompanion = {
      extension: [{
        url: 'http://example.org/fhir/StructureDefinition/first',
        valueString: 'first',
      }],
    };
    const secondCompanion = {
      extension: [{
        url: 'http://example.org/fhir/StructureDefinition/second',
        valueString: 'second',
      }],
    };
    const defs = {
      polyPaths: {},
      elementTypes: { 'Test.code': 'code' },
      arrayPaths: ['Test.code'],
    };
    const engine = compileFmlXver({
      fmlText: fml,
      srcDefs: defs,
      tgtDefs: defs,
    });
    const out = engine.convert({
      input: {
        resourceType: 'Test',
        code: ['a', 'b'],
        _code: [firstCompanion, secondCompanion],
      },
    });

    assert.deepEqual(out.code, ['a']);
    assert.deepEqual(out._code, [firstCompanion]);
  });
});
