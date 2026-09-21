/**
 * Tests for reviewed Binary conversion between R4 and R5.
 */
import { strict as assert } from 'node:assert';
import { COVERAGE } from '../../../../src/converter/coverage.js';
import { STATUS } from '../../../../src/converter/diagnostics.js';
import { singleHopConverter } from '../../../../src/converter/singleHopConverter.js';

const binary = {
  resourceType: 'Binary',
  id: 'binary-r4-r5',
  meta: { tag: [{ system: 'http://example.org/tags', code: 'reviewed' }] },
  implicitRules: 'http://example.org/fhir/Rules/binary',
  language: 'en-US',
  contentType: 'application/pdf',
  _contentType: { id: 'content-type-id' },
  securityContext: { reference: 'Patient/1' },
  data: 'JVBERi0=',
  _data: {
    extension: [{
      url: 'http://example.org/fhir/StructureDefinition/payload-note',
      valueString: 'Preserved primitive metadata.',
    }],
  },
};

describe('postprocessors/R4_R5 Binary', function () {
  for (const [fromVer, toVer, profileVersion] of [
    ['R4', 'R5', '5.0'],
    ['R5', 'R4', '4.0'],
  ]) {
    it(`converts ${fromVer} -> ${toVer} completely without a postprocessor`, function () {
      const result = singleHopConverter.convert(binary, fromVer, toVer);

      assert.equal(result.coverage, COVERAGE.COMPLETE);
      assert.equal(result.fml_base_conv.coverage, COVERAGE.COMPLETE);
      assert.equal(result.postprocessors, undefined);
      assert.equal(result.status, STATUS.OK);
      for (const field of [
        'id', 'implicitRules', 'language', 'contentType', 'data',
      ]) {
        assert.equal(result.resource[field], binary[field], `lost ${field}`);
      }
      assert.deepEqual(result.resource._contentType, binary._contentType);
      assert.deepEqual(result.resource._data, binary._data);
      assert.deepEqual(result.resource.securityContext, binary.securityContext);
      assert.deepEqual(result.resource.meta.tag, binary.meta.tag);
      assert.deepEqual(result.resource.meta.profile, [
        `http://hl7.org/fhir/${profileVersion}/StructureDefinition/Binary`,
      ]);
    });
  }

  it('preserves an extension-only payload in both directions', function () {
    const source = {
      resourceType: 'Binary',
      contentType: 'text/plain',
      _data: binary._data,
    };

    for (const [fromVer, toVer] of [['R4', 'R5'], ['R5', 'R4']]) {
      const result = singleHopConverter.convert(source, fromVer, toVer);
      assert.equal('data' in result.resource, false);
      assert.deepEqual(result.resource._data, source._data);
      assert.equal(result.status, STATUS.OK);
    }
  });
});
