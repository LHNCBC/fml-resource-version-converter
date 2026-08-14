/**
 * @fileoverview Unit tests for tools/fhir-tables-lib.js detection rules.
 *
 * Pins down each rule in classifyElement() and the accumulator behavior
 * in processElements(), so plausible-looking edits to the detection
 * logic don't silently change what ends up in poly-paths and cardinality
 * tables.
 */
import { strict as assert } from 'node:assert';
import { classifyElement, processElements, BUNDLE_ENTRY_RE }
  from '../../../tools/fhir-tables-lib.js';

describe('fhir-tables-lib: classifyElement', () => {

  it('strips [x] suffix when forming the path key', () => {
    const c = classifyElement({ path: 'Observation.value[x]', type: [{ code: 'string' }] });
    assert.equal(c.pathKey, 'Observation.value');
  });

  it('keeps the path verbatim when no [x] suffix', () => {
    const c = classifyElement({ path: 'Patient.name', type: [{ code: 'HumanName' }], max: '*' });
    assert.equal(c.pathKey, 'Patient.name');
  });

  it('treats a [x]-suffixed path as polymorphic even with a single type', () => {
    const c = classifyElement({ path: 'Patient.deceased[x]', type: [{ code: 'boolean' }] });
    assert.deepEqual(c.poly, { types: ['boolean'] });
  });

  it('treats a non-[x] path with multiple types as polymorphic', () => {
    const c = classifyElement({ path: 'Foo.bar', type: [{ code: 'string' }, { code: 'integer' }] });
    assert.deepEqual(c.poly, { types: ['string', 'integer'] });
  });

  it('does not flag a single-type non-[x] field as polymorphic', () => {
    const c = classifyElement({ path: 'Patient.gender', type: [{ code: 'code' }] });
    assert.equal(c.poly, null);
  });

  it('flags array when max="*"', () => {
    const c = classifyElement({ path: 'Patient.name', max: '*', type: [{ code: 'HumanName' }] });
    assert.equal(c.array, true);
  });

  it('flags array when max is a numeric upper bound greater than 1', () => {
    const c = classifyElement({ path: 'Foo.bar', max: '2' });
    assert.equal(c.array, true);
  });

  it('does not flag array when max="1"', () => {
    const c = classifyElement({ path: 'Foo.bar', max: '1' });
    assert.equal(c.array, false);
  });

  it('does not flag array when max="0" (forbidden field)', () => {
    const c = classifyElement({ path: 'Foo.bar', max: '0' });
    assert.equal(c.array, false);
  });

  it('does not flag array when max is absent', () => {
    const c = classifyElement({ path: 'Foo.bar' });
    assert.equal(c.array, false);
  });

  it('returns null pathKey for elements with no path (skipped)', () => {
    const c = classifyElement({ max: '*', type: [{ code: 'string' }] });
    assert.equal(c.pathKey, null);
  });

  it('skips poly classification when type[] is absent (contentReference)', () => {
    const c = classifyElement({ path: 'Foo.bar', contentReference: '#Foo' });
    assert.equal(c.poly, null);
  });

  it('counts type entries with missing code and excludes them from types', () => {
    const c = classifyElement({
      path: 'Foo.bar[x]',
      type: [{ code: 'string' }, {}, { code: 'integer' }],
    });
    assert.equal(c.missingTypeCodes, 1);
    assert.deepEqual(c.poly, { types: ['string', 'integer'] });
  });

  it('can flag both array and poly on the same element', () => {
    const c = classifyElement({
      path: 'Foo.value[x]', max: '*',
      type: [{ code: 'string' }, { code: 'integer' }],
    });
    assert.equal(c.array, true);
    assert.deepEqual(c.poly, { types: ['string', 'integer'] });
  });

  it('returns scalarType for a single-concrete-type non-poly element', () => {
    const c = classifyElement({ path: 'Patient.gender', type: [{ code: 'code' }] });
    assert.equal(c.scalarType, 'code');
    assert.equal(c.poly, null);
  });

  it('returns null scalarType for a polymorphic [x] element', () => {
    const c = classifyElement({ path: 'Observation.value[x]', type: [{ code: 'string' }] });
    assert.equal(c.scalarType, null);
  });

  it('returns null scalarType for a multi-type element', () => {
    const c = classifyElement({ path: 'Foo.bar', type: [{ code: 'string' }, { code: 'integer' }] });
    assert.equal(c.scalarType, null);
  });

  it('returns null scalarType when type[] is absent', () => {
    const c = classifyElement({ path: 'Foo.bar', contentReference: '#Foo' });
    assert.equal(c.scalarType, null);
  });

  it('counts missing type.code for non-poly single-type elements without code', () => {
    const c = classifyElement({ path: 'Foo.bar', type: [{}] });
    assert.equal(c.scalarType, null);
    assert.equal(c.missingTypeCodes, 1);
  });
});

describe('fhir-tables-lib: processElements', () => {

  it('merges types from multiple elements that share a path key', () => {
    const polyMap = new Map();
    const arraySet = new Set();
    const typesMap = new Map();
    processElements([
      { path: 'Foo.value[x]', type: [{ code: 'string' }] },
      { path: 'Foo.value[x]', type: [{ code: 'integer' }] },
    ], polyMap, arraySet, typesMap);
    assert.deepEqual([...polyMap.get('Foo.value')].sort(), ['integer', 'string']);
  });

  it('accumulates array paths and ignores scalars', () => {
    const polyMap = new Map();
    const arraySet = new Set();
    const typesMap = new Map();
    processElements([
      { path: 'Foo.list',   max: '*' },
      { path: 'Foo.scalar', max: '1' },
      { path: 'Foo.absent' },
    ], polyMap, arraySet, typesMap);
    assert.deepEqual([...arraySet].sort(), ['Foo.list']);
  });

  it('accumulates element types for non-poly single-type elements', () => {
    const polyMap = new Map();
    const arraySet = new Set();
    const typesMap = new Map();
    processElements([
      { path: 'Patient.gender',     type: [{ code: 'code' }] },
      { path: 'Patient.identifier', max: '*', type: [{ code: 'Identifier' }] },
      { path: 'Observation.value[x]', type: [{ code: 'string' }, { code: 'Quantity' }] },
    ], polyMap, arraySet, typesMap);
    assert.equal(typesMap.get('Patient.gender'), 'code');
    assert.equal(typesMap.get('Patient.identifier'), 'Identifier');
    assert.equal(typesMap.has('Observation.value'), false);
  });

  it('first scalar type wins on conflict (snapshot vs differential overlap)', () => {
    const polyMap = new Map();
    const arraySet = new Set();
    const typesMap = new Map();
    processElements([
      { path: 'Foo.bar', type: [{ code: 'string' }] },
      { path: 'Foo.bar', type: [{ code: 'integer' }] },
    ], polyMap, arraySet, typesMap);
    assert.equal(typesMap.get('Foo.bar'), 'string');
  });

  it('skips elementTypes accumulation when map argument is null', () => {
    const polyMap = new Map();
    const arraySet = new Set();
    const n = processElements([
      { path: 'Patient.gender', type: [{ code: 'code' }] },
    ], polyMap, arraySet, null);
    assert.equal(n, 1);
  });

  it('returns the count of elements scanned (including skipped ones)', () => {
    const polyMap = new Map();
    const arraySet = new Set();
    const n = processElements(
      [{ path: 'a' }, {}, { path: 'c' }],
      polyMap, arraySet, null
    );
    assert.equal(n, 3);
  });

  it('invokes the missing-type-code callback with element path and sdId', () => {
    const polyMap = new Map();
    const arraySet = new Set();
    const calls = [];
    processElements(
      [{ path: 'Foo.bar[x]', type: [{}] }],
      polyMap, arraySet, null,
      (p, sd) => calls.push([p, sd]),
      'FooSD'
    );
    assert.deepEqual(calls, [['Foo.bar[x]', 'FooSD']]);
  });
});

describe('fhir-tables-lib: BUNDLE_ENTRY_RE', () => {

  it('matches the two relevant bundle filenames at the zip root', () => {
    assert.ok(BUNDLE_ENTRY_RE.test('profiles-resources.json'));
    assert.ok(BUNDLE_ENTRY_RE.test('profiles-types.json'));
  });

  it('matches under a forward-slash prefix (R4B layout)', () => {
    assert.ok(BUNDLE_ENTRY_RE.test('definitions.json/profiles-resources.json'));
  });

  it('matches under a backslash prefix (DSTU2 fhir-spec.zip layout)', () => {
    assert.ok(BUNDLE_ENTRY_RE.test('site\\profiles-types.json'));
  });

  it('rejects similarly-named but unrelated files', () => {
    assert.ok(!BUNDLE_ENTRY_RE.test('profiles-others.json'));
    assert.ok(!BUNDLE_ENTRY_RE.test('valuesets.json'));
  });
});
