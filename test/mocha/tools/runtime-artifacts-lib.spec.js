import assert from 'node:assert/strict';
import {
  compactConceptMap,
  encodeBase64,
  renderArtifactModule,
  createArtifactEnvelope,
} from '../../../tools/runtime-artifacts-lib.js';
import {
  ARTIFACT_KIND,
  SCHEMA_VERSION,
} from '../../../src/runtime/schema.js';

describe('tools/runtime-artifacts-lib', function () {
  it('encodes RFC 4648 Base64 vectors', function () {
    const encoder = new TextEncoder();
    const vectors = [
      ['', ''],
      ['f', 'Zg=='],
      ['fo', 'Zm8='],
      ['foo', 'Zm9v'],
      ['foobar', 'Zm9vYmFy'],
    ];

    for (const [plain, encoded] of vectors) {
      assert.equal(encodeBase64(encoder.encode(plain)), encoded);
    }
  });

  it('preserves translator semantics and declaration duplicates in compact ConceptMaps', function () {
    const url = 'http://hl7.org/fhir/uv/xver/ConceptMap/example';
    const compact = compactConceptMap({
      url,
      status: 'active',
      group: [{
        sourceUri: 'source-system',
        targetUri: 'target-system',
        unmapped: { mode: 'fixed', code: 'fallback', extension: [{}] },
        element: [{
          code: 'source',
          target: [
            { code: 'target', display: 'Target', equivalence: 'equivalent' },
            { code: 'target', relationship: 'related-to' },
            { display: 'ignored without code' },
          ],
        }, {
          code: 'source',
          noMap: true,
        }, {
          display: 'ignored without code',
        }],
      }],
    }, 'codes/ConceptMap-example.json', url);

    assert.deepEqual(compact, {
      virtualFile: 'codes/ConceptMap-example.json',
      url,
      groups: [{
        source: 'source-system',
        target: 'target-system',
        unmapped: { mode: 'fixed', code: 'fallback' },
        elements: [{
          code: 'source',
          targets: [
            { code: 'target', display: 'Target', relationship: 'equivalent' },
            { code: 'target', relationship: 'related-to' },
          ],
        }, {
          code: 'source',
          noMap: true,
          targets: [],
        }],
      }],
    });
  });

  it('rejects a ConceptMap whose canonical identity does not match the FML reference', function () {
    assert.throws(
      () => compactConceptMap(
        { url: 'http://example.test/wrong' },
        'codes/ConceptMap-example.json',
        'http://example.test/expected',
      ),
      /identity.*does not match reference/,
    );
  });

  it('renders dependency-free artifact modules', function () {
    const data = {
      schemaVersion: SCHEMA_VERSION.FHIR_TABLE,
      fhirVersion: 'R4',
      polyPaths: {},
      arrayPaths: [],
      elementTypes: {},
      resourceTypes: [],
    };
    const { envelope } = createArtifactEnvelope({
      id: 'fhir-tables/R4',
      kind: ARTIFACT_KIND.FHIR_TABLE,
      sourceIds: ['hl7-fhir-R4'],
      data,
    });
    const moduleSource = renderArtifactModule(envelope);

    assert.doesNotMatch(moduleSource, /\bimport\b|\brequire\s*\(/);
    assert.match(moduleSource, /export default Object\.freeze\(artifact\)/);
  });
});
