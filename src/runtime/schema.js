/**
 * @fileoverview Runtime artifact schemas, validation, and canonical JSON.
 *
 * Generated artifact modules are dependency-free data modules. They export an
 * artifact envelope containing metadata and a Base64 payload. Runtime assembly
 * code decodes the payload and validates its kind-specific data with this
 * module. The manifest is a maintainer index and is not needed by browser
 * runtime modules.
 *
 * @module runtime/schema
 */

/** Version numbers for independently evolving runtime-data formats. */
export const SCHEMA_VERSION = Object.freeze({
  ARTIFACT: 1,
  MANIFEST: 1,
  FML_MAPPINGS: 1,
  FHIR_TABLE: 1,
  RUNTIME_DATA: 1,
});

/** Kinds of compressed generated artifacts. */
export const ARTIFACT_KIND = Object.freeze({
  FML_MAPPINGS: 'fml-mappings',
  FHIR_TABLE: 'fhir-table',
});

/** Stored compression format for generated artifact payloads. */
export const ARTIFACT_CODEC = 'zlib';

const ARTIFACT_KINDS = new Set(Object.values(ARTIFACT_KIND));
const FHIR_VERSIONS = new Set(['R2', 'R3', 'R4', 'R4B', 'R5']);
const FHIR_TABLE_VERSIONS = new Set(['DSTU2', 'STU3', 'R4', 'R4B', 'R5']);
const TABLE_VERSION = Object.freeze({
  R2: 'DSTU2',
  R3: 'STU3',
  R4: 'R4',
  R4B: 'R4B',
  R5: 'R5',
});
const DIRECTION_KEYS = new Set([
  'R2->R3',
  'R3->R2',
  'R3->R4',
  'R4->R3',
  'R4->R5',
  'R5->R4',
  'R4B->R5',
  'R5->R4B',
]);
const SHA256_RE = /^[a-f0-9]{64}$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const TOKEN_RE = /^[a-z0-9][a-z0-9._-]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validatedDecodedArtifacts = new WeakSet();
const validatedRuntimeData = new WeakSet();

/**
 * Return whether a value is a plain object suitable for schema data.
 *
 * @param {*} value Candidate value.
 * @returns {boolean} True for an object with Object or null prototype.
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

/**
 * Throw a consistently formatted schema error.
 *
 * @param {string} label Logical object label.
 * @param {string} path Field path.
 * @param {string} message Error detail.
 * @returns {never}
 */
function fail(label, path, message) {
  throw new Error(`${label}: ${path} ${message}`);
}

/**
 * Require a plain object.
 *
 * @param {*} value Candidate value.
 * @param {string} label Logical object label.
 * @param {string} path Field path.
 * @returns {Object} The validated object.
 */
function requireObject(value, label, path) {
  if (!isPlainObject(value)) fail(label, path, 'must be a plain object');

  return value;
}

/**
 * Require an exact set of object fields.
 *
 * @param {Object} value Object to inspect.
 * @param {string[]} required Required field names.
 * @param {string[]} optional Optional field names.
 * @param {string} label Logical object label.
 * @param {string} path Field path.
 * @returns {void}
 */
function requireFields(value, required, optional, label, path) {
  const allowed = new Set([...required, ...optional]);

  for (const field of required) {
    if (!Object.hasOwn(value, field)) fail(label, `${path}.${field}`, 'is required');
  }

  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) fail(label, `${path}.${field}`, 'is not supported');
  }
}

/**
 * Require a string, optionally allowing the empty string.
 *
 * @param {*} value Candidate value.
 * @param {string} label Logical object label.
 * @param {string} path Field path.
 * @param {boolean} [allowEmpty=false] Whether an empty string is allowed.
 * @returns {string} The validated string.
 */
function requireString(value, label, path, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    fail(label, path, `must be ${allowEmpty ? 'a string' : 'a non-empty string'}`);
  }

  return value;
}

/**
 * Require a non-negative safe integer.
 *
 * @param {*} value Candidate value.
 * @param {string} label Logical object label.
 * @param {string} path Field path.
 * @returns {number} The validated integer.
 */
function requireCount(value, label, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(label, path, 'must be a non-negative safe integer');
  }

  return value;
}

/**
 * Require an array.
 *
 * @param {*} value Candidate value.
 * @param {string} label Logical object label.
 * @param {string} path Field path.
 * @returns {Array} The validated array.
 */
function requireArray(value, label, path) {
  if (!Array.isArray(value)) fail(label, path, 'must be an array');

  return value;
}

/**
 * Require a supported schema version.
 *
 * @param {*} actual Supplied schema version.
 * @param {number} expected Supported version.
 * @param {string} label Logical object label.
 * @param {string} path Field path.
 * @returns {void}
 */
function requireSchemaVersion(actual, expected, label, path) {
  if (actual !== expected) {
    fail(label, path, `must be ${expected}; received ${String(actual)}`);
  }
}

/**
 * Require a safe relative POSIX path.
 *
 * @param {*} value Candidate path.
 * @param {string} label Logical object label.
 * @param {string} path Field path.
 * @returns {string} Validated path.
 */
function requireRelativePath(value, label, path) {
  requireString(value, label, path);
  const segments = value.split('/');

  if (value.startsWith('/') || value.includes('\\') ||
      segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    fail(label, path, 'must be a safe relative POSIX path');
  }

  return value;
}

/**
 * Require an identifier used for artifacts, sources, or runtime selections.
 *
 * @param {*} value Candidate identifier.
 * @param {string} label Logical object label.
 * @param {string} path Field path.
 * @returns {string} Validated identifier.
 */
function requireId(value, label, path) {
  requireString(value, label, path);

  if (!ID_RE.test(value) || value.includes('//') || value.split('/').includes('..')) {
    fail(label, path, 'must be a safe logical identifier');
  }

  return value;
}

/**
 * Require a lowercase SHA-256 digest.
 *
 * @param {*} value Candidate digest.
 * @param {string} label Logical object label.
 * @param {string} path Field path.
 * @returns {string} Validated digest.
 */
function requireSha256(value, label, path) {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    fail(label, path, 'must be a 64-character lowercase SHA-256 digest');
  }

  return value;
}

/**
 * Require an array of unique strings and optionally require sort order.
 *
 * @param {*} value Candidate array.
 * @param {string} label Logical object label.
 * @param {string} path Field path.
 * @param {Object} [options]
 * @param {boolean} [options.nonEmpty=false] Require at least one item.
 * @param {boolean} [options.sorted=false] Require lexical sort order.
 * @returns {string[]} Validated strings.
 */
function requireUniqueStrings(value, label, path, options = {}) {
  const { nonEmpty = false, sorted = false } = options;
  const values = requireArray(value, label, path);

  if (nonEmpty && values.length === 0) fail(label, path, 'must not be empty');

  const seen = new Set();
  for (let index = 0; index < values.length; index++) {
    const itemPath = `${path}[${index}]`;
    const item = requireString(values[index], label, itemPath);
    if (seen.has(item)) fail(label, itemPath, `duplicates "${item}"`);
    seen.add(item);

    if (sorted && index > 0 && values[index - 1] > item) {
      fail(label, path, 'must be sorted lexically');
    }
  }

  return values;
}

/**
 * Serialize JSON data with recursively sorted object keys.
 *
 * Arrays retain their order. Unsupported JSON values, sparse arrays,
 * non-finite numbers, non-plain objects, and cycles are rejected instead of
 * being silently coerced by JSON.stringify().
 *
 * @param {*} value JSON-compatible value.
 * @returns {string} Canonical JSON without trailing whitespace.
 */
export function canonicalStringify(value) {
  const ancestors = new Set();

  /**
   * Serialize one value recursively.
   *
   * @param {*} current Current value.
   * @param {string} path Diagnostic path.
   * @returns {string} Serialized JSON fragment.
   */
  function serialize(current, path) {
    if (current === null) return 'null';
    if (typeof current === 'string' || typeof current === 'boolean') {
      return JSON.stringify(current);
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) fail('Canonical JSON', path, 'must be a finite number');

      return JSON.stringify(current);
    }
    if (Array.isArray(current)) {
      if (ancestors.has(current)) fail('Canonical JSON', path, 'must not contain a cycle');
      ancestors.add(current);
      const parts = [];

      for (let index = 0; index < current.length; index++) {
        if (!Object.hasOwn(current, index)) {
          fail('Canonical JSON', `${path}[${index}]`, 'must not be a sparse array entry');
        }
        parts.push(serialize(current[index], `${path}[${index}]`));
      }

      ancestors.delete(current);
      return `[${parts.join(',')}]`;
    }
    if (!isPlainObject(current)) {
      fail('Canonical JSON', path, 'must contain only JSON-compatible plain objects');
    }
    if (ancestors.has(current)) fail('Canonical JSON', path, 'must not contain a cycle');
    ancestors.add(current);

    const parts = Object.keys(current).sort().map(key =>
      `${JSON.stringify(key)}:${serialize(current[key], `${path}.${key}`)}`,
    );

    ancestors.delete(current);
    return `{${parts.join(',')}}`;
  }

  return serialize(value, '$');
}

/**
 * Return the best available artifact identity for diagnostics.
 *
 * @param {*} value Candidate artifact.
 * @returns {string} Diagnostic label.
 */
function artifactLabel(value) {
  const id = typeof value?.id === 'string' && value.id.length > 0
    ? value.id
    : '<unknown>';

  return `Runtime artifact "${id}"`;
}

/**
 * Validate one dependency-free compressed artifact envelope.
 *
 * The SHA-256 digest covers the UTF-8 bytes of the canonical uncompressed JSON
 * payload. Codec selection and digest verification are implemented by the
 * decoder in later steps.
 *
 * @param {*} value Candidate envelope.
 * @returns {Object} The original validated envelope.
 */
export function validateArtifactEnvelope(value) {
  const label = artifactLabel(value);
  requireObject(value, label, '$');
  requireFields(value, [
    'schemaVersion',
    'id',
    'kind',
    'codec',
    'uncompressedLength',
    'sha256',
    'sourceIds',
    'payload',
  ], [], label, '$');
  requireSchemaVersion(value.schemaVersion, SCHEMA_VERSION.ARTIFACT, label, '$.schemaVersion');
  requireId(value.id, label, '$.id');

  if (!ARTIFACT_KINDS.has(value.kind)) {
    fail(label, '$.kind', `must be one of ${[...ARTIFACT_KINDS].join(', ')}`);
  }
  if (typeof value.codec !== 'string' || !TOKEN_RE.test(value.codec)) {
    fail(label, '$.codec', 'must be a lowercase codec token');
  }

  requireCount(value.uncompressedLength, label, '$.uncompressedLength');
  requireSha256(value.sha256, label, '$.sha256');
  requireUniqueStrings(value.sourceIds, label, '$.sourceIds', { nonEmpty: true });
  requireString(value.payload, label, '$.payload');

  if (value.payload.length % 4 !== 0 || !BASE64_RE.test(value.payload)) {
    fail(label, '$.payload', 'must be canonical Base64 without whitespace');
  }

  return value;
}

/**
 * Validate a version direction object.
 *
 * @param {*} value Candidate direction.
 * @param {string} label Logical object label.
 * @param {string} path Field path.
 * @returns {Object} The validated direction.
 */
function validateDirection(value, label, path) {
  requireObject(value, label, path);
  requireFields(value, ['from', 'to'], [], label, path);
  requireString(value.from, label, `${path}.from`);
  requireString(value.to, label, `${path}.to`);

  const key = `${value.from}->${value.to}`;
  if (!DIRECTION_KEYS.has(key)) fail(label, path, `declares unsupported direction ${key}`);

  return value;
}

/**
 * Validate one compact ConceptMap target.
 *
 * @param {*} value Candidate target.
 * @param {string} label Logical object label.
 * @param {string} path Field path.
 * @returns {void}
 */
function validateConceptMapTarget(value, label, path) {
  requireObject(value, label, path);
  requireFields(value, ['code'], ['display', 'relationship'], label, path);
  requireString(value.code, label, `${path}.code`);
  if (value.display !== undefined) requireString(value.display, label, `${path}.display`, true);
  if (value.relationship !== undefined) {
    requireString(value.relationship, label, `${path}.relationship`);
  }
}

/**
 * Validate one compact ConceptMap element.
 *
 * @param {*} value Candidate element.
 * @param {string} label Logical object label.
 * @param {string} path Field path.
 * @returns {void}
 */
function validateConceptMapElement(value, label, path) {
  requireObject(value, label, path);
  requireFields(value, ['code', 'targets'], ['noMap'], label, path);
  requireString(value.code, label, `${path}.code`);
  if (value.noMap !== undefined && typeof value.noMap !== 'boolean') {
    fail(label, `${path}.noMap`, 'must be a boolean');
  }

  for (const [index, target] of requireArray(value.targets, label, `${path}.targets`).entries()) {
    validateConceptMapTarget(target, label, `${path}.targets[${index}]`);
  }
}

/**
 * Validate group-level unmapped behavior.
 *
 * @param {*} value Candidate unmapped rule.
 * @param {string} label Logical object label.
 * @param {string} path Field path.
 * @returns {void}
 */
function validateUnmapped(value, label, path) {
  requireObject(value, label, path);
  requireFields(value, ['mode'], ['code', 'display', 'url'], label, path);
  requireString(value.mode, label, `${path}.mode`);

  for (const field of ['code', 'display', 'url']) {
    if (value[field] !== undefined) requireString(value[field], label, `${path}.${field}`, true);
  }
}

/**
 * Validate one compact ConceptMap group.
 *
 * @param {*} value Candidate group.
 * @param {string} label Logical object label.
 * @param {string} path Field path.
 * @returns {void}
 */
function validateConceptMapGroup(value, label, path) {
  requireObject(value, label, path);
  requireFields(value, ['elements'], ['source', 'target', 'unmapped'], label, path);

  for (const field of ['source', 'target']) {
    if (value[field] !== undefined) requireString(value[field], label, `${path}.${field}`, true);
  }
  if (value.unmapped !== undefined) validateUnmapped(value.unmapped, label, `${path}.unmapped`);

  for (const [index, element] of requireArray(value.elements, label, `${path}.elements`).entries()) {
    validateConceptMapElement(element, label, `${path}.elements[${index}]`);
  }
}

/**
 * Validate one compact ConceptMap.
 *
 * @param {*} value Candidate ConceptMap.
 * @param {string} label Logical object label.
 * @param {string} path Field path.
 * @returns {void}
 */
function validateConceptMap(value, label, path) {
  requireObject(value, label, path);
  requireFields(value, ['virtualFile', 'url', 'groups'], [], label, path);
  requireRelativePath(value.virtualFile, label, `${path}.virtualFile`);
  requireString(value.url, label, `${path}.url`);

  for (const [index, group] of requireArray(value.groups, label, `${path}.groups`).entries()) {
    validateConceptMapGroup(group, label, `${path}.groups[${index}]`);
  }
}

/**
 * Validate one resource mapping descriptor.
 *
 * @param {*} value Candidate descriptor.
 * @param {string} label Logical object label.
 * @param {string} path Field path.
 * @param {Set<string>} fileNames Available virtual FML filenames.
 * @returns {void}
 */
function validateMappingDescriptor(value, label, path, fileNames) {
  requireObject(value, label, path);
  requireFields(value, [
    'virtualFile',
    'structureMapUrl',
    'structureMapName',
    'entryGroup',
    'sourceResourceType',
    'sourceProfile',
    'targetResourceType',
    'targetProfile',
  ], [], label, path);
  requireRelativePath(value.virtualFile, label, `${path}.virtualFile`);

  if (!fileNames.has(value.virtualFile)) {
    fail(label, `${path}.virtualFile`, `references missing FML file "${value.virtualFile}"`);
  }
  if (value.structureMapUrl !== null) {
    requireString(value.structureMapUrl, label, `${path}.structureMapUrl`);
  }

  for (const field of [
    'structureMapName',
    'entryGroup',
    'sourceResourceType',
    'sourceProfile',
    'targetResourceType',
    'targetProfile',
  ]) {
    requireString(value[field], label, `${path}.${field}`);
  }
}

/**
 * Validate a decoded FML mappings payload.
 *
 * Duplicate source-code elements and targets are allowed because declaration
 * order and duplicates are meaningful to the translator.
 *
 * @param {*} value Candidate payload.
 * @param {string} [identity='<unknown>'] Artifact identity for diagnostics.
 * @returns {Object} The original validated payload.
 */
export function validateFmlMappingsPayload(value, identity = '<unknown>') {
  const label = `Runtime artifact "${identity}"`;
  requireObject(value, label, '$.data');
  requireFields(value, [
    'schemaVersion',
    'direction',
    'files',
    'mappings',
    'conceptMaps',
  ], [], label, '$.data');
  requireSchemaVersion(
    value.schemaVersion,
    SCHEMA_VERSION.FML_MAPPINGS,
    label,
    '$.data.schemaVersion',
  );
  validateDirection(value.direction, label, '$.data.direction');

  const files = requireObject(value.files, label, '$.data.files');
  const fileNames = new Set(Object.keys(files));
  if (fileNames.size === 0) fail(label, '$.data.files', 'must not be empty');

  for (const [virtualFile, text] of Object.entries(files)) {
    requireRelativePath(virtualFile, label, `$.data.files[${JSON.stringify(virtualFile)}]`);
    requireString(text, label, `$.data.files[${JSON.stringify(virtualFile)}]`);
  }

  const mappings = requireArray(value.mappings, label, '$.data.mappings');
  if (mappings.length === 0) fail(label, '$.data.mappings', 'must not be empty');
  for (const [index, mapping] of mappings.entries()) {
    validateMappingDescriptor(mapping, label, `$.data.mappings[${index}]`, fileNames);
  }

  const conceptMapFiles = new Set();
  const conceptMapUrls = new Set();
  for (const [index, conceptMap] of requireArray(
    value.conceptMaps,
    label,
    '$.data.conceptMaps',
  ).entries()) {
    const path = `$.data.conceptMaps[${index}]`;
    validateConceptMap(conceptMap, label, path);
    if (conceptMapFiles.has(conceptMap.virtualFile)) {
      fail(label, `${path}.virtualFile`, `duplicates "${conceptMap.virtualFile}"`);
    }
    if (conceptMapUrls.has(conceptMap.url)) {
      fail(label, `${path}.url`, `duplicates "${conceptMap.url}"`);
    }
    conceptMapFiles.add(conceptMap.virtualFile);
    conceptMapUrls.add(conceptMap.url);
  }

  return value;
}

/**
 * Validate a map of strings to strings.
 *
 * @param {*} value Candidate map.
 * @param {string} label Logical object label.
 * @param {string} path Field path.
 * @returns {void}
 */
function validateStringMap(value, label, path) {
  requireObject(value, label, path);
  for (const [key, item] of Object.entries(value)) {
    requireString(key, label, `${path} key`);
    requireString(item, label, `${path}.${key}`);
  }
}

/**
 * Validate a decoded FHIR table payload.
 *
 * @param {*} value Candidate payload.
 * @param {string} [identity='<unknown>'] Artifact identity for diagnostics.
 * @returns {Object} The original validated payload.
 */
export function validateFhirTablePayload(value, identity = '<unknown>') {
  const label = `Runtime artifact "${identity}"`;
  requireObject(value, label, '$.data');
  requireFields(value, [
    'schemaVersion',
    'fhirVersion',
    'polyPaths',
    'arrayPaths',
    'elementTypes',
    'resourceTypes',
  ], [], label, '$.data');
  requireSchemaVersion(
    value.schemaVersion,
    SCHEMA_VERSION.FHIR_TABLE,
    label,
    '$.data.schemaVersion',
  );

  if (!FHIR_TABLE_VERSIONS.has(value.fhirVersion)) {
    fail(label, '$.data.fhirVersion', 'is not a supported FHIR table version');
  }

  const polyPaths = requireObject(value.polyPaths, label, '$.data.polyPaths');
  for (const [path, types] of Object.entries(polyPaths)) {
    requireString(path, label, '$.data.polyPaths key');
    requireUniqueStrings(types, label, `$.data.polyPaths.${path}`, {
      nonEmpty: true,
      sorted: true,
    });
  }

  requireUniqueStrings(value.arrayPaths, label, '$.data.arrayPaths', { sorted: true });
  validateStringMap(value.elementTypes, label, '$.data.elementTypes');
  requireUniqueStrings(value.resourceTypes, label, '$.data.resourceTypes', { sorted: true });

  return value;
}

/**
 * Validate one manifest source record.
 *
 * @param {*} value Candidate source.
 * @param {string} label Logical object label.
 * @param {string} path Field path.
 * @returns {void}
 */
function validateManifestSource(value, label, path) {
  requireObject(value, label, path);
  requireFields(value, ['id', 'uri', 'date', 'license', 'sha256'], ['version', 'commit'], label, path);
  requireId(value.id, label, `${path}.id`);
  requireString(value.uri, label, `${path}.uri`);
  requireString(value.license, label, `${path}.license`);
  requireSha256(value.sha256, label, `${path}.sha256`);

  if (typeof value.date !== 'string' || !DATE_RE.test(value.date)) {
    fail(label, `${path}.date`, 'must use YYYY-MM-DD');
  }
  if (value.version === undefined && value.commit === undefined) {
    fail(label, path, 'must include version or commit');
  }
  if (value.version !== undefined) requireString(value.version, label, `${path}.version`);
  if (value.commit !== undefined) requireString(value.commit, label, `${path}.commit`);
}

/**
 * Validate one manifest artifact index entry.
 *
 * @param {*} value Candidate entry.
 * @param {string} label Logical object label.
 * @param {string} path Field path.
 * @param {Set<string>} sourceIds Known manifest source identities.
 * @returns {void}
 */
function validateManifestArtifact(value, label, path, sourceIds) {
  requireObject(value, label, path);
  requireFields(value, [
    'id',
    'kind',
    'modulePath',
    'codec',
    'uncompressedLength',
    'sha256',
    'sourceIds',
    'counts',
  ], [], label, path);
  requireId(value.id, label, `${path}.id`);

  if (!ARTIFACT_KINDS.has(value.kind)) fail(label, `${path}.kind`, 'is not supported');
  requireRelativePath(value.modulePath, label, `${path}.modulePath`);
  if (!value.modulePath.endsWith('.js')) fail(label, `${path}.modulePath`, 'must end in .js');
  if (typeof value.codec !== 'string' || !TOKEN_RE.test(value.codec)) {
    fail(label, `${path}.codec`, 'must be a lowercase codec token');
  }

  requireCount(value.uncompressedLength, label, `${path}.uncompressedLength`);
  requireSha256(value.sha256, label, `${path}.sha256`);

  const entrySourceIds = requireUniqueStrings(value.sourceIds, label, `${path}.sourceIds`, {
    nonEmpty: true,
  });
  for (const sourceId of entrySourceIds) {
    if (!sourceIds.has(sourceId)) {
      fail(label, `${path}.sourceIds`, `references unknown source "${sourceId}"`);
    }
  }

  const counts = requireObject(value.counts, label, `${path}.counts`);
  for (const [name, count] of Object.entries(counts)) {
    requireString(name, label, `${path}.counts key`);
    requireCount(count, label, `${path}.counts.${name}`);
  }
}

/**
 * Validate the authoritative runtime artifact manifest.
 *
 * @param {*} value Candidate manifest.
 * @returns {Object} The original validated manifest.
 */
export function validateManifest(value) {
  const label = 'Runtime manifest';
  requireObject(value, label, '$');
  requireFields(value, [
    'schemaVersion',
    'generator',
    'format',
    'sources',
    'artifacts',
  ], [], label, '$');
  requireSchemaVersion(value.schemaVersion, SCHEMA_VERSION.MANIFEST, label, '$.schemaVersion');

  requireObject(value.generator, label, '$.generator');
  requireFields(value.generator, ['name', 'version'], [], label, '$.generator');
  requireString(value.generator.name, label, '$.generator.name');
  requireString(value.generator.version, label, '$.generator.version');

  requireObject(value.format, label, '$.format');
  requireFields(value.format, [
    'canonicalJson',
    'payloadEncoding',
    'hash',
    'compression',
  ], [], label, '$.format');
  if (value.format.canonicalJson !== 'sorted-object-keys-v1') {
    fail(label, '$.format.canonicalJson', 'must be sorted-object-keys-v1');
  }
  if (value.format.payloadEncoding !== 'base64') {
    fail(label, '$.format.payloadEncoding', 'must be base64');
  }
  if (value.format.hash !== 'sha256') fail(label, '$.format.hash', 'must be sha256');
  requireObject(value.format.compression, label, '$.format.compression');
  requireFields(value.format.compression, [
    'codec',
    'implementation',
    'implementationVersion',
    'level',
  ], [], label, '$.format.compression');
  if (value.format.compression.codec !== ARTIFACT_CODEC) {
    fail(label, '$.format.compression.codec', `must be ${ARTIFACT_CODEC}`);
  }
  requireString(
    value.format.compression.implementation,
    label,
    '$.format.compression.implementation',
  );
  requireString(
    value.format.compression.implementationVersion,
    label,
    '$.format.compression.implementationVersion',
  );
  if (!Number.isInteger(value.format.compression.level) ||
      value.format.compression.level < 0 || value.format.compression.level > 9) {
    fail(label, '$.format.compression.level', 'must be an integer from 0 through 9');
  }

  const sourceIds = new Set();
  for (const [index, source] of requireArray(value.sources, label, '$.sources').entries()) {
    const path = `$.sources[${index}]`;
    validateManifestSource(source, label, path);
    if (sourceIds.has(source.id)) fail(label, `${path}.id`, `duplicates "${source.id}"`);
    sourceIds.add(source.id);
  }
  if (sourceIds.size === 0) fail(label, '$.sources', 'must not be empty');

  const artifactIds = new Set();
  const modulePaths = new Set();
  for (const [index, artifact] of requireArray(value.artifacts, label, '$.artifacts').entries()) {
    const path = `$.artifacts[${index}]`;
    validateManifestArtifact(artifact, label, path, sourceIds);
    if (artifactIds.has(artifact.id)) fail(label, `${path}.id`, `duplicates "${artifact.id}"`);
    if (modulePaths.has(artifact.modulePath)) {
      fail(label, `${path}.modulePath`, `duplicates "${artifact.modulePath}"`);
    }
    artifactIds.add(artifact.id);
    modulePaths.add(artifact.modulePath);
  }
  if (artifactIds.size === 0) fail(label, '$.artifacts', 'must not be empty');

  return value;
}

/**
 * Validate one decoded artifact reference used by runtime data.
 *
 * @param {*} value Candidate decoded artifact.
 * @param {string} expectedKind Required artifact kind.
 * @param {string} label Runtime-data label.
 * @param {string} path Field path.
 * @returns {Object} The validated decoded artifact.
 */
export function validateDecodedArtifact(value, expectedKind, label, path) {
  const cacheable = Object.isFrozen(value);
  if (cacheable && validatedDecodedArtifacts.has(value)) {
    if (value.kind !== expectedKind) {
      fail(label, `${path}.kind`, `must be ${expectedKind}`);
    }

    return value;
  }

  requireObject(value, label, path);
  requireFields(value, ['id', 'kind', 'sha256', 'data'], [], label, path);
  requireId(value.id, label, `${path}.id`);
  requireSha256(value.sha256, label, `${path}.sha256`);

  if (value.kind !== expectedKind) {
    fail(label, `${path}.kind`, `must be ${expectedKind}`);
  }
  if (expectedKind === ARTIFACT_KIND.FML_MAPPINGS) {
    validateFmlMappingsPayload(value.data, value.id);
  } else {
    validateFhirTablePayload(value.data, value.id);
  }

  if (cacheable) validatedDecodedArtifacts.add(value);

  return value;
}

/**
 * Validate an opaque assembled runtime-data module.
 *
 * @param {*} value Candidate runtime data.
 * @returns {Object} The original validated runtime data.
 */
export function validateRuntimeData(value) {
  const cacheable = Object.isFrozen(value);
  if (cacheable && validatedRuntimeData.has(value)) return value;

  const id = typeof value?.id === 'string' && value.id.length > 0 ? value.id : '<unknown>';
  const label = `Runtime data "${id}"`;
  requireObject(value, label, '$');
  requireFields(value, [
    'schemaVersion',
    'id',
    'mappingArtifacts',
    'fhirTableArtifacts',
    'fhirPathModels',
  ], [], label, '$');
  requireSchemaVersion(value.schemaVersion, SCHEMA_VERSION.RUNTIME_DATA, label, '$.schemaVersion');
  requireId(value.id, label, '$.id');

  const artifactIds = new Set();
  const directions = new Map();
  for (const [index, artifact] of requireArray(
    value.mappingArtifacts,
    label,
    '$.mappingArtifacts',
  ).entries()) {
    const path = `$.mappingArtifacts[${index}]`;
    validateDecodedArtifact(artifact, ARTIFACT_KIND.FML_MAPPINGS, label, path);
    if (artifactIds.has(artifact.id)) fail(label, `${path}.id`, `duplicates "${artifact.id}"`);
    artifactIds.add(artifact.id);

    const direction = `${artifact.data.direction.from}->${artifact.data.direction.to}`;
    if (directions.has(direction)) {
      fail(label, path, `duplicates direction ${direction}`);
    }
    directions.set(direction, artifact);
  }
  if (directions.size === 0) fail(label, '$.mappingArtifacts', 'must not be empty');

  const tables = new Map();
  for (const [index, artifact] of requireArray(
    value.fhirTableArtifacts,
    label,
    '$.fhirTableArtifacts',
  ).entries()) {
    const path = `$.fhirTableArtifacts[${index}]`;
    validateDecodedArtifact(artifact, ARTIFACT_KIND.FHIR_TABLE, label, path);
    if (artifactIds.has(artifact.id)) fail(label, `${path}.id`, `duplicates "${artifact.id}"`);
    artifactIds.add(artifact.id);

    const tableVersion = artifact.data.fhirVersion;
    if (tables.has(tableVersion)) fail(label, path, `duplicates FHIR table ${tableVersion}`);
    tables.set(tableVersion, artifact);
  }

  const sourceModels = new Map();
  const modelIds = new Map();
  for (const [index, entry] of requireArray(
    value.fhirPathModels,
    label,
    '$.fhirPathModels',
  ).entries()) {
    const path = `$.fhirPathModels[${index}]`;
    requireObject(entry, label, path);
    requireFields(entry, ['modelId', 'sourceVersions', 'model'], [], label, path);
    requireId(entry.modelId, label, `${path}.modelId`);
    if (entry.model === null || typeof entry.model !== 'object') {
      fail(label, `${path}.model`, 'must be a FHIRPath model object');
    }
    if (modelIds.has(entry.modelId)) fail(label, `${path}.modelId`, `duplicates "${entry.modelId}"`);
    modelIds.set(entry.modelId, entry.model);

    for (const sourceVersion of requireUniqueStrings(
      entry.sourceVersions,
      label,
      `${path}.sourceVersions`,
      { nonEmpty: true, sorted: true },
    )) {
      if (!FHIR_VERSIONS.has(sourceVersion)) {
        fail(label, `${path}.sourceVersions`, `contains unsupported version ${sourceVersion}`);
      }
      if (sourceModels.has(sourceVersion)) {
        fail(label, `${path}.sourceVersions`, `duplicates source model for ${sourceVersion}`);
      }
      sourceModels.set(sourceVersion, entry);
    }
  }

  for (const [direction, artifact] of directions) {
    const { from, to } = artifact.data.direction;
    for (const version of [from, to]) {
      const tableVersion = TABLE_VERSION[version];
      if (!tables.has(tableVersion)) {
        fail(label, '$.fhirTableArtifacts', `${direction} requires FHIR table ${tableVersion}`);
      }
    }
    if (!sourceModels.has(from)) {
      fail(label, '$.fhirPathModels', `${direction} requires a source model for ${from}`);
    }
  }

  if (cacheable) validatedRuntimeData.add(value);

  return value;
}

/**
 * Validate one runtime-data module or an array selected for one factory.
 *
 * Exact duplicate artifacts are allowed across modules and are deduplicated by
 * the factory later. The same logical artifact, direction, table version, or
 * source model cannot resolve to conflicting content.
 *
 * @param {*} selection Runtime data module or non-empty array of modules.
 * @returns {Object[]} Validated modules in caller order.
 */
export function validateRuntimeDataSelection(selection) {
  const modules = Array.isArray(selection) ? selection : [selection];
  const label = 'Runtime data selection';
  if (modules.length === 0) fail(label, '$', 'must not be empty');

  const artifacts = new Map();
  const directions = new Map();
  const tables = new Map();
  const sourceModels = new Map();
  const modelObjects = new Map();

  /**
   * Record an artifact identity and reject a hash conflict.
   *
   * @param {Object} artifact Decoded artifact.
   * @returns {void}
   */
  function recordArtifact(artifact) {
    const previous = artifacts.get(artifact.id);
    if (previous && previous.sha256 !== artifact.sha256) {
      fail(label, '$', `has conflicting hashes for artifact "${artifact.id}"`);
    }
    artifacts.set(artifact.id, artifact);
  }

  for (const module of modules) {
    validateRuntimeData(module);

    for (const artifact of module.mappingArtifacts) {
      recordArtifact(artifact);
      const direction = `${artifact.data.direction.from}->${artifact.data.direction.to}`;
      const previous = directions.get(direction);
      if (previous && (previous.id !== artifact.id || previous.sha256 !== artifact.sha256)) {
        fail(label, '$', `has conflicting artifacts for direction ${direction}`);
      }
      directions.set(direction, artifact);
    }

    for (const artifact of module.fhirTableArtifacts) {
      recordArtifact(artifact);
      const version = artifact.data.fhirVersion;
      const previous = tables.get(version);
      if (previous && (previous.id !== artifact.id || previous.sha256 !== artifact.sha256)) {
        fail(label, '$', `has conflicting artifacts for FHIR table ${version}`);
      }
      tables.set(version, artifact);
    }

    for (const entry of module.fhirPathModels) {
      const previousModel = modelObjects.get(entry.modelId);
      if (previousModel && previousModel !== entry.model) {
        fail(label, '$', `has conflicting objects for FHIRPath model "${entry.modelId}"`);
      }
      modelObjects.set(entry.modelId, entry.model);

      for (const sourceVersion of entry.sourceVersions) {
        const previous = sourceModels.get(sourceVersion);
        if (previous && previous.modelId !== entry.modelId) {
          fail(label, '$', `has conflicting FHIRPath models for ${sourceVersion}`);
        }
        sourceModels.set(sourceVersion, entry);
      }
    }
  }

  return modules;
}
