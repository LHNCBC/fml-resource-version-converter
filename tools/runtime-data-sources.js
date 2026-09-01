/**
 * @fileoverview Strict loading for human-maintained runtime source datasets.
 *
 * Every dataset is a directory containing a fixed `sources.yaml`. All input
 * paths in that file are resolved relative to the dataset directory.
 *
 * @module tools/runtime-data-sources
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

export const SOURCE_COMPONENT = Object.freeze({
  FML_MAPPINGS: 'fml-mappings',
  FHIR_TABLES: 'fhir-tables',
});

const SOURCE_SCHEMA_VERSION = 1;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const FHIR_TABLE_VERSIONS = Object.freeze(['DSTU2', 'STU3', 'R4', 'R4B', 'R5']);

/**
 * Require a plain object.
 *
 * @param {*} value Candidate value.
 * @param {string} location Diagnostic location.
 * @returns {Object} Validated object.
 */
function requireObject(value, location) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype &&
       Object.getPrototypeOf(value) !== null)) {
    throw new Error(`${location} must be a plain object`);
  }

  return value;
}

/**
 * Require exactly the declared fields.
 *
 * @param {Object} value Object to inspect.
 * @param {string[]} required Required fields.
 * @param {string[]} optional Optional fields.
 * @param {string} location Diagnostic location.
 * @returns {void}
 */
function requireFields(value, required, optional, location) {
  const allowed = new Set([...required, ...optional]);
  for (const field of required) {
    if (!Object.hasOwn(value, field)) throw new Error(`${location}.${field} is required`);
  }
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new Error(`${location}.${field} is not supported`);
  }
}

/**
 * Require a nonempty string.
 *
 * @param {*} value Candidate value.
 * @param {string} location Diagnostic location.
 * @returns {string} Validated string.
 */
function requireString(value, location) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${location} must be a nonempty string`);
  }

  return value;
}

/**
 * Require a safe relative POSIX path.
 *
 * @param {*} value Candidate path.
 * @param {string} location Diagnostic location.
 * @returns {string} Validated path.
 */
function requireRelativePath(value, location) {
  requireString(value, location);
  const segments = value.split('/');
  if (value.startsWith('/') || value.includes('\\') ||
      segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${location} must be a safe relative POSIX path`);
  }

  return value;
}

/**
 * Validate source fields shared by both dataset types.
 *
 * @param {Object} source Source record.
 * @param {string} location Diagnostic location.
 * @returns {void}
 */
function validateSharedFields(source, location) {
  requireString(source.id, `${location}.id`);
  if (!ID_RE.test(source.id) || source.id.includes('//')) {
    throw new Error(`${location}.id must be a safe logical identifier`);
  }
  for (const field of ['uri', 'license']) requireString(source[field], `${location}.${field}`);
  if (typeof source.date !== 'string' || !DATE_RE.test(source.date)) {
    throw new Error(`${location}.date must use YYYY-MM-DD`);
  }
}

/**
 * Validate one FML source record.
 *
 * @param {*} value Candidate source.
 * @param {string} location Diagnostic location.
 * @returns {Object} Validated source.
 */
function validateFmlSource(value, location) {
  const source = requireObject(value, location);
  requireFields(source, [
    'id',
    'inputPath',
    'uri',
    'commit',
    'date',
    'license',
    'modifiedFromUpstream',
  ], ['modifications'], location);
  validateSharedFields(source, location);
  requireRelativePath(source.inputPath, `${location}.inputPath`);
  requireString(source.commit, `${location}.commit`);
  if (typeof source.modifiedFromUpstream !== 'boolean') {
    throw new Error(`${location}.modifiedFromUpstream must be a boolean`);
  }
  if (source.modifications !== undefined &&
      (typeof source.modifications !== 'string' || source.modifications.trim().length === 0)) {
    throw new Error(`${location}.modifications must be nonempty when present`);
  }
  if (source.modifiedFromUpstream && source.modifications === undefined) {
    throw new Error(`${location}.modifications is required when modifiedFromUpstream is true`);
  }

  return source;
}

/**
 * Validate one FHIR archive source record.
 *
 * @param {*} value Candidate source.
 * @param {string} location Diagnostic location.
 * @returns {Object} Validated source.
 */
function validateFhirSource(value, location) {
  const source = requireObject(value, location);
  requireFields(source, [
    'id',
    'tableVersion',
    'version',
    'date',
    'license',
    'uri',
    'archivePath',
    'bundlePaths',
  ], [], location);
  validateSharedFields(source, location);
  requireString(source.version, `${location}.version`);
  requireRelativePath(source.archivePath, `${location}.archivePath`);
  if (!FHIR_TABLE_VERSIONS.includes(source.tableVersion)) {
    throw new Error(`${location}.tableVersion is not supported`);
  }
  if (!Array.isArray(source.bundlePaths) || source.bundlePaths.length !== 2) {
    throw new Error(`${location}.bundlePaths must contain exactly two paths`);
  }
  source.bundlePaths.forEach((bundlePath, index) => {
    requireRelativePath(bundlePath, `${location}.bundlePaths[${index}]`);
  });
  const names = source.bundlePaths.map(bundlePath => bundlePath.split('/').at(-1)).sort();
  if (names.join(',') !== 'profiles-resources.json,profiles-types.json') {
    throw new Error(`${location}.bundlePaths must identify the resource and type bundles`);
  }

  return source;
}

/**
 * Resolve and validate one dataset directory.
 *
 * @param {string} datasetRoot Caller-selected dataset root.
 * @returns {string} Absolute directory.
 */
function resolveDatasetRoot(datasetRoot) {
  if (typeof datasetRoot !== 'string' || datasetRoot.length === 0) {
    throw new TypeError('Dataset root must be a nonempty directory path');
  }
  const root = path.resolve(datasetRoot);
  let stats;
  try {
    stats = fs.statSync(root);
  } catch (error) {
    throw new Error(`Dataset root cannot be read: ${root}: ${error.message}`, { cause: error });
  }
  if (!stats.isDirectory()) throw new Error(`Dataset root is not a directory: ${root}`);

  return root;
}

/**
 * Require an input path to have the expected filesystem type.
 *
 * @param {string} file Absolute input path.
 * @param {'file'|'directory'} type Expected type.
 * @returns {void}
 */
function requireInput(file, type) {
  let stats;
  try {
    stats = fs.statSync(file);
  } catch (error) {
    throw new Error(`Source input cannot be read: ${file}: ${error.message}`, { cause: error });
  }
  if (type === 'file' ? !stats.isFile() : !stats.isDirectory()) {
    throw new Error(`Source input is not a ${type}: ${file}`);
  }
}

/**
 * Load and strictly validate one runtime source dataset.
 *
 * @param {string} datasetRoot Directory containing `sources.yaml` and inputs.
 * @param {'fml-mappings'|'fhir-tables'} component Dataset component type.
 * @param {Object} [options] Loading options.
 * @param {boolean} [options.requireInputs=true] Require declared inputs now.
 * @returns {{root: string, file: string, sources: Object[]}} Validated dataset.
 */
export function loadSourceDataset(datasetRoot, component, options = {}) {
  const { requireInputs = true } = options;
  const root = resolveDatasetRoot(datasetRoot);
  const file = path.join(root, 'sources.yaml');
  let document;
  try {
    document = yaml.load(fs.readFileSync(file, 'utf8'), { schema: yaml.JSON_SCHEMA });
  } catch (error) {
    throw new Error(`Source configuration cannot be read: ${file}: ${error.message}`, {
      cause: error,
    });
  }
  requireObject(document, 'Source configuration');
  requireFields(document, ['schemaVersion', 'sources'], [], 'Source configuration');
  if (document.schemaVersion !== SOURCE_SCHEMA_VERSION) {
    throw new Error(`Source configuration.schemaVersion must be ${SOURCE_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(document.sources) || document.sources.length === 0) {
    throw new Error('Source configuration.sources must be a nonempty array');
  }

  let sources;
  if (component === SOURCE_COMPONENT.FML_MAPPINGS) {
    if (document.sources.length !== 1) {
      throw new Error('FML source configuration must contain exactly one source');
    }
    sources = document.sources.map((source, index) =>
      validateFmlSource(source, `Source configuration.sources[${index}]`));
    sources = sources.map(source => ({
      ...source,
      inputRoot: path.join(root, ...source.inputPath.split('/')),
    }));
    if (requireInputs) requireInput(sources[0].inputRoot, 'directory');
  } else if (component === SOURCE_COMPONENT.FHIR_TABLES) {
    sources = document.sources.map((source, index) =>
      validateFhirSource(source, `Source configuration.sources[${index}]`));
    const ids = new Set();
    const versions = new Set();
    for (const [index, source] of sources.entries()) {
      if (ids.has(source.id)) {
        throw new Error(`Source configuration.sources[${index}].id duplicates "${source.id}"`);
      }
      if (versions.has(source.tableVersion)) {
        throw new Error(
          `Source configuration.sources[${index}].tableVersion duplicates ` +
          `"${source.tableVersion}"`,
        );
      }
      ids.add(source.id);
      versions.add(source.tableVersion);
    }
    if (FHIR_TABLE_VERSIONS.some(version => !versions.has(version)) ||
        versions.size !== FHIR_TABLE_VERSIONS.length) {
      throw new Error(
        `FHIR source configuration must contain exactly ${FHIR_TABLE_VERSIONS.join(', ')}`,
      );
    }
    sources = sources.map(source => ({
      ...source,
      archiveFile: path.join(root, ...source.archivePath.split('/')),
    }));
    if (requireInputs) sources.forEach(source => requireInput(source.archiveFile, 'file'));
  } else {
    throw new Error(`Unsupported source component: ${String(component)}`);
  }

  return Object.freeze({
    root,
    file,
    sources: Object.freeze(sources.map(source => Object.freeze(source))),
  });
}
