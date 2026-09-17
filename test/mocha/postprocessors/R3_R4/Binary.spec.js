/**
 * Tests for reviewed Binary conversion between STU3 (R3) and R4.
 */
import { strict as assert } from 'node:assert';
import { COVERAGE } from '../../../../src/converter/coverage.js';
import { STATUS } from '../../../../src/converter/diagnostics.js';
import { singleHopConverter } from '../../../../src/converter/singleHopConverter.js';
import { DATA_ABSENT_REASON_URL } from '../../../../src/postprocessors/util/elements.js';
import { conv_R4_to_R3 } from '../../../../src/postprocessors/R3_R4/Binary.js';

const payloadCompanion = {
  extension: [{
    url: 'http://example.org/fhir/StructureDefinition/payload-note',
    valueString: 'Preserved primitive metadata.',
  }],
};

describe('postprocessors/R3_R4 Binary', function () {
  it('renames required R3 content to R4 data completely', function () {
    const source = {
      resourceType: 'Binary',
      id: 'binary-r3',
      contentType: 'application/octet-stream',
      _contentType: { id: 'content-type-id' },
      securityContext: { reference: 'Patient/1' },
      content: 'AAEC',
      _content: payloadCompanion,
    };
    const result = singleHopConverter.convert(source, 'R3', 'R4');

    assert.equal(result.coverage, COVERAGE.COMPLETE);
    assert.equal(result.fml_base_conv.coverage, COVERAGE.COMPLETE);
    assert.equal(result.postprocessors, undefined);
    assert.equal(result.status, STATUS.OK);
    assert.equal(result.resource.data, source.content);
    assert.deepEqual(result.resource._data, payloadCompanion);
    assert.deepEqual(result.resource._contentType, source._contentType);
    assert.deepEqual(result.resource.securityContext, source.securityContext);
    assert.equal('content' in result.resource, false);
  });

  it('renames present R4 data to STU3 content without warning', function () {
    const source = {
      resourceType: 'Binary',
      contentType: 'application/octet-stream',
      securityContext: { reference: 'Patient/1' },
      data: 'AAEC',
      _data: payloadCompanion,
    };
    const result = singleHopConverter.convert(source, 'R4', 'R3');

    assert.equal(result.coverage, COVERAGE.COMPLETE);
    assert.equal(result.fml_base_conv.coverage, COVERAGE.KNOWN_GAPS);
    assert.equal(result.postprocessors[0].name, 'Binary_R4_to_R3');
    assert.equal(result.postprocessors[0].coverage, COVERAGE.COMPLETE);
    assert.equal(result.status, STATUS.OK);
    assert.deepEqual(result.postprocessors[0].messages, []);
    assert.equal(result.resource.content, source.data);
    assert.deepEqual(result.resource._content, payloadCompanion);
    assert.deepEqual(result.resource.securityContext, source.securityContext);
    assert.equal('data' in result.resource, false);
  });

  it('executes the R4 to R3 Meta mapping before postprocessing', function () {
    const metaExtension = {
      url: 'http://example.org/fhir/StructureDefinition/meta-note',
      valueString: 'preserved',
    };
    const source = {
      resourceType: 'Binary',
      contentType: 'application/octet-stream',
      data: 'AAEC',
      meta: {
        id: 'meta-id',
        extension: [metaExtension],
        versionId: 'version-1',
        _versionId: { id: 'version-id-metadata' },
        source: 'http://example.org/source',
        _source: { id: 'source-metadata' },
        profile: [
          'http://hl7.org/fhir/4.0/StructureDefinition/Binary',
          'http://example.org/fhir/StructureDefinition/CustomBinary',
        ],
        _profile: [
          { id: 'base-profile-metadata' },
          { id: 'custom-profile-metadata' },
        ],
        security: [{ system: 'http://example.org/security', code: 'restricted' }],
        tag: [{ system: 'http://example.org/tag', code: 'release-test' }],
      },
    };
    const result = singleHopConverter.convert(source, 'R4', 'R3');

    assert.equal(result.status, STATUS.OK);
    assert.equal(result.resource.meta.id, 'meta-id');
    assert.deepEqual(result.resource.meta.extension, [metaExtension]);
    assert.equal(result.resource.meta.versionId, 'version-1');
    assert.deepEqual(result.resource.meta._versionId, { id: 'version-id-metadata' });
    assert.equal('source' in result.resource.meta, false);
    assert.equal('_source' in result.resource.meta, false);
    assert.deepEqual(result.resource.meta.profile, [
      'http://hl7.org/fhir/3.0/StructureDefinition/Binary',
      'http://example.org/fhir/StructureDefinition/CustomBinary',
    ]);
    assert.deepEqual(result.resource.meta._profile, [
      { id: 'base-profile-metadata' },
      { id: 'custom-profile-metadata' },
    ]);
    assert.deepEqual(result.resource.meta.security, source.meta.security);
    assert.deepEqual(result.resource.meta.tag, source.meta.tag);
  });

  it('marks required STU3 content absent when optional R4 data is missing', function () {
    const source = {
      resourceType: 'Binary',
      contentType: 'text/plain',
    };
    const result = singleHopConverter.convert(source, 'R4', 'R3');

    assert.equal(result.coverage, COVERAGE.COMPLETE);
    assert.equal(result.status, STATUS.WARNING);
    assert.equal('content' in result.resource, false);
    assert.deepEqual(result.resource._content, {
      extension: [{ url: DATA_ABSENT_REASON_URL, valueCode: 'unknown' }],
    });
    assert.match(result.postprocessors[0].messages[0].text, /content is required in STU3/);
    assert.match(result.postprocessors[0].messages[0].text, /rather than inventing binary data/);
  });

  it('preserves an extension-only R4 payload without adding another reason', function () {
    const source = {
      resourceType: 'Binary',
      contentType: 'text/plain',
      _data: payloadCompanion,
    };
    const result = singleHopConverter.convert(source, 'R4', 'R3');

    assert.equal(result.status, STATUS.OK);
    assert.equal('content' in result.resource, false);
    assert.deepEqual(result.resource._content, payloadCompanion);
    assert.deepEqual(result.postprocessors[0].messages, []);
  });

  it('adds an extension beside an id-only companion because id does not satisfy ele-1', function () {
    const target = {
      resourceType: 'Binary',
      contentType: 'text/plain',
      _content: { id: 'content-id' },
    };
    const result = conv_R4_to_R3.execute(target, {});

    assert.equal(result.status, STATUS.WARNING);
    assert.equal(target._content.id, 'content-id');
    assert.deepEqual(target._content.extension, [
      { url: DATA_ABSENT_REASON_URL, valueCode: 'unknown' },
    ]);
  });
});
