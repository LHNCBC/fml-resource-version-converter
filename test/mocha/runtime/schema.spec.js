/**
 * Runtime artifact and assembled-data schema tests.
 */

import { strict as assert } from 'node:assert';
import {
  ARTIFACT_KIND,
  SCHEMA_VERSION,
  canonicalStringify,
  validateArtifactEnvelope,
  validateFhirTablePayload,
  validateFmlMappingsPayload,
  validateManifest,
  validateRuntimeData,
  validateRuntimeDataSelection,
} from '../../../src/runtime/schema.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

/**
 * Build a valid compact FML mappings payload.
 *
 * @param {Object} [overrides] Top-level overrides.
 * @returns {Object} Payload fixture.
 */
function fmlPayload(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION.FML_MAPPINGS,
    direction: { from: 'R4', to: 'R5' },
    files: {
      'R4toR5/Patient4to5.fml': 'map "http://example.test/Patient4to5" = Patient4to5\n',
    },
    mappings: [{
      virtualFile: 'R4toR5/Patient4to5.fml',
      structureMapUrl: 'http://example.test/Patient4to5',
      structureMapName: 'Patient4to5',
      entryGroup: 'Patient',
      sourceResourceType: 'Patient',
      sourceProfile: 'http://hl7.org/fhir/4.0/StructureDefinition/Patient',
      targetResourceType: 'Patient',
      targetProfile: 'http://hl7.org/fhir/5.0/StructureDefinition/Patient',
    }],
    conceptMaps: [{
      virtualFile: 'codes/ConceptMap-example-4to5.json',
      url: 'http://example.test/ConceptMap/example-4to5',
      groups: [{
        source: 'http://example.test/source',
        target: 'http://example.test/target',
        elements: [{
          code: 'source-code',
          targets: [{
            code: 'target-code',
            display: 'Target code',
            relationship: 'equivalent',
          }],
        }, {
          code: 'source-code',
          noMap: true,
          targets: [],
        }],
        unmapped: { mode: 'provided' },
      }],
    }],
    ...overrides,
  };
}

/**
 * Build a valid FHIR table payload.
 *
 * @param {string} fhirVersion Table version.
 * @returns {Object} Payload fixture.
 */
function tablePayload(fhirVersion = 'R4') {
  return {
    schemaVersion: SCHEMA_VERSION.FHIR_TABLE,
    fhirVersion,
    polyPaths: {
      'Observation.value': ['Quantity', 'string'],
    },
    arrayPaths: ['Bundle.entry', 'Patient.name'],
    elementTypes: {
      'Patient.gender': 'code',
    },
    resourceTypes: ['Observation', 'Patient'],
  };
}

/**
 * Build a decoded artifact reference.
 *
 * @param {string} id Artifact identity.
 * @param {string} kind Artifact kind.
 * @param {Object} data Decoded payload.
 * @param {string} [sha256=HASH_A] Content digest.
 * @returns {Object} Decoded artifact fixture.
 */
function decodedArtifact(id, kind, data, sha256 = HASH_A) {
  return { id, kind, sha256, data };
}

/**
 * Build valid directional runtime data.
 *
 * @param {Object} [overrides] Top-level overrides.
 * @returns {Object} Runtime data fixture.
 */
function runtimeData(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION.RUNTIME_DATA,
    id: 'runtime/r4-to-r5',
    mappingArtifacts: [decodedArtifact(
      'fml-mappings/R4toR5',
      ARTIFACT_KIND.FML_MAPPINGS,
      fmlPayload(),
    )],
    fhirTableArtifacts: [
      decodedArtifact('fhir-tables/R4', ARTIFACT_KIND.FHIR_TABLE, tablePayload('R4')),
      decodedArtifact('fhir-tables/R5', ARTIFACT_KIND.FHIR_TABLE, tablePayload('R5')),
    ],
    fhirPathModels: [{
      modelId: 'fhirpath/r4',
      sourceVersions: ['R4'],
      model: { version: 'r4' },
    }],
    ...overrides,
  };
}

describe('runtime/schema: canonicalStringify', function () {
  it('sorts object keys recursively and preserves array order', function () {
    const actual = canonicalStringify({ z: 1, a: { y: 2, x: [3, 1] } });

    assert.equal(actual, '{"a":{"x":[3,1],"y":2},"z":1}');
  });

  it('rejects values JSON.stringify would silently coerce', function () {
    assert.throws(() => canonicalStringify({ value: undefined }), /JSON-compatible/);
    assert.throws(() => canonicalStringify([, 1]), /sparse array/);
    assert.throws(() => canonicalStringify(Number.NaN), /finite number/);
  });

  it('rejects cyclic data', function () {
    const value = {};
    value.self = value;

    assert.throws(() => canonicalStringify(value), /cycle/);
  });
});

describe('runtime/schema: artifact envelope', function () {
  const envelope = {
    schemaVersion: SCHEMA_VERSION.ARTIFACT,
    id: 'fml-mappings/R4toR5',
    kind: ARTIFACT_KIND.FML_MAPPINGS,
    codec: 'candidate-codec',
    uncompressedLength: 123,
    sha256: HASH_A,
    sourceIds: ['hl7-fhir-cross-version'],
    payload: 'YWJj',
  };

  it('accepts a dependency-free data envelope', function () {
    assert.equal(validateArtifactEnvelope(envelope), envelope);
  });

  it('names the logical artifact in validation errors', function () {
    assert.throws(
      () => validateArtifactEnvelope({ ...envelope, schemaVersion: 99 }),
      /Runtime artifact "fml-mappings\/R4toR5".*schemaVersion.*received 99/,
    );
  });

  it('rejects malformed Base64 and unknown fields', function () {
    assert.throws(() => validateArtifactEnvelope({ ...envelope, payload: 'abc?' }), /Base64/);
    assert.throws(() => validateArtifactEnvelope({ ...envelope, extra: true }), /not supported/);
  });
});

describe('runtime/schema: FML mappings payload', function () {
  it('accepts translator fields while preserving duplicate source codes', function () {
    const payload = fmlPayload();

    assert.equal(validateFmlMappingsPayload(payload, 'fml-mappings/R4toR5'), payload);
  });

  it('rejects an unsupported direction', function () {
    const payload = fmlPayload({ direction: { from: 'R4', to: 'R4B' } });

    assert.throws(() => validateFmlMappingsPayload(payload, 'map'), /unsupported direction/);
  });

  it('rejects a descriptor whose virtual FML file is missing', function () {
    const payload = fmlPayload();
    payload.mappings[0].virtualFile = 'R4toR5/Missing.fml';

    assert.throws(() => validateFmlMappingsPayload(payload, 'map'), /references missing FML file/);
  });

  it('rejects duplicate ConceptMap identities', function () {
    const payload = fmlPayload();
    payload.conceptMaps.push(structuredClone(payload.conceptMaps[0]));

    assert.throws(() => validateFmlMappingsPayload(payload, 'map'), /duplicates/);
  });
});

describe('runtime/schema: FHIR table payload', function () {
  it('accepts all four engine tables', function () {
    const payload = tablePayload();

    assert.equal(validateFhirTablePayload(payload, 'fhir-tables/R4'), payload);
  });

  it('rejects an unsupported table version', function () {
    const payload = { ...tablePayload(), fhirVersion: 'R6' };

    assert.throws(() => validateFhirTablePayload(payload, 'table'), /not a supported/);
  });

  it('requires deterministic ordering for set-like arrays', function () {
    const payload = { ...tablePayload(), arrayPaths: ['Patient.name', 'Bundle.entry'] };

    assert.throws(() => validateFhirTablePayload(payload, 'table'), /sorted lexically/);
  });
});

describe('runtime/schema: manifest', function () {
  const manifest = {
    schemaVersion: SCHEMA_VERSION.MANIFEST,
    generator: { name: 'build-runtime-data', version: '1' },
    format: {
      canonicalJson: 'sorted-object-keys-v1',
      payloadEncoding: 'base64',
      hash: 'sha256',
      compression: {
        codec: 'zlib',
        implementation: 'fflate',
        implementationVersion: '0.8.3',
        level: 9,
      },
    },
    sources: [{
      id: 'hl7-fhir-cross-version',
      uri: 'https://github.com/HL7/fhir-cross-version',
      commit: '72779598c1bbfffbfd99a901938af495ddd91ff1',
      date: '2026-02-24',
      license: 'HL7',
      sha256: HASH_A,
    }],
    artifacts: [{
      id: 'fml-mappings/R4toR5',
      kind: ARTIFACT_KIND.FML_MAPPINGS,
      modulePath: 'fml-mappings/R4toR5.js',
      codec: 'candidate-codec',
      uncompressedLength: 123,
      sha256: HASH_B,
      sourceIds: ['hl7-fhir-cross-version'],
      counts: { conceptMaps: 1, fmlFiles: 1, mappings: 1 },
    }],
  };

  it('accepts attributable artifact metadata', function () {
    assert.equal(validateManifest(manifest), manifest);
  });

  it('rejects an artifact referencing an unknown source', function () {
    const candidate = structuredClone(manifest);
    candidate.artifacts[0].sourceIds = ['missing-source'];

    assert.throws(() => validateManifest(candidate), /unknown source/);
  });

  it('rejects duplicate artifact identities', function () {
    const candidate = structuredClone(manifest);
    candidate.artifacts.push({
      ...candidate.artifacts[0],
      modulePath: 'fml-mappings/duplicate.js',
    });

    assert.throws(() => validateManifest(candidate), /duplicates/);
  });
});

describe('runtime/schema: assembled runtime data', function () {
  it('accepts a complete directional selection', function () {
    const value = runtimeData();

    assert.equal(validateRuntimeData(value), value);
  });

  it('requires both FHIR tables used by a direction', function () {
    const value = runtimeData();
    value.fhirTableArtifacts.pop();

    assert.throws(() => validateRuntimeData(value), /requires FHIR table R5/);
  });

  it('requires the source-version FHIRPath model', function () {
    const value = runtimeData({ fhirPathModels: [] });

    assert.throws(() => validateRuntimeData(value), /requires a source model for R4/);
  });

  it('deduplicates exact artifacts by contract and rejects hash conflicts', function () {
    const first = runtimeData();
    const second = runtimeData({ id: 'runtime/second-r4-to-r5' });
    second.fhirPathModels[0].model = first.fhirPathModels[0].model;

    assert.equal(validateRuntimeDataSelection([first, second]).length, 2);

    second.mappingArtifacts[0] = {
      ...second.mappingArtifacts[0],
      sha256: HASH_B,
    };
    assert.throws(
      () => validateRuntimeDataSelection([first, second]),
      /conflicting hashes for artifact "fml-mappings\/R4toR5"/,
    );
  });

  it('rejects conflicting artifacts for one logical direction', function () {
    const first = runtimeData();
    const second = runtimeData({ id: 'runtime/second-r4-to-r5' });
    second.mappingArtifacts[0] = {
      ...second.mappingArtifacts[0],
      id: 'fml-mappings/alternate-R4toR5',
      sha256: HASH_B,
    };

    assert.throws(
      () => validateRuntimeDataSelection([first, second]),
      /conflicting artifacts for direction R4->R5/,
    );
  });

  it('rejects an empty module selection', function () {
    assert.throws(() => validateRuntimeDataSelection([]), /must not be empty/);
  });
});
