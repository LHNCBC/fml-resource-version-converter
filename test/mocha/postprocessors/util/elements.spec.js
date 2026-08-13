/**
 * Tests for the generic FHIR element helpers (postprocessors/util/elements.js).
 */
import { strict as assert } from 'node:assert';
import {
  DATA_ABSENT_REASON_URL,
  addDataAbsentReasonExtension,
  copyPrimitive,
  deletePrimitive,
  findValueKey,
  hasAnyContent,
  removePrimitiveArrayEntries,
  renamePrimitive,
  stripCanonicalVersion,
} from '../../../../src/postprocessors/util/elements.js';


describe('postprocessors/util/elements stripCanonicalVersion', function () {
  it('removes a version suffix', function () {
    assert.equal(
      stripCanonicalVersion('http://example.org/fhir/ValueSet/example|2.0.0'),
      'http://example.org/fhir/ValueSet/example',
    );
  });

  it('preserves a fragment after the removed version', function () {
    assert.equal(
      stripCanonicalVersion('http://example.org/fhir/ValueSet/example|2.0.0#contained'),
      'http://example.org/fhir/ValueSet/example#contained',
    );
  });

  it('leaves an unversioned reference unchanged', function () {
    assert.equal(
      stripCanonicalVersion('http://example.org/fhir/ValueSet/example#contained'),
      'http://example.org/fhir/ValueSet/example#contained',
    );
  });
});


describe('postprocessors/util/elements addDataAbsentReasonExtension', function () {
  it('creates the _companion and attaches the extension', function () {
    const object = { content: 'supplement' };
    const added = addDataAbsentReasonExtension(object, 'supplements');

    assert.equal(added, true);
    assert.deepEqual(object._supplements, {
      extension: [{ url: DATA_ABSENT_REASON_URL, valueCode: 'unknown' }],
    });
    assert.equal('supplements' in object, false);
  });

  it('uses the standard extension URL', function () {
    assert.equal(
      DATA_ABSENT_REASON_URL,
      'http://hl7.org/fhir/StructureDefinition/data-absent-reason',
    );
  });

  it('accepts an explicit reason code', function () {
    const object = {};
    addDataAbsentReasonExtension(object, 'supplements', 'not-applicable');

    assert.equal(object._supplements.extension[0].valueCode, 'not-applicable');
  });

  it('preserves unrelated extensions already on the companion', function () {
    const other = { url: 'http://example.org/fhir/StructureDefinition/note', valueString: 'x' };
    const object = { _supplements: { id: 'sup', extension: [other] } };
    const added = addDataAbsentReasonExtension(object, 'supplements');

    assert.equal(added, true);
    assert.equal(object._supplements.id, 'sup');
    assert.deepEqual(object._supplements.extension[0], other);
    assert.equal(object._supplements.extension[1].url, DATA_ABSENT_REASON_URL);
  });

  it('is idempotent', function () {
    const object = {};
    assert.equal(addDataAbsentReasonExtension(object, 'supplements'), true);
    assert.equal(addDataAbsentReasonExtension(object, 'supplements'), false);
    assert.equal(object._supplements.extension.length, 1);
  });

  it('returns false for a non-object target', function () {
    assert.equal(addDataAbsentReasonExtension(null, 'supplements'), false);
    assert.equal(addDataAbsentReasonExtension(undefined, 'supplements'), false);
  });
});


describe('postprocessors/util/elements removePrimitiveArrayEntries', function () {
  it('removes matching entries and reports what was removed', function () {
    const object = { operator: ['is-a', 'child-of', 'regex'] };
    const result = removePrimitiveArrayEntries(object, 'operator', v => v === 'child-of');

    assert.deepEqual(object.operator, ['is-a', 'regex']);
    assert.deepEqual(result.removed, [{ index: 1, value: 'child-of' }]);
    assert.equal(result.remaining, 2);
  });

  it('keeps the _companion array aligned with the surviving values', function () {
    const object = {
      operator: ['is-a', 'child-of', 'regex'],
      _operator: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    };
    removePrimitiveArrayEntries(object, 'operator', v => v === 'child-of');

    assert.deepEqual(object.operator, ['is-a', 'regex']);
    assert.deepEqual(object._operator, [{ id: 'a' }, { id: 'c' }]);
  });

  it('pads a short _companion array with null so positions stay correct', function () {
    const object = { operator: ['a', 'b', 'c'], _operator: [{ id: 'a' }] };
    removePrimitiveArrayEntries(object, 'operator', v => v === 'b');

    assert.deepEqual(object._operator, [{ id: 'a' }, null]);
  });

  it('deletes both keys when every entry is removed', function () {
    const object = { operator: ['child-of'], _operator: [{ id: 'a' }], code: 'concept' };
    const result = removePrimitiveArrayEntries(object, 'operator', () => true);

    assert.equal('operator' in object, false);
    assert.equal('_operator' in object, false);
    assert.equal(object.code, 'concept');
    assert.equal(result.remaining, 0);
    assert.equal(result.removed.length, 1);
  });

  it('drops an all-null _companion array rather than leaving it behind', function () {
    const object = { operator: ['a', 'b'], _operator: [null, { id: 'b' }] };
    removePrimitiveArrayEntries(object, 'operator', v => v === 'b');

    assert.deepEqual(object.operator, ['a']);
    assert.equal('_operator' in object, false);
  });

  it('leaves the object untouched when nothing matches', function () {
    const object = { operator: ['is-a'], _operator: [{ id: 'a' }] };
    const result = removePrimitiveArrayEntries(object, 'operator', () => false);

    assert.deepEqual(object.operator, ['is-a']);
    assert.deepEqual(object._operator, [{ id: 'a' }]);
    assert.deepEqual(result.removed, []);
    assert.equal(result.remaining, 1);
  });

  it('tolerates a missing or non-array primitive', function () {
    assert.deepEqual(
      removePrimitiveArrayEntries({}, 'operator', () => true),
      { removed: [], remaining: 0 },
    );
    assert.deepEqual(
      removePrimitiveArrayEntries({ operator: 'is-a' }, 'operator', () => true),
      { removed: [], remaining: 0 },
    );
    assert.deepEqual(
      removePrimitiveArrayEntries(undefined, 'operator', () => true),
      { removed: [], remaining: 0 },
    );
  });
});


describe('postprocessors/util/elements hasAnyContent', function () {
  it('detects a plain value under any of the named properties', function () {
    assert.equal(hasAnyContent({ extensible: true }, ['extensible']), true);
    assert.equal(hasAnyContent({ extensible: false }, ['extensible']), true);
    assert.equal(hasAnyContent({ a: 1 }, ['b', 'a']), true);
  });

  it('detects an extension-only primitive via its _companion', function () {
    const object = { _extensible: { extension: [{ url: 'u' }] } };
    assert.equal(hasAnyContent(object, ['extensible', '_extensible']), true);
  });

  it('treats absent, null, and unnamed properties as no content', function () {
    assert.equal(hasAnyContent({}, ['a']), false);
    assert.equal(hasAnyContent({ a: null }, ['a']), false);
    assert.equal(hasAnyContent({ a: undefined }, ['a']), false);
    assert.equal(hasAnyContent({ b: 'x' }, ['a']), false);
  });

  it('treats empty arrays and empty objects as no content', function () {
    assert.equal(hasAnyContent({ a: [] }, ['a']), false);
    assert.equal(hasAnyContent({ a: {} }, ['a']), false);
    assert.equal(hasAnyContent({ a: [1] }, ['a']), true);
    assert.equal(hasAnyContent({ a: { k: 1 } }, ['a']), true);
  });

  it('returns false for a non-object or empty name list', function () {
    assert.equal(hasAnyContent(undefined, ['a']), false);
    assert.equal(hasAnyContent(null, ['a']), false);
    assert.equal(hasAnyContent('str', ['a']), false);
    assert.equal(hasAnyContent({ a: 1 }, []), false);
  });
});


describe('postprocessors/util/elements copyPrimitive', function () {
  it('copies a bare primitive value under the new key', function () {
    const src = { valueString: 'Mint' };
    const dst = {};
    copyPrimitive(src, 'valueString', dst, 'initialString');
    assert.deepEqual(dst, { initialString: 'Mint' });
  });

  it('copies the primitive value and its _companion (id/extension)', function () {
    const src = { valueString: 'Mint', _valueString: { id: 'x', extension: [{ url: 'u' }] } };
    const dst = {};
    copyPrimitive(src, 'valueString', dst, 'initialString');
    assert.deepEqual(dst, {
      initialString: 'Mint',
      _initialString: { id: 'x', extension: [{ url: 'u' }] },
    });
  });

  it('copies a companion-only (extension-only) primitive faithfully', function () {
    const src = { _valueString: { extension: [{ url: 'u' }] } };
    const dst = {};
    copyPrimitive(src, 'valueString', dst, 'initialString');
    assert.equal('initialString' in dst, false);
    assert.deepEqual(dst._initialString, { extension: [{ url: 'u' }] });
  });

  it('copies a complex value object whole (no companion involved)', function () {
    const src = { valueCoding: { id: 'c1', code: 'c', display: 'Green' } };
    const dst = {};
    copyPrimitive(src, 'valueCoding', dst, 'initialCoding');
    assert.deepEqual(dst.initialCoding, { id: 'c1', code: 'c', display: 'Green' });
    assert.equal('_initialCoding' in dst, false);
  });

  it('leaves the source untouched and does nothing when the key is absent', function () {
    const src = { valueString: 'Mint' };
    const dst = {};
    copyPrimitive(src, 'valueInteger', dst, 'initialInteger');
    assert.deepEqual(dst, {});
    assert.deepEqual(src, { valueString: 'Mint' });
  });
});


describe('postprocessors/util/elements renamePrimitive', function () {
  it('renames the value and its _companion in place', function () {
    const obj = { answerBoolean: true, _answerBoolean: { id: 'ab1' }, question: 'q' };
    renamePrimitive(obj, 'answerBoolean', 'hasAnswer');
    assert.deepEqual(obj, { hasAnswer: true, _hasAnswer: { id: 'ab1' }, question: 'q' });
  });

  it('renames a bare value with no companion', function () {
    const obj = { answerBoolean: true };
    renamePrimitive(obj, 'answerBoolean', 'hasAnswer');
    assert.deepEqual(obj, { hasAnswer: true });
  });

  it('renames a companion-only primitive', function () {
    const obj = { _answerBoolean: { id: 'ab1' } };
    renamePrimitive(obj, 'answerBoolean', 'hasAnswer');
    assert.deepEqual(obj, { _hasAnswer: { id: 'ab1' } });
  });

  it('is a no-op when neither key is present', function () {
    const obj = { question: 'q' };
    renamePrimitive(obj, 'answerBoolean', 'hasAnswer');
    assert.deepEqual(obj, { question: 'q' });
  });
});


describe('postprocessors/util/elements deletePrimitive', function () {
  it('deletes value and companion, reporting both were present', function () {
    const obj = { operator: '=', _operator: { id: 'o1' }, question: 'q' };
    const removed = deletePrimitive(obj, 'operator');
    assert.deepEqual(obj, { question: 'q' });
    assert.deepEqual(removed, { hadValue: true, hadCompanion: true });
  });

  it('deletes a bare value, reporting no companion', function () {
    const obj = { operator: '=' };
    const removed = deletePrimitive(obj, 'operator');
    assert.deepEqual(obj, {});
    assert.deepEqual(removed, { hadValue: true, hadCompanion: false });
  });

  it('deletes a companion-only primitive, reporting no bare value', function () {
    const obj = { _operator: { extension: [{ url: 'u' }] } };
    const removed = deletePrimitive(obj, 'operator');
    assert.deepEqual(obj, {});
    assert.deepEqual(removed, { hadValue: false, hadCompanion: true });
  });

  it('reports nothing removed when the key is absent', function () {
    const obj = { question: 'q' };
    const removed = deletePrimitive(obj, 'operator');
    assert.deepEqual(obj, { question: 'q' });
    assert.deepEqual(removed, { hadValue: false, hadCompanion: false });
  });
});


describe('postprocessors/util/elements findValueKey', function () {
  it('returns the full value[x] key by default', function () {
    assert.equal(findValueKey({ valueString: 'x' }), 'valueString');
    assert.equal(findValueKey({ valueCoding: { code: 'c' } }), 'valueCoding');
  });

  it('returns just the suffix with suffixOnly', function () {
    assert.equal(findValueKey({ valueString: 'x' }, { suffixOnly: true }), 'String');
    assert.equal(findValueKey({ valueCoding: { code: 'c' } }, { suffixOnly: true }), 'Coding');
  });

  it('returns undefined when no value[x] is present', function () {
    assert.equal(findValueKey({ question: 'q', initialSelected: true }), undefined);
    assert.equal(findValueKey({}), undefined);
  });

  it('ignores an extension-only primitive by default', function () {
    assert.equal(findValueKey({ _valueString: { id: 'x' } }), undefined);
  });

  it('detects an extension-only primitive with companionAware', function () {
    assert.equal(findValueKey({ _valueString: { id: 'x' } }, { companionAware: true }), 'valueString');
    assert.equal(
      findValueKey({ _valueString: { id: 'x' } }, { companionAware: true, suffixOnly: true }),
      'String',
    );
  });

  it('prefers the bare value over the companion when both are present', function () {
    assert.equal(
      findValueKey({ valueString: 'x', _valueString: { id: 'i' } }, { companionAware: true }),
      'valueString',
    );
  });

  it('does not match the literal keys "value" or "_value" (no suffix)', function () {
    assert.equal(findValueKey({ value: 'x' }), undefined);
    assert.equal(findValueKey({ _value: { id: 'i' } }, { companionAware: true }), undefined);
  });
});
