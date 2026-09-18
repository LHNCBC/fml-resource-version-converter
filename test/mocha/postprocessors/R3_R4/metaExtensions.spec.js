/**
 * Tests for the shared R4 -> R3 Meta and Extension validity repair.
 *
 * The reviewed R4 -> R3 postprocessors delegate to this helper, so its
 * behavior is exercised here once rather than in each resource-type spec.
 */
import { strict as assert } from 'node:assert';
import { MESSAGE_TYPE } from '../../../../src/converter/diagnostics.js';
import { repairR4ToR3MetaAndExtensions } from '../../../../src/postprocessors/R3_R4/metaExtensions.js';

/**
 * Run the repair and return the collected messages.
 *
 * @param {Object} target FML-converted STU3 resource.
 * @param {Object} [source] R4 source resource.
 * @returns {Array<Object>} Diagnostic messages.
 */
function repair(target, source) {
  const messages = [];
  repairR4ToR3MetaAndExtensions(target, source, messages);

  return messages;
}

/**
 * Join message texts for pattern assertions.
 *
 * @param {Array<Object>} messages Diagnostic messages.
 * @returns {string} Newline-joined message texts.
 */
function text(messages) {
  return messages.map(message => message.text).join('\n');
}

describe('postprocessors/R3_R4 metaExtensions', function () {
  describe('Meta.source reporting', function () {
    it('reports a bare and an extension-only root meta.source', function () {
      const bare = repair({ resourceType: 'CodeSystem' }, {
        resourceType: 'CodeSystem',
        meta: { source: 'http://example.org/source' },
      });
      const companionOnly = repair({ resourceType: 'CodeSystem' }, {
        resourceType: 'CodeSystem',
        meta: {
          _source: { extension: [{ url: 'http://example.org/x', valueString: 'y' }] },
        },
      });

      assert.equal(bare.length, 1);
      assert.equal(bare[0].type, MESSAGE_TYPE.WARNING);
      assert.match(bare[0].text, /meta\.source/);
      assert.equal(companionOnly.length, 1);
      assert.match(companionOnly[0].text, /meta\.source/);
    });

    it('does not report an absent or id-only meta.source companion', function () {
      const none = repair({ resourceType: 'CodeSystem' }, { resourceType: 'CodeSystem' });
      const idOnly = repair({ resourceType: 'CodeSystem' }, {
        resourceType: 'CodeSystem',
        meta: { versionId: '1', _source: {} },
      });

      assert.deepEqual(none, []);
      assert.deepEqual(idOnly, []);
    });

    it('reports Meta.source carried by ordinary and modifier extensions', function () {
      const messages = repair({ resourceType: 'ValueSet' }, {
        resourceType: 'ValueSet',
        extension: [{
          url: 'http://example.org/outer',
          extension: [{
            url: 'http://example.org/inner',
            valueMeta: { source: 'http://example.org/nested-source' },
          }],
        }],
        modifierExtension: [{
          url: 'http://example.org/modifier',
          valueMeta: { source: 'http://example.org/modifier-source' },
        }],
      });

      assert.equal(messages.length, 2);
      assert.match(text(messages), /extension\[0\]\.extension\[0\]\.valueMeta\.source/);
      assert.match(text(messages), /modifierExtension\[0\]\.valueMeta\.source/);
    });

    it('tolerates a missing source resource', function () {
      assert.deepEqual(repair({ resourceType: 'ValueSet' }, undefined), []);
    });
  });

  describe('invalid Extension removal', function () {
    it('removes a value-less extension and keeps valid siblings', function () {
      const target = {
        resourceType: 'CodeSystem',
        extension: [
          { url: 'http://example.org/emptied' },
          { url: 'http://example.org/kept', valueString: 'kept' },
        ],
      };
      const messages = repair(target, { resourceType: 'CodeSystem' });

      assert.deepEqual(target.extension, [
        { url: 'http://example.org/kept', valueString: 'kept' },
      ]);
      assert.equal(messages.length, 1);
      assert.match(messages[0].text, /Removed extension\[0\]/);
      assert.match(messages[0].text, /ext-1/);
    });

    it('deletes the array when no extension survives', function () {
      const target = {
        resourceType: 'CodeSystem',
        extension: [{ url: 'http://example.org/emptied', valueMeta: {} }],
      };
      const messages = repair(target, { resourceType: 'CodeSystem' });

      assert.equal('extension' in target, false);
      assert.equal(messages.length, 1);
    });

    it('removes a parent left invalid by the removal of its only child', function () {
      const target = {
        resourceType: 'CodeSystem',
        extension: [{
          url: 'http://example.org/parent',
          extension: [{ url: 'http://example.org/child' }],
        }],
      };
      const messages = repair(target, { resourceType: 'CodeSystem' });

      assert.equal('extension' in target, false);
      assert.equal(messages.length, 2);
      assert.match(text(messages), /Removed extension\[0\]\.extension\[0\]/);
      assert.match(text(messages), /Removed extension\[0\] because/);
    });

    it('keeps an extension represented only by primitive companion metadata', function () {
      const target = {
        resourceType: 'CodeSystem',
        extension: [{
          url: 'http://example.org/companion',
          _valueCode: { extension: [{ url: 'http://example.org/reason', valueCode: 'unknown' }] },
        }],
      };
      const messages = repair(target, { resourceType: 'CodeSystem' });

      assert.equal(target.extension.length, 1);
      assert.deepEqual(messages, []);
    });

    it('treats an id-only complex value as no value', function () {
      const target = {
        resourceType: 'CodeSystem',
        extension: [{ url: 'http://example.org/id-only', valueMeta: { id: 'meta-id' } }],
      };
      const messages = repair(target, { resourceType: 'CodeSystem' });

      assert.equal('extension' in target, false);
      assert.equal(messages.length, 1);
    });

    it('keeps false and zero value choices', function () {
      const target = {
        resourceType: 'CodeSystem',
        extension: [
          { url: 'http://example.org/flag', valueBoolean: false },
          { url: 'http://example.org/count', valueInteger: 0 },
          { url: 'http://example.org/empty-string', valueString: '' },
        ],
      };
      const messages = repair(target, { resourceType: 'CodeSystem' });

      assert.equal(target.extension.length, 3);
      assert.deepEqual(messages, []);
    });

    it('repairs extensions nested under a primitive companion', function () {
      const target = {
        resourceType: 'CodeSystem',
        _status: {
          extension: [
            { url: 'http://example.org/emptied' },
            { url: 'http://example.org/kept', valueCode: 'unknown' },
          ],
        },
      };
      const messages = repair(target, { resourceType: 'CodeSystem' });

      assert.deepEqual(target._status.extension, [
        { url: 'http://example.org/kept', valueCode: 'unknown' },
      ]);
      assert.match(messages[0].text, /Removed _status\.extension\[0\]/);
    });

    it('visits a shared object once without recursing forever', function () {
      const shared = { extension: [{ url: 'http://example.org/emptied' }] };
      const target = { resourceType: 'CodeSystem', first: shared, second: shared };
      target.self = target;
      const messages = repair(target, { resourceType: 'CodeSystem' });

      assert.equal('extension' in shared, false);
      assert.equal(messages.length, 1);
    });
  });
});


