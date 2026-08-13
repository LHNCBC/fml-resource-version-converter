/**
 * Tests for reviewed Binary conversion between DSTU2 (R2) and STU3 (R3).
 */
import { strict as assert } from 'node:assert';
import { COVERAGE } from '../../../../src/converter/coverage.js';
import { STATUS } from '../../../../src/converter/diagnostics.js';
import { singleHopConverter } from '../../../../src/converter/singleHopConverter.js';

const payloadCompanion = {
  extension: [{
    url: 'http://example.org/fhir/StructureDefinition/payload-note',
    valueString: 'Preserved primitive metadata.',
  }],
};

describe('postprocessors/R2_R3 Binary', function () {
  it('converts R2 -> R3 completely without a postprocessor', function () {
    const source = {
      resourceType: 'Binary',
      id: 'binary-r2',
      meta: { tag: [{ system: 'http://example.org/tags', code: 'reviewed' }] },
      contentType: 'text/plain',
      _contentType: { id: 'content-type-id' },
      content: 'SGVsbG8=',
      _content: payloadCompanion,
    };
    const result = singleHopConverter.convert(source, 'R2', 'R3');

    assert.equal(result.coverage, COVERAGE.COMPLETE);
    assert.equal(result.fml_base_conv.coverage, COVERAGE.COMPLETE);
    assert.equal(result.postprocessors, undefined);
    assert.equal(result.status, STATUS.OK);
    assert.equal(result.resource.content, source.content);
    assert.deepEqual(result.resource._content, payloadCompanion);
    assert.deepEqual(result.resource._contentType, source._contentType);
    assert.deepEqual(result.resource.meta.profile, [
      'http://hl7.org/fhir/3.0/StructureDefinition/Binary',
    ]);
    assert.deepEqual(result.resource.meta.tag, source.meta.tag);
  });

  it('reports securityContext loss in R3 -> R2', function () {
    const source = {
      resourceType: 'Binary',
      contentType: 'application/pdf',
      securityContext: { reference: 'Patient/1' },
      content: 'JVBERi0=',
      _content: payloadCompanion,
    };
    const result = singleHopConverter.convert(source, 'R3', 'R2');

    assert.equal(result.coverage, COVERAGE.BEST_EFFORT);
    assert.equal(result.fml_base_conv.coverage, COVERAGE.KNOWN_GAPS);
    assert.equal(result.postprocessors[0].name, 'Binary_R3_to_R2');
    assert.equal(result.postprocessors[0].coverage, COVERAGE.BEST_EFFORT);
    assert.equal(result.status, STATUS.WARNING);
    assert.equal('securityContext' in result.resource, false);
    assert.equal(result.resource.content, source.content);
    assert.deepEqual(result.resource._content, payloadCompanion);
    assert.match(result.postprocessors[0].messages[0].text, /securityContext.*dropped/s);
  });

  it('converts R3 -> R2 without warning when securityContext is absent', function () {
    const source = {
      resourceType: 'Binary',
      contentType: 'text/plain',
      content: 'SGVsbG8=',
    };
    const result = singleHopConverter.convert(source, 'R3', 'R2');

    assert.equal(result.status, STATUS.OK);
    assert.deepEqual(result.postprocessors[0].messages, []);
    assert.equal(result.resource.content, source.content);
    assert.deepEqual(result.resource.meta.profile, [
      'http://hl7.org/fhir/1.0/StructureDefinition/Binary',
    ]);
  });

  it('reports an extension-only securityContext', function () {
    const source = {
      resourceType: 'Binary',
      contentType: 'text/plain',
      content: 'SGVsbG8=',
      securityContext: {
        extension: [{
          url: 'http://example.org/fhir/StructureDefinition/security-label',
          valueString: 'restricted',
        }],
      },
    };
    const result = singleHopConverter.convert(source, 'R3', 'R2');

    assert.equal(result.status, STATUS.WARNING);
    assert.match(result.postprocessors[0].messages[0].text, /securityContext/);
  });
});
