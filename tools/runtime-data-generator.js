/**
 * @fileoverview Deterministic runtime artifact collection and publication.
 *
 * This is maintainer-only Node code. It reads raw source material, builds and
 * validates a complete candidate root, then publishes that directory only
 * after every artifact and the manifest are valid.
 *
 * @module tools/runtime-data-generator
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { decodeArtifact } from '../src/runtime/decode.js';
import { loadRuntimeArtifactRoot } from './runtime-data-root.js';
import {
  ARTIFACT_KIND,
  canonicalStringify,
  SCHEMA_VERSION,
  validateManifest,
} from '../src/runtime/schema.js';
import {
  conceptMapPath,
  extractConceptMapUrls,
} from './conceptmaps.js';
import { scanResourceMappings } from './fml-mapping-catalog.js';
import {
  ARTIFACT_CODEC,
  COMPRESSION_LEVEL,
  createArtifactEnvelope,
  createFhirTablePayload,
  createFmlMappingsPayload,
  createManifestArtifact,
  compactConceptMap,
  GENERATOR_NAME,
  GENERATOR_VERSION,
  renderArtifactModule,
} from './runtime-artifacts-lib.js';

export const DIRECTION_PAIRS = Object.freeze([
  Object.freeze(['R2', 'R3']),
  Object.freeze(['R3', 'R2']),
  Object.freeze(['R3', 'R4']),
  Object.freeze(['R4', 'R3']),
  Object.freeze(['R4', 'R5']),
  Object.freeze(['R5', 'R4']),
  Object.freeze(['R4B', 'R5']),
  Object.freeze(['R5', 'R4B']),
]);
export const FHIR_TABLE_SOURCES = Object.freeze([
  Object.freeze({
    tableVersion: 'DSTU2',
    version: '1.0.2',
    date: '2015-10-24',
    archive: 'DSTU2/fhir-spec.zip',
    uri: 'https://hl7.org/fhir/DSTU2/fhir-spec.zip',
  }),
  Object.freeze({
    tableVersion: 'STU3',
    version: '3.0.2',
    date: '2019-10-24',
    archive: 'STU3/definitions.json.zip',
    uri: 'https://hl7.org/fhir/STU3/definitions.json.zip',
  }),
  Object.freeze({
    tableVersion: 'R4',
    version: '4.0.1',
    date: '2019-11-01',
    archive: 'R4/definitions.json.zip',
    uri: 'https://hl7.org/fhir/R4/definitions.json.zip',
  }),
  Object.freeze({
    tableVersion: 'R4B',
    version: '4.3.0',
    date: '2022-05-28',
    archive: 'R4B/definitions.json.zip',
    uri: 'https://hl7.org/fhir/R4B/definitions.json.zip',
  }),
  Object.freeze({
    tableVersion: 'R5',
    version: '5.0.0',
    date: '2023-03-26',
    archive: 'R5/definitions.json.zip',
    uri: 'https://hl7.org/fhir/R5/definitions.json.zip',
  }),
]);

const requireForGenerator = createRequire(import.meta.url);
const { version: FFLATE_VERSION } = requireForGenerator('fflate/package.json');

const XVER_CONCEPT_MAP_PREFIX = 'http://hl7.org/fhir/uv/xver/ConceptMap/';

/**
 * Read the authoritative provenance for a cross-version source snapshot.
 *
 * @param {string} file JSON provenance filename.
 * @returns {Object} Validated source metadata without a content hash.
 */
export function readCrossVersionSource(file) {
  let source;
  try {
    source = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Cross-version source metadata cannot be read: ${file}: ${error.message}`, {
      cause: error,
    });
  }
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error(`Cross-version source metadata must be an object: ${file}`);
  }

  const required = ['id', 'uri', 'commit', 'date', 'license'];
  const fields = Object.keys(source).sort();
  if (fields.join(',') !== [...required].sort().join(',')) {
    throw new Error(
      `Cross-version source metadata must contain exactly ${required.join(', ')}: ${file}`,
    );
  }
  for (const field of required) {
    if (typeof source[field] !== 'string' || source[field].length === 0) {
      throw new Error(`Cross-version source metadata ${field} must be non-empty: ${file}`);
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(source.date)) {
    throw new Error(`Cross-version source metadata date must use YYYY-MM-DD: ${file}`);
  }

  return Object.freeze({ ...source });
}

/**
 * Return every file below a root in deterministic relative-path order.
 *
 * @param {string} root Directory to scan.
 * @returns {string[]} Root-relative POSIX paths.
 */
function listFiles(root) {
  const files = [];

  /**
   * Visit one directory recursively.
   *
   * @param {string} directory Absolute directory.
   * @param {string} relativeDir Root-relative POSIX directory.
   * @returns {void}
   */
  function visit(directory, relativeDir) {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute, relative);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  }

  visit(root, '');

  return files;
}

/**
 * Hash one file with SHA-256.
 *
 * @param {string} file Absolute filename.
 * @returns {string} Lowercase digest.
 */
export function hashFile(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Hash a directory tree including relative filenames and exact file bytes.
 *
 * @param {string} root Directory to hash.
 * @returns {string} Lowercase digest.
 */
export function hashTree(root) {
  const hash = createHash('sha256');
  for (const relative of listFiles(root)) {
    hash.update(relative, 'utf8');
    hash.update(new Uint8Array([0]));
    hash.update(fs.readFileSync(path.join(root, ...relative.split('/'))));
    hash.update(new Uint8Array([0]));
  }

  return hash.digest('hex');
}

/**
 * Convert an absolute source mapping descriptor to its artifact representation.
 *
 * @param {Object} mapping Source mapping descriptor.
 * @param {string} xverRoot Cross-version input root.
 * @returns {Object} Portable mapping descriptor.
 */
function portableMappingDescriptor(mapping, xverRoot) {
  return {
    virtualFile: path.relative(xverRoot, mapping.filePath).split(path.sep).join('/'),
    structureMapUrl: mapping.structureMapUrl,
    structureMapName: mapping.structureMapName,
    entryGroup: mapping.entryGroup,
    sourceResourceType: mapping.sourceResourceType,
    sourceProfile: mapping.sourceProfile,
    targetResourceType: mapping.targetResourceType,
    targetProfile: mapping.targetProfile,
  };
}

/**
 * Collect one direction's FML, route catalog, and compact ConceptMaps.
 *
 * @param {string} fromVer Source version.
 * @param {string} toVer Target version.
 * @param {string} xverRoot Cross-version input root.
 * @returns {Object} Validated FML mappings payload.
 */
export function collectFmlMappingsPayload(fromVer, toVer, xverRoot) {
  const pair = `${fromVer}to${toVer}`;
  const pairDir = path.join(xverRoot, pair);
  const fileNames = fs.readdirSync(pairDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.fml'))
    .map(entry => entry.name)
    .sort();
  if (fileNames.length === 0) {
    throw new Error(`Runtime artifact "fml-mappings/${pair}": no FML files found in ${pairDir}`);
  }

  const files = Object.fromEntries(fileNames.map(fileName => [
    `${pair}/${fileName}`,
    fs.readFileSync(path.join(pairDir, fileName), 'utf8'),
  ]));
  const conceptMapUrls = new Set();
  for (const text of Object.values(files)) {
    for (const url of extractConceptMapUrls(text)) {
      const id = url.split('/').pop();
      if (id.startsWith('#')) continue;
      if (!url.startsWith(XVER_CONCEPT_MAP_PREFIX) || id.length === 0) {
        throw new Error(
          `Runtime artifact "fml-mappings/${pair}": unsupported ConceptMap URL "${url}"`,
        );
      }
      conceptMapUrls.add(url);
    }
  }

  const conceptMaps = [...conceptMapUrls].sort().map(url => {
    const sourceFile = conceptMapPath(url, xverRoot);
    let source;
    try {
      source = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
    } catch (error) {
      throw new Error(
        `Runtime artifact "fml-mappings/${pair}": cannot load ConceptMap ` +
        `${sourceFile}: ${error.message}`,
        { cause: error },
      );
    }
    const virtualFile = path.relative(xverRoot, sourceFile).split(path.sep).join('/');

    return compactConceptMap(source, virtualFile, url);
  });
  const mappings = [...scanResourceMappings(fromVer, toVer, xverRoot).values()]
    .flat()
    .map(mapping => portableMappingDescriptor(mapping, xverRoot))
    .sort((left, right) =>
      left.sourceResourceType.localeCompare(right.sourceResourceType) ||
      left.targetResourceType.localeCompare(right.targetResourceType) ||
      left.structureMapName.localeCompare(right.structureMapName) ||
      left.virtualFile.localeCompare(right.virtualFile));

  return createFmlMappingsPayload({
    direction: { from: fromVer, to: toVer },
    files,
    mappings,
    conceptMaps,
  });
}

/**
 * Write a UTF-8 text file below an output root.
 *
 * @param {string} root Output root.
 * @param {string} relative Root-relative POSIX path.
 * @param {string} text File content.
 * @returns {void}
 */
function writeText(root, relative, text) {
  const file = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

/**
 * Verify a requested output path is safe and distinct from source roots.
 *
 * @param {string} output Requested output path.
 * @param {string[]} sourceRoots Protected input roots.
 * @returns {string} Resolved output path.
 */
function safeOutputPath(output, sourceRoots) {
  if (typeof output !== 'string' || output.length === 0) {
    throw new Error('Runtime data output directory is required');
  }
  const resolved = path.resolve(output);
  if (resolved === path.parse(resolved).root) {
    throw new Error('Runtime data output must not be a filesystem root');
  }
  for (const sourceRoot of sourceRoots.map(value => path.resolve(value))) {
    if (resolved === sourceRoot || sourceRoot.startsWith(`${resolved}${path.sep}`) ||
        resolved.startsWith(`${sourceRoot}${path.sep}`)) {
      throw new Error(`Runtime data output ${resolved} overlaps source root ${sourceRoot}`);
    }
  }

  return resolved;
}

/**
 * Atomically publish a complete candidate directory.
 *
 * @param {string} candidate Complete candidate directory.
 * @param {string} output Destination directory.
 * @param {boolean} replace Whether an existing destination may be replaced.
 * @returns {void}
 */
function publishDirectory(candidate, output, replace) {
  if (!fs.existsSync(output)) {
    fs.renameSync(candidate, output);
    return;
  }
  if (!replace) {
    throw new Error(`Runtime data output already exists: ${output}; pass replace explicitly`);
  }

  const backup = `${output}.backup-${process.pid}`;
  if (fs.existsSync(backup)) {
    throw new Error(`Runtime data backup path already exists: ${backup}`);
  }
  fs.renameSync(output, backup);
  try {
    fs.renameSync(candidate, output);
  } catch (error) {
    fs.renameSync(backup, output);
    throw error;
  }
  fs.rmSync(backup, { recursive: true });
}

/**
 * Build and publish all Phase 1 runtime artifacts.
 *
 * @param {Object} options Generator options.
 * @param {string} options.output Output directory; required.
 * @param {string} options.xverRoot Cross-version source root.
 * @param {string} options.fhirDefsRoot Consolidated FHIR tables root.
 * @param {string} options.fhirSpecRoot Official specification archive root.
 * @param {string} [options.fhirTableRuntimeRoot] Verified runtime root whose
 *   FHIR table artifacts and provenance replace raw table inputs.
 * @param {Object} [options.xverSource] Cross-version provenance. By default,
 *   read from `source.json` beside the selected input root.
 * @param {string} [options.reviewOutput] Optional canonical JSON output root.
 * @param {boolean} [options.replace=false] Replace existing output directories.
 * @returns {Promise<Object>} Validated manifest.
 */
export async function generateRuntimeData({
  output,
  xverRoot,
  fhirDefsRoot,
  fhirSpecRoot,
  fhirTableRuntimeRoot,
  xverSource,
  reviewOutput,
  replace = false,
}) {
  const resolvedXverSource = xverSource || readCrossVersionSource(
    path.join(path.dirname(path.resolve(xverRoot)), 'source.json'),
  );
  const sourceRoots = fhirTableRuntimeRoot
    ? [xverRoot, fhirTableRuntimeRoot]
    : [xverRoot, fhirDefsRoot, fhirSpecRoot];
  const outputPath = safeOutputPath(output, sourceRoots);
  const reviewPath = reviewOutput ? safeOutputPath(reviewOutput, sourceRoots) : null;
  if (reviewPath && (
    reviewPath === outputPath ||
    reviewPath.startsWith(`${outputPath}${path.sep}`) ||
    outputPath.startsWith(`${reviewPath}${path.sep}`)
  )) {
    throw new Error('Runtime data output and review output must not overlap');
  }
  if (fs.existsSync(outputPath) && !replace) {
    throw new Error(`Runtime data output already exists: ${outputPath}; pass replace explicitly`);
  }
  if (reviewPath && fs.existsSync(reviewPath) && !replace) {
    throw new Error(`Runtime review output already exists: ${reviewPath}; pass replace explicitly`);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const candidate = fs.mkdtempSync(path.join(path.dirname(outputPath), '.runtime-data-'));
  let reviewCandidate = null;
  if (reviewPath) {
    fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
    reviewCandidate = fs.mkdtempSync(path.join(path.dirname(reviewPath), '.runtime-review-'));
  }

  try {
    const sources = [{
      ...resolvedXverSource,
      sha256: hashTree(xverRoot),
    }];
    const tableSourceByVersion = new Map();
    if (fhirTableRuntimeRoot) {
      const reused = await loadRuntimeArtifactRoot(fhirTableRuntimeRoot);
      const tableArtifacts = reused.artifacts.filter(
        item => item.decoded.kind === ARTIFACT_KIND.FHIR_TABLE,
      );
      const reusedSourceIds = new Set(
        tableArtifacts.flatMap(item => item.envelope.sourceIds),
      );
      for (const source of reused.manifest.sources) {
        if (!reusedSourceIds.has(source.id)) continue;
        if (source.id === resolvedXverSource.id) {
          throw new Error(`Reused FHIR table source conflicts with ${resolvedXverSource.id}`);
        }
        sources.push(source);
      }
      for (const item of tableArtifacts) {
        tableSourceByVersion.set(item.decoded.data.fhirVersion, item);
      }
    } else {
      for (const spec of FHIR_TABLE_SOURCES) {
        const defsFile = path.join(fhirDefsRoot, `${spec.tableVersion}.json`);
        const archiveFile = path.join(fhirSpecRoot, ...spec.archive.split('/'));
        const defs = JSON.parse(fs.readFileSync(defsFile, 'utf8'));
        if (defs.fhirVersion !== spec.tableVersion) {
          throw new Error(
            `FHIR definitions ${defsFile}: expected ${spec.tableVersion}, ` +
            `received ${String(defs.fhirVersion)}`,
          );
        }
        const sourceId = `hl7-fhir-${spec.tableVersion}`;
        sources.push({
          id: sourceId,
          uri: spec.uri,
          version: spec.version,
          date: spec.date,
          license: 'HL7 FHIR License',
          sha256: hashFile(archiveFile),
        });
        tableSourceByVersion.set(spec.tableVersion, { sourceId, defs });
      }
    }

    const artifacts = [];

    /**
     * Generate, validate, and write one artifact.
     *
     * @param {string} id Logical identity.
     * @param {string} kind Artifact kind.
     * @param {string[]} sourceIds Manifest source identities.
     * @param {Object} data Decoded artifact payload.
     * @param {string} modulePath Root-relative module path.
     * @returns {void}
     */
    function writeArtifact(id, kind, sourceIds, data, modulePath) {
      const { envelope, canonicalJson } = createArtifactEnvelope({
        id,
        kind,
        sourceIds,
        data,
      });
      const decoded = decodeArtifact(envelope);
      if (canonicalStringify(decoded.data) !== canonicalJson) {
        throw new Error(`Runtime artifact "${id}": round-trip content differs`);
      }

      writeText(candidate, modulePath, renderArtifactModule(envelope));
      if (reviewCandidate) {
        writeText(reviewCandidate, modulePath.replace(/\.js$/, '.json'), `${canonicalJson}\n`);
      }
      artifacts.push(createManifestArtifact(envelope, modulePath, data));
    }

    /**
     * Re-publish one already verified artifact without changing its bytes.
     *
     * @param {Object} item Loaded artifact record from a complete runtime root.
     * @returns {void}
     */
    function writeReusedArtifact(item) {
      writeText(candidate, item.entry.modulePath, renderArtifactModule(item.envelope));
      if (reviewCandidate) {
        writeText(
          reviewCandidate,
          item.entry.modulePath.replace(/\.js$/, '.json'),
          `${canonicalStringify(item.decoded.data)}\n`,
        );
      }
      artifacts.push(createManifestArtifact(
        item.envelope,
        item.entry.modulePath,
        item.decoded.data,
      ));
    }

    for (const [fromVer, toVer] of DIRECTION_PAIRS) {
      const pair = `${fromVer}to${toVer}`;
      writeArtifact(
        `fml-mappings/${pair}`,
        ARTIFACT_KIND.FML_MAPPINGS,
        [resolvedXverSource.id],
        collectFmlMappingsPayload(fromVer, toVer, xverRoot),
        `fml-mappings/${pair}.js`,
      );
    }

    for (const spec of FHIR_TABLE_SOURCES) {
      const tableSource = tableSourceByVersion.get(spec.tableVersion);
      if (fhirTableRuntimeRoot) {
        writeReusedArtifact(tableSource);
      } else {
        writeArtifact(
          `fhir-tables/${spec.tableVersion}`,
          ARTIFACT_KIND.FHIR_TABLE,
          [tableSource.sourceId],
          createFhirTablePayload(tableSource.defs),
          `fhir-tables/${spec.tableVersion}.js`,
        );
      }
    }

    const manifest = {
      schemaVersion: SCHEMA_VERSION.MANIFEST,
      generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
      format: {
        canonicalJson: 'sorted-object-keys-v1',
        payloadEncoding: 'base64',
        hash: 'sha256',
        compression: {
          codec: ARTIFACT_CODEC,
          implementation: 'fflate',
          implementationVersion: FFLATE_VERSION,
          level: COMPRESSION_LEVEL,
        },
      },
      sources,
      artifacts,
    };
    validateManifest(manifest);
    writeText(candidate, 'manifest.json', `${canonicalStringify(manifest)}\n`);

    publishDirectory(candidate, outputPath, replace);
    if (reviewCandidate) {
      publishDirectory(reviewCandidate, reviewPath, replace);
      reviewCandidate = null;
    }

    return manifest;
  } catch (error) {
    if (fs.existsSync(candidate)) fs.rmSync(candidate, { recursive: true });
    if (reviewCandidate && fs.existsSync(reviewCandidate)) {
      fs.rmSync(reviewCandidate, { recursive: true });
    }
    throw error;
  }
}

/**
 * Compare freshly generated indexed files with an existing runtime root.
 *
 * The selected root is only read. Generation occurs in a temporary directory,
 * which is removed before this function returns or throws.
 *
 * @param {Object} options Freshness options plus ordinary generator inputs.
 * @param {string} options.runtimeDataRoot Existing complete runtime root.
 * @returns {Promise<{fresh: true, filesCompared: number}>} Freshness summary.
 * @throws {Error} If validation or byte comparison fails.
 */
export async function checkRuntimeDataFreshness({ runtimeDataRoot, ...options }) {
  const existing = await loadRuntimeArtifactRoot(runtimeDataRoot);
  const sourceHashBefore = hashTree(existing.root);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-freshness-'));
  const candidateRoot = path.join(temporaryRoot, 'candidate');

  try {
    await generateRuntimeData({ ...options, output: candidateRoot });
    const candidate = await loadRuntimeArtifactRoot(candidateRoot);
    const relativeFiles = [
      'manifest.json',
      ...existing.manifest.artifacts.map(artifact => artifact.modulePath),
    ];
    const differences = relativeFiles.filter(relative => {
      const existingFile = path.join(existing.root, ...relative.split('/'));
      const candidateFile = path.join(candidate.root, ...relative.split('/'));

      return !fs.readFileSync(existingFile).equals(fs.readFileSync(candidateFile));
    });
    if (differences.length > 0) {
      throw new Error(
        `Runtime data root is stale; generated bytes differ for ${differences.join(', ')}`,
      );
    }

    return Object.freeze({ fresh: true, filesCompared: relativeFiles.length });
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    if (hashTree(existing.root) !== sourceHashBefore) {
      throw new Error(`Freshness check modified runtime data root: ${existing.root}`);
    }
  }
}
