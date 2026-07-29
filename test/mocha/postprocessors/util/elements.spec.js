/**
 * Tests for the generic FHIR element helpers (postprocessors/util/elements.js).
 */
import { strict as assert } from 'node:assert';
import {
  copyPrimitive,
  deletePrimitive,
  findValueKey,
  renamePrimitive,
} from '../../../../src/postprocessors/util/elements.js';


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
