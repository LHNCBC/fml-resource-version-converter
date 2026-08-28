import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { zlibSync } from 'fflate';
import {
  decodeArtifact,
  decodeBase64,
  decodeTrustedArtifact,
  sha256Hex,
} from '../../../src/runtime/decode.js';
import {
  ARTIFACT_KIND,
  SCHEMA_VERSION,
} from '../../../src/runtime/schema.js';
import {
  createArtifactEnvelope,
  encodeBase64,
} from '../../../tools/runtime-artifacts-lib.js';

/**
 * Return a minimal valid FHIR tables payload.
 *
 * @returns {Object} Table payload.
 */
function tablePayload() {
  return {
    schemaVersion: SCHEMA_VERSION.FHIR_TABLE,
    fhirVersion: 'R4',
    polyPaths: { 'Observation.value': ['Quantity', 'string'] },
    arrayPaths: ['Patient.name'],
    elementTypes: { 'Patient.gender': 'code' },
    resourceTypes: ['Observation', 'Patient'],
  };
}

/**
 * Create a valid table artifact envelope.
 *
 * @returns {Object} Artifact envelope.
 */
function tableEnvelope() {
  return createArtifactEnvelope({
    id: 'fhir-tables/R4',
    kind: ARTIFACT_KIND.FHIR_TABLE,
    sourceIds: ['hl7-fhir-R4'],
    data: tablePayload(),
  }).envelope;
}

describe('runtime/decode: portable primitives', function () {
  it('matches Node SHA-256 for empty, ASCII, Unicode, and binary input', function () {
    const inputs = [
      new Uint8Array(),
      new TextEncoder().encode('abc'),
      new TextEncoder().encode('FHIR \u2192 canonical bytes'),
      Uint8Array.from({ length: 257 }, (_, index) => index & 0xff),
    ];

    for (const input of inputs) {
      const expected = createHash('sha256').update(input).digest('hex');

      assert.equal(sha256Hex(input), expected);
    }
  });

  it('round-trips canonical Base64 without Buffer', function () {
    const originalBuffer = globalThis.Buffer;
    const bytes = Uint8Array.from([0, 1, 2, 127, 128, 254, 255]);

    try {
      globalThis.Buffer = undefined;
      assert.deepEqual(decodeBase64(encodeBase64(bytes), 'test/base64'), bytes);
    } finally {
      globalThis.Buffer = originalBuffer;
    }
  });
});

describe('runtime/decode: artifacts', function () {
  it('decodes and validates a generated artifact', function () {
    const decoded = decodeArtifact(tableEnvelope());

    assert.equal(decoded.id, 'fhir-tables/R4');
    assert.deepEqual(decoded.data, tablePayload());
    assert.ok(Object.isFrozen(decoded));
  });

  it('names the artifact for misleading or unsupported codec identifiers', function () {
    for (const codec of ['deflate', 'gzip']) {
      const envelope = { ...tableEnvelope(), codec };

      assert.throws(
        () => decodeArtifact(envelope),
        new RegExp(`fhir-tables/R4.*unsupported codec "${codec}"`),
      );
    }
  });

  it('rejects decoded-length and hash mismatches', function () {
    const envelope = tableEnvelope();

    assert.throws(
      () => decodeArtifact({ ...envelope, uncompressedLength: envelope.uncompressedLength + 1 }),
      /fhir-tables\/R4.*decoded length/,
    );
    assert.throws(
      () => decodeArtifact({ ...envelope, sha256: '0'.repeat(64) }),
      /fhir-tables\/R4.*SHA-256/,
    );
  });

  it('rejects valid JSON that is not in canonical form', function () {
    const canonical = createArtifactEnvelope({
      id: 'fhir-tables/R4',
      kind: ARTIFACT_KIND.FHIR_TABLE,
      sourceIds: ['hl7-fhir-R4'],
      data: tablePayload(),
    }).canonicalJson;
    const nonCanonical = canonical.replace('{', '{ ');
    const bytes = new TextEncoder().encode(nonCanonical);
    const envelope = {
      ...tableEnvelope(),
      uncompressedLength: bytes.length,
      sha256: sha256Hex(bytes),
      payload: encodeBase64(zlibSync(bytes, { level: 9 })),
    };

    assert.throws(() => decodeArtifact(envelope), /fhir-tables\/R4.*not canonical JSON/);
  });

  it('trusts package-owned hash and canonical encoding after publication validation', function () {
    const text = JSON.stringify(tablePayload(), null, 2);
    const bytes = new TextEncoder().encode(text);
    const envelope = {
      ...tableEnvelope(),
      uncompressedLength: bytes.length,
      sha256: '0'.repeat(64),
      payload: encodeBase64(zlibSync(bytes, { level: 9 })),
    };

    assert.deepEqual(decodeTrustedArtifact(envelope).data, tablePayload());
  });
});
