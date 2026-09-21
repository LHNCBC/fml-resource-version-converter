/**
 * Tests for the shared R4 -> R3 Meta and Extension validity repair.
 *
 * The reviewed R4 -> R3 postprocessors delegate to this helper, so its
 * behavior is exercised here once rather than in each resource-type spec.
 */
import { strict as assert } from 'node:assert';
import { MESSAGE_TYPE } from '../../../../src/converter/diagnostics.js';
import { repairR4ToR3MetaAndExtensions } from '../../../../src/postprocessors/R3_R4/metaExtensions.js';
import { DATA_ABSENT_REASON_URL } from '../../../../src/postprocessors/util/elements.js';

const unsupported = { url: DATA_ABSENT_REASON_URL, valueCode: 'unsupported' };

/** Build an ordinary extension whose Meta value cannot survive in STU3. */
function sourceOnlyExtension() {
  return {
    url: 'http://example.org/meta',
    valueMeta: { source: 'http://example.org/source' },
  };
}

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

    it('strips reconstructed source and _source without duplicating the loss diagnostic', function () {
      const source = {
        resourceType: 'Library',
        author: [{
          name: 'Author',
          extension: [{
            ...sourceOnlyExtension(),
            valueMeta: {
              id: 'meta-id',
              source: 'http://example.org/source',
              _source: { extension: [{ url: 'http://example.org/note', valueString: 'note' }] },
              profile: ['http://example.org/profile'],
              security: [{ code: 'restricted' }],
              tag: [{ code: 'kept' }],
            },
          }],
        }],
      };
      const before = structuredClone(source);
      const target = {
        resourceType: 'Library',
        contributor: [{ type: 'author', ...structuredClone(source.author[0]) }],
      };
      const messages = repair(target, source);

      assert.deepEqual(target.contributor[0].extension[0].valueMeta, {
        id: 'meta-id',
        profile: ['http://example.org/profile'],
        security: [{ code: 'restricted' }],
        tag: [{ code: 'kept' }],
      });
      assert.equal(messages.length, 1);
      assert.match(text(messages), /author\[0\]\.extension\[0\]\.valueMeta\.source/);
      assert.deepEqual(source, before);
    });

    it('strips a companion-only Meta source before cascading nested extension removal', function () {
      const source = {
        resourceType: 'Library',
        extension: [{
          url: 'http://example.org/outer',
          extension: [{
            url: 'http://example.org/inner',
            valueMeta: {
              id: 'meta-id',
              _source: { extension: [{ url: 'http://example.org/note', valueString: 'note' }] },
            },
          }],
        }],
      };
      const target = structuredClone(source);
      const messages = repair(target, source);

      assert.equal('extension' in target, false);
      assert.equal(messages.length, 3);
      assert.equal(messages.filter(message => /were dropped/.test(message.text)).length, 1);
      assert.match(text(messages), /Removed extension\[0\]\.extension\[0\]/);
      assert.match(text(messages), /Removed extension\[0\] because/);
    });

    it('reports target Meta loss when no original source was supplied', function () {
      const target = { resourceType: 'Library', extension: [sourceOnlyExtension()] };
      const messages = repair(target);

      assert.equal('extension' in target, false);
      assert.match(text(messages), /valueMeta\.source/);
      assert.match(text(messages), /ext-1/);
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

      assert.deepEqual(shared.extension, [unsupported]);
      assert.equal(messages.length, 2);
    });
  });

  describe('enclosing element validity', function () {
    for (const id of [undefined, 'identifier-id']) {
      it(`marks an emptied Identifier absent${id ? ' while preserving its id' : ''}`, function () {
        const identifier = { extension: [sourceOnlyExtension()] };
        if (id) identifier.id = id;
        const source = { resourceType: 'CodeSystem', identifier };
        const target = structuredClone(source);
        const messages = repair(target, source);

        assert.deepEqual(target.identifier, {
          ...(id ? { id } : {}),
          extension: [unsupported],
        });
        assert.match(text(messages), /identifier became empty.*ele-1/);
        assert.deepEqual(repair(target), []);
      });
    }

    it('preserves an extension-only required primitive occurrence', function () {
      const source = {
        resourceType: 'Binary',
        _content: { id: 'content-id', extension: [sourceOnlyExtension()] },
      };
      const target = structuredClone(source);
      const messages = repair(target, source);

      assert.deepEqual(target._content, { id: 'content-id', extension: [unsupported] });
      assert.match(text(messages), /_content became empty.*ele-1/);
    });

    it('removes empty scalar companions but keeps ids when the value survives', function () {
      const target = {
        resourceType: 'CodeSystem',
        status: 'active',
        _status: { extension: [sourceOnlyExtension()] },
        experimental: false,
        _experimental: { extension: [sourceOnlyExtension()] },
        count: 0,
        _count: { id: 'count-id', extension: [sourceOnlyExtension()] },
      };
      const messages = repair(target, structuredClone(target));

      assert.equal('_status' in target, false);
      assert.equal('_experimental' in target, false);
      assert.deepEqual(target._count, { id: 'count-id' });
      assert.equal(target.status, 'active');
      assert.equal(target.experimental, false);
      assert.equal(target.count, 0);
      assert.doesNotMatch(text(messages), /became empty/);
    });

    it('preserves repeating primitive indexes and marks only valueless occurrences absent', function () {
      const kept = { extension: [{ url: 'http://example.org/note', valueString: 'kept' }] };
      const source = {
        resourceType: 'CodeSystem',
        meta: {
          profile: ['http://example.org/one', null, 'http://example.org/three', 'http://example.org/four'],
          _profile: [
            { extension: [sourceOnlyExtension()] },
            { id: 'absent-id', extension: [sourceOnlyExtension()] },
            { id: 'retained-id', extension: [sourceOnlyExtension()] },
            kept,
          ],
        },
      };
      const target = structuredClone(source);
      repair(target, source);

      assert.deepEqual(target.meta.profile, source.meta.profile);
      assert.deepEqual(target.meta._profile, [
        null,
        { id: 'absent-id', extension: [unsupported] },
        { id: 'retained-id' },
        kept,
      ]);
    });

    it('omits an all-null companion array after removal without changing the values', function () {
      const target = {
        resourceType: 'CodeSystem',
        meta: {
          profile: ['http://example.org/one', 'http://example.org/two'],
          _profile: [{ extension: [sourceOnlyExtension()] }, null],
        },
      };
      repair(target, structuredClone(target));

      assert.equal('_profile' in target.meta, false);
      assert.deepEqual(target.meta.profile, ['http://example.org/one', 'http://example.org/two']);
    });

    it('removes an Extension with emptied primitive metadata instead of inventing its value', function () {
      const target = {
        resourceType: 'CodeSystem',
        extension: [{
          url: 'http://example.org/outer',
          _valueString: { id: 'value-id', extension: [sourceOnlyExtension()] },
        }],
      };
      const messages = repair(target, structuredClone(target));

      assert.equal('extension' in target, false);
      assert.doesNotMatch(text(messages), /became empty/);
    });

    it('does not blanket-repair unrelated pre-existing empty elements', function () {
      const target = { resourceType: 'CodeSystem', identifier: {}, _status: { id: 'id-only' } };
      const before = structuredClone(target);

      assert.deepEqual(repair(target), []);
      assert.deepEqual(target, before);
    });

    it('leaves contained resource metadata untouched and does not report it as lost', function () {
      const source = {
        resourceType: 'Library',
        contained: [{
          resourceType: 'CodeSystem',
          id: 'contained',
          meta: { source: 'http://example.org/contained' },
          extension: [sourceOnlyExtension()],
        }],
      };
      const target = structuredClone(source);

      assert.deepEqual(repair(target, source), []);
      assert.deepEqual(target, source);
    });
  });
});


