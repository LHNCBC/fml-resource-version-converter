/**
 * @fileoverview Pure helpers for deterministic runtime artifact generation.
 *
 * Keep filesystem discovery and publication in runtime-data-generator.js so
 * these transformations can be tested with ordinary objects and byte arrays.
 *
 * @module tools/runtime-artifacts-lib
 */

import { zlibSync } from 'fflate';
import { sha256Hex } from '../src/runtime/decode.js';
import {
  ARTIFACT_CODEC,
  ARTIFACT_KIND,
  canonicalStringify,
  SCHEMA_VERSION,
  validateArtifactEnvelope,
  validateFhirTablePayload,
  validateFmlMappingsPayload,
} from '../src/runtime/schema.js';
import { countArtifactItems } from './runtime-root-validation.js';

export { ARTIFACT_CODEC };
export const COMPRESSION_LEVEL = 9;
export const GENERATOR_NAME = 'build-runtime-data';
export const GENERATOR_VERSION = '1';

/**
 * Return an object containing only defined properties.
 *
 * @param {Object} value Candidate properties.
 * @returns {Object} Compact object.
 */
function definedProperties(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

/**
 * Encode bytes as canonical Base64 without using Buffer.
 *
 * @param {Uint8Array} bytes Bytes to encode.
 * @returns {string} Canonical padded Base64.
 */
export function encodeBase64(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('Base64 input must be a Uint8Array');
  }

  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const parts = [];
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const hasSecond = index + 1 < bytes.length;
    const hasThird = index + 2 < bytes.length;
    const second = hasSecond ? bytes[index + 1] : 0;
    const third = hasThird ? bytes[index + 2] : 0;
    const word = (first << 16) | (second << 8) | third;

    parts.push(
      alphabet[(word >>> 18) & 63],
      alphabet[(word >>> 12) & 63],
      hasSecond ? alphabet[(word >>> 6) & 63] : '=',
      hasThird ? alphabet[word & 63] : '=',
    );
  }

  return parts.join('');
}

/**
 * Distill one source ConceptMap to the fields consumed by the translator.
 *
 * Elements and targets lacking codes are omitted because the translator also
 * ignores them. Valid declaration order and duplicates are preserved.
 *
 * @param {Object} conceptMap Parsed source ConceptMap.
 * @param {string} virtualFile Source-relative filename for diagnostics.
 * @param {string} expectedUrl Canonical URL referenced by the FML files.
 * @returns {Object} Compact ConceptMap payload value.
 */
export function compactConceptMap(conceptMap, virtualFile, expectedUrl) {
  if (conceptMap === null || typeof conceptMap !== 'object' || Array.isArray(conceptMap)) {
    throw new Error(`ConceptMap ${virtualFile}: source must be an object`);
  }

  const url = conceptMap.url || conceptMap.id;
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error(`ConceptMap ${virtualFile}: source is missing url/id`);
  }
  if (url !== expectedUrl) {
    throw new Error(
      `ConceptMap ${virtualFile}: identity "${url}" does not match reference "${expectedUrl}"`,
    );
  }

  return {
    virtualFile,
    url,
    groups: (Array.isArray(conceptMap.group) ? conceptMap.group : []).map(group => {
      const elements = (Array.isArray(group?.element) ? group.element : [])
        .filter(element => typeof element?.code === 'string' && element.code.length > 0)
        .map(element => definedProperties({
          code: element.code,
          noMap: element.noMap === true ? true : undefined,
          targets: (Array.isArray(element.target) ? element.target : [])
            .filter(target => typeof target?.code === 'string' && target.code.length > 0)
            .map(target => definedProperties({
              code: target.code,
              display: target.display,
              relationship: target.relationship || target.equivalence,
            })),
        }));

      return definedProperties({
        source: group?.source || group?.sourceUri,
        target: group?.target || group?.targetUri,
        unmapped: group?.unmapped ? definedProperties({
          mode: group.unmapped.mode,
          code: group.unmapped.code,
          display: group.unmapped.display,
          url: group.unmapped.url,
        }) : undefined,
        elements,
      });
    }),
  };
}

/**
 * Create a canonical FML mappings payload from collected source values.
 *
 * @param {Object} options Payload parts.
 * @param {{from: string, to: string}} options.direction Version direction.
 * @param {Object<string, string>} options.files Virtual FML file map.
 * @param {Object[]} options.mappings Mapping descriptors.
 * @param {Object[]} options.conceptMaps Compact ConceptMaps.
 * @returns {Object} Validated payload.
 */
export function createFmlMappingsPayload({ direction, files, mappings, conceptMaps }) {
  const payload = {
    schemaVersion: SCHEMA_VERSION.FML_MAPPINGS,
    direction,
    files,
    mappings,
    conceptMaps,
  };
  const identity = `fml-mappings/${direction.from}to${direction.to}`;
  validateFmlMappingsPayload(payload, identity);

  return payload;
}

/**
 * Create a canonical FHIR table payload from a consolidated definitions file.
 *
 * @param {Object} source Parsed consolidated FHIR definitions value.
 * @returns {Object} Validated payload.
 */
export function createFhirTablePayload(source) {
  const payload = {
    schemaVersion: SCHEMA_VERSION.FHIR_TABLE,
    fhirVersion: source.fhirVersion,
    polyPaths: source.polyPaths,
    arrayPaths: source.arrayPaths,
    elementTypes: source.elementTypes,
    contentReferences: source.contentReferences,
    resourceTypes: source.resourceTypes,
  };
  validateFhirTablePayload(payload, `fhir-tables/${source.fhirVersion}`);

  return payload;
}

/**
 * Create one compressed, dependency-free artifact envelope.
 *
 * @param {Object} options Artifact inputs.
 * @param {string} options.id Logical artifact identity.
 * @param {string} options.kind Artifact kind.
 * @param {string[]} options.sourceIds Provenance source identities.
 * @param {Object} options.data Validated decoded payload.
 * @returns {{envelope: Object, canonicalJson: string}} Generated values.
 */
export function createArtifactEnvelope({ id, kind, sourceIds, data }) {
  if (kind === ARTIFACT_KIND.FML_MAPPINGS) {
    validateFmlMappingsPayload(data, id);
  } else if (kind === ARTIFACT_KIND.FHIR_TABLE) {
    validateFhirTablePayload(data, id);
  }

  const canonicalJson = canonicalStringify(data);
  const bytes = new TextEncoder().encode(canonicalJson);
  const compressed = zlibSync(bytes, { level: COMPRESSION_LEVEL });
  const envelope = {
    schemaVersion: SCHEMA_VERSION.ARTIFACT,
    id,
    kind,
    codec: ARTIFACT_CODEC,
    uncompressedLength: bytes.length,
    sha256: sha256Hex(bytes),
    sourceIds,
    payload: encodeBase64(compressed),
  };
  validateArtifactEnvelope(envelope);

  return { envelope, canonicalJson };
}

/**
 * Render a generated artifact as a dependency-free ECMAScript module.
 *
 * @param {Object} envelope Artifact envelope.
 * @returns {string} Deterministic module source.
 */
export function renderArtifactModule(envelope) {
  validateArtifactEnvelope(envelope);

  return [
    '// Generated by tools/build-runtime-data.js. Do not edit.',
    '',
    `const artifact = ${JSON.stringify(envelope, null, 2)};`,
    '',
    'export default Object.freeze(artifact);',
    '',
  ].join('\n');
}

/**
 * Create the manifest entry corresponding to one generated artifact.
 *
 * @param {Object} envelope Artifact envelope.
 * @param {string} modulePath Root-relative generated module path.
 * @param {Object} data Decoded payload.
 * @returns {Object} Manifest artifact entry.
 */
export function createManifestArtifact(envelope, modulePath, data) {
  return {
    id: envelope.id,
    kind: envelope.kind,
    modulePath,
    codec: envelope.codec,
    uncompressedLength: envelope.uncompressedLength,
    sha256: envelope.sha256,
    sourceIds: envelope.sourceIds,
    counts: countArtifactItems(envelope.kind, data),
  };
}
