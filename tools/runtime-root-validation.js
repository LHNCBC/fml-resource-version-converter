/**
 * @fileoverview Pure validation for complete or partial runtime artifact roots.
 *
 * Filesystem access and module loading belong to the Node-only loader. This
 * module accepts a schema-validated manifest and validates its relationship
 * to the loaded envelopes, decoded payloads, and logical counts without
 * importing Node built-ins.
 *
 * @module tools/runtime-root-validation
 */

import {
  ARTIFACT_KIND,
  canonicalStringify,
  manifestArtifacts,
} from '../src/runtime/schema.js';

const MAPPING_DIRECTIONS = Object.freeze([
  Object.freeze(['R2', 'R3']),
  Object.freeze(['R3', 'R2']),
  Object.freeze(['R3', 'R4']),
  Object.freeze(['R4', 'R3']),
  Object.freeze(['R4', 'R5']),
  Object.freeze(['R5', 'R4']),
  Object.freeze(['R4B', 'R5']),
  Object.freeze(['R5', 'R4B']),
]);
const TABLE_VERSIONS = Object.freeze(['DSTU2', 'STU3', 'R4', 'R4B', 'R5']);

/** Complete artifact identities, kinds, and canonical module paths. */
export const EXPECTED_RUNTIME_ARTIFACTS = Object.freeze([
  ...MAPPING_DIRECTIONS.map(([from, to]) => Object.freeze({
    id: `fml-mappings/${from}to${to}`,
    kind: ARTIFACT_KIND.FML_MAPPINGS,
    modulePath: `fml-mappings/${from}to${to}.js`,
    direction: Object.freeze({ from, to }),
  })),
  ...TABLE_VERSIONS.map(fhirVersion => Object.freeze({
    id: `fhir-tables/${fhirVersion}`,
    kind: ARTIFACT_KIND.FHIR_TABLE,
    modulePath: `fhir-tables/${fhirVersion}.js`,
    fhirVersion,
  })),
]);

/**
 * Count the logical items in one decoded artifact.
 *
 * @param {string} kind Artifact kind.
 * @param {Object} data Decoded payload.
 * @returns {Object<string, number>} Deterministic count map.
 */
export function countArtifactItems(kind, data) {
  if (kind === ARTIFACT_KIND.FML_MAPPINGS) {
    const groups = data.conceptMaps.flatMap(conceptMap => conceptMap.groups);
    const elements = groups.flatMap(group => group.elements);

    return {
      files: Object.keys(data.files).length,
      mappings: data.mappings.length,
      conceptMaps: data.conceptMaps.length,
      conceptMapGroups: groups.length,
      conceptMapElements: elements.length,
      conceptMapTargets: elements.reduce(
        (total, element) => total + element.targets.length,
        0,
      ),
    };
  }

  return {
    polyPaths: Object.keys(data.polyPaths).length,
    arrayPaths: data.arrayPaths.length,
    elementTypes: Object.keys(data.elementTypes).length,
    resourceTypes: data.resourceTypes.length,
  };
}

/**
 * Require two JSON-compatible values to be exactly equivalent.
 *
 * @param {*} actual Actual value.
 * @param {*} expected Expected value.
 * @param {string} message Error detail.
 * @returns {void}
 */
function requireEquivalent(actual, expected, message) {
  if (canonicalStringify(actual) !== canonicalStringify(expected)) {
    throw new Error(`Runtime root: ${message}`);
  }
}

/**
 * Validate a runtime root after its artifact modules have been loaded.
 *
 * @param {Object} manifest Schema-validated manifest.
 * @param {Array<{envelope: Object, decoded: Object}>} loadedArtifacts Loaded
 *   envelopes and their verified decoded values.
 * @param {Object} [options] Validation options.
 * @param {boolean} [options.complete=true] Require both components.
 * @returns {Object} The original validated manifest.
 * @throws {Error} If the root is incomplete or any index metadata differs.
 */
export function validateRuntimeRootArtifacts(manifest, loadedArtifacts, options = {}) {
  const { complete = true } = options;
  if (!Array.isArray(loadedArtifacts)) {
    throw new TypeError('Runtime root: loaded artifacts must be an array');
  }

  const hasFmlMappings = Object.hasOwn(manifest.components, 'fmlMappings');
  const hasFhirTables = Object.hasOwn(manifest.components, 'fhirTables');
  if (complete && (!hasFmlMappings || !hasFhirTables)) {
    const missing = [
      !hasFmlMappings ? 'fmlMappings' : null,
      !hasFhirTables ? 'fhirTables' : null,
    ].filter(Boolean);
    throw new Error(`Runtime root: complete validation requires ${missing.join(', ')}`);
  }

  const expectedArtifacts = EXPECTED_RUNTIME_ARTIFACTS.filter(item =>
    (item.kind === ARTIFACT_KIND.FML_MAPPINGS && hasFmlMappings) ||
    (item.kind === ARTIFACT_KIND.FHIR_TABLE && hasFhirTables));
  const expectedById = new Map(expectedArtifacts.map(item => [item.id, item]));
  const manifestById = new Map(manifestArtifacts(manifest).map(item => [item.id, item]));
  const loadedById = new Map();
  for (const loaded of loadedArtifacts) {
    const id = loaded?.envelope?.id;
    if (loadedById.has(id)) throw new Error(`Runtime root: duplicate loaded artifact "${id}"`);
    loadedById.set(id, loaded);
  }

  for (const collection of [manifestById, loadedById]) {
    const missing = [...expectedById.keys()].filter(id => !collection.has(id));
    const extra = [...collection.keys()].filter(id => !expectedById.has(id));
    if (missing.length > 0 || extra.length > 0) {
      const details = [
        missing.length > 0 ? `missing ${missing.join(', ')}` : null,
        extra.length > 0 ? `unexpected ${extra.join(', ')}` : null,
      ].filter(Boolean).join('; ');
      throw new Error(`Runtime root: artifact set is incomplete (${details})`);
    }
  }

  for (const expected of expectedArtifacts) {
    const entry = manifestById.get(expected.id);
    const { envelope, decoded } = loadedById.get(expected.id);
    if (entry.kind !== expected.kind || entry.modulePath !== expected.modulePath) {
      throw new Error(
        `Runtime root: manifest entry "${expected.id}" must use ` +
        `${expected.kind} at ${expected.modulePath}`,
      );
    }

    for (const field of ['id', 'kind', 'codec', 'uncompressedLength', 'sha256']) {
      if (entry[field] !== envelope[field]) {
        throw new Error(
          `Runtime root: manifest entry "${expected.id}" ${field} does not match its envelope`,
        );
      }
    }
    requireEquivalent(
      entry.sourceIds,
      envelope.sourceIds,
      `manifest entry "${expected.id}" sourceIds do not match its envelope`,
    );
    requireEquivalent(
      entry.counts,
      countArtifactItems(envelope.kind, decoded.data),
      `manifest entry "${expected.id}" counts do not match its decoded payload`,
    );

    if (decoded.id !== envelope.id || decoded.kind !== envelope.kind ||
        decoded.sha256 !== envelope.sha256) {
      throw new Error(`Runtime root: decoded artifact "${expected.id}" metadata is inconsistent`);
    }

    if (expected.direction) {
      requireEquivalent(
        decoded.data.direction,
        expected.direction,
        `artifact "${expected.id}" declares the wrong direction`,
      );
    } else if (decoded.data.fhirVersion !== expected.fhirVersion) {
      throw new Error(
        `Runtime root: artifact "${expected.id}" declares FHIR table ` +
        `${decoded.data.fhirVersion}`,
      );
    }
  }

  return manifest;
}
