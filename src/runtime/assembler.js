/**
 * @fileoverview Assembly and indexing for opaque runtime-data selections.
 *
 * Artifact envelopes are decoded through a WeakMap so shared ESM envelope
 * objects are decompressed only once even when several directional modules use
 * the same FHIR table.
 *
 * @module runtime/assembler
 */

import { decodeTrustedArtifact } from './decode.js';
import {
  SCHEMA_VERSION,
  validateRuntimeData,
  validateRuntimeDataSelection,
} from './schema.js';

const decodedArtifactCache = new WeakMap();

/**
 * @typedef {Object} FhirPathModelRecord
 * @property {string} modelId Stable model identity.
 * @property {string[]} sourceVersions Source versions using this model.
 * @property {Object} model Imported fhirpath model object.
 */

/**
 * @typedef {Object} RuntimeDataIndexes
 * @property {Object[]} modules Validated modules in caller order.
 * @property {Map<string, Object>} mappingsByDirection Mapping payloads keyed by
 *   `from->to`.
 * @property {Map<string, Object>} tablesByVersion FHIR tables keyed by their
 *   published table version.
 * @property {Map<string, Object>} modelsBySourceVersion FHIRPath models keyed
 *   by canonical source version.
 */

/**
 * Decode an artifact once for each imported envelope object.
 *
 * @param {Object} envelope Generated artifact envelope.
 * @returns {Object} Validated decoded artifact shared for this envelope object.
 * @throws {Error} If envelope validation or decoding fails.
 */
function decodeArtifactOnce(envelope) {
  if (decodedArtifactCache.has(envelope)) return decodedArtifactCache.get(envelope);

  const decoded = decodeTrustedArtifact(envelope);
  decodedArtifactCache.set(envelope, decoded);

  return decoded;
}

/**
 * Create one FHIRPath model record used by runtime data.
 *
 * @param {string} modelId Stable model identity.
 * @param {string[]} sourceVersions Source versions using the model.
 * @param {Object} model Imported fhirpath model object.
 * @returns {FhirPathModelRecord} Frozen model record with sorted versions.
 */
export function createFhirPathModel(modelId, sourceVersions, model) {
  return Object.freeze({
    modelId,
    sourceVersions: Object.freeze([...sourceVersions].sort()),
    model,
  });
}

/**
 * Assemble runtime data from artifact values that were already decoded and
 * verified by an external loader.
 *
 * @param {Object} options Runtime-data parts.
 * @param {string} options.id Runtime-data identity.
 * @param {Object[]} options.mappingArtifacts Decoded mapping artifacts.
 * @param {Object[]} options.fhirTableArtifacts Decoded FHIR table artifacts.
 * @param {FhirPathModelRecord[]} options.fhirPathModels FHIRPath model records.
 * @returns {Object} Frozen validated runtime data.
 */
export function assembleDecodedRuntimeData({
  id,
  mappingArtifacts,
  fhirTableArtifacts,
  fhirPathModels,
}) {
  const runtimeData = Object.freeze({
    schemaVersion: SCHEMA_VERSION.RUNTIME_DATA,
    id,
    mappingArtifacts: Object.freeze([...mappingArtifacts]),
    fhirTableArtifacts: Object.freeze([...fhirTableArtifacts]),
    fhirPathModels: Object.freeze([...fhirPathModels]),
  });
  validateRuntimeData(runtimeData);

  return runtimeData;
}

/**
 * Assemble one directional runtime-data module from dependency-free envelopes.
 *
 * @param {Object} options Runtime-data parts.
 * @param {string} options.id Runtime-data identity.
 * @param {Object[]} options.mappingEnvelopes Mapping artifact envelopes.
 * @param {Object[]} options.fhirTableEnvelopes FHIR table artifact envelopes.
 * @param {FhirPathModelRecord[]} options.fhirPathModels FHIRPath model records.
 * @returns {Object} Frozen validated directional runtime data.
 * @throws {Error} If an artifact or required direction dependency is invalid.
 */
export function assembleRuntimeData({
  id,
  mappingEnvelopes,
  fhirTableEnvelopes,
  fhirPathModels,
}) {
  return assembleDecodedRuntimeData({
    id,
    mappingArtifacts: mappingEnvelopes.map(decodeArtifactOnce),
    fhirTableArtifacts: fhirTableEnvelopes.map(decodeArtifactOnce),
    fhirPathModels,
  });
}

/**
 * Combine directional runtime-data modules into one deduplicated module.
 *
 * @param {string} id Combined runtime-data identity.
 * @param {Object[]} selection Directional runtime-data modules.
 * @returns {Object} Frozen combined runtime data.
 * @throws {Error} If selected modules conflict or the result is incomplete.
 */
export function combineRuntimeData(id, selection) {
  const modules = validateRuntimeDataSelection(selection);
  const mappingArtifacts = new Map();
  const fhirTableArtifacts = new Map();
  const models = new Map();

  for (const module of modules) {
    for (const artifact of module.mappingArtifacts) {
      mappingArtifacts.set(artifact.id, artifact);
    }
    for (const artifact of module.fhirTableArtifacts) {
      fhirTableArtifacts.set(artifact.id, artifact);
    }
    for (const entry of module.fhirPathModels) {
      const existing = models.get(entry.modelId);
      if (!existing) {
        models.set(entry.modelId, {
          modelId: entry.modelId,
          sourceVersions: new Set(entry.sourceVersions),
          model: entry.model,
        });
        continue;
      }
      for (const version of entry.sourceVersions) existing.sourceVersions.add(version);
    }
  }

  const runtimeData = Object.freeze({
    schemaVersion: SCHEMA_VERSION.RUNTIME_DATA,
    id,
    mappingArtifacts: Object.freeze([...mappingArtifacts.values()]),
    fhirTableArtifacts: Object.freeze([...fhirTableArtifacts.values()]),
    fhirPathModels: Object.freeze([...models.values()].map(entry =>
      createFhirPathModel(entry.modelId, [...entry.sourceVersions], entry.model))),
  });
  validateRuntimeData(runtimeData);

  return runtimeData;
}

/**
 * Validate and index one runtime-data selection for engine construction.
 *
 * @param {Object|Object[]} selection Runtime-data module or module array.
 * @returns {RuntimeDataIndexes} Validated, deduplicated runtime indexes.
 * @throws {Error} If selected modules are empty, malformed, or conflicting.
 */
export function indexRuntimeDataSelection(selection) {
  const modules = validateRuntimeDataSelection(selection);
  const mappingsByDirection = new Map();
  const tablesByVersion = new Map();
  const modelsBySourceVersion = new Map();

  for (const module of modules) {
    for (const artifact of module.mappingArtifacts) {
      const { from, to } = artifact.data.direction;
      mappingsByDirection.set(`${from}->${to}`, artifact.data);
    }
    for (const artifact of module.fhirTableArtifacts) {
      tablesByVersion.set(artifact.data.fhirVersion, artifact.data);
    }
    for (const entry of module.fhirPathModels) {
      for (const sourceVersion of entry.sourceVersions) {
        modelsBySourceVersion.set(sourceVersion, entry.model);
      }
    }
  }

  return Object.freeze({
    modules: Object.freeze([...modules]),
    mappingsByDirection,
    tablesByVersion,
    modelsBySourceVersion,
  });
}
