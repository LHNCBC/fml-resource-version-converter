/**
 * @fileoverview Independent runtime-data component generation and copying.
 *
 * FML mappings and FHIR tables each own one directory and one manifest
 * section. Builders replace only their selected component. The full builder
 * invokes the same component implementations in one runtime root.
 *
 * @module tools/runtime-data-generator
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { decodeArtifact } from '../src/runtime/decode.js';
import {
  ARTIFACT_KIND,
  canonicalStringify,
  manifestArtifacts,
  SCHEMA_VERSION,
  validateManifest,
  validateManifestComponent,
} from '../src/runtime/schema.js';
import { conceptMapPath, extractConceptMapUrls } from './conceptmaps.js';
import { parseFhirSpecArchive } from './fhir-spec-parser.js';
import { scanResourceMappings } from './fml-mapping-catalog.js';
import {
  ARTIFACT_CODEC,
  COMPRESSION_LEVEL,
  compactConceptMap,
  createArtifactEnvelope,
  createFhirTablePayload,
  createFmlMappingsPayload,
  createManifestArtifact,
  GENERATOR_NAME,
  GENERATOR_VERSION,
  renderArtifactModule,
} from './runtime-artifacts-lib.js';
import { loadRuntimeArtifactRoot } from './runtime-data-root.js';
import {
  loadSourceDataset,
  SOURCE_COMPONENT,
} from './runtime-data-sources.js';

export const RUNTIME_COMPONENT = SOURCE_COMPONENT;

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

const COMPONENT_INFO = Object.freeze({
  [RUNTIME_COMPONENT.FML_MAPPINGS]: Object.freeze({
    manifestKey: 'fmlMappings',
    directory: 'fml-mappings',
    kind: ARTIFACT_KIND.FML_MAPPINGS,
  }),
  [RUNTIME_COMPONENT.FHIR_TABLES]: Object.freeze({
    manifestKey: 'fhirTables',
    directory: 'fhir-tables',
    kind: ARTIFACT_KIND.FHIR_TABLE,
  }),
});

const requireForGenerator = createRequire(import.meta.url);
const { version: FFLATE_VERSION } = requireForGenerator('fflate/package.json');
const XVER_CONCEPT_MAP_PREFIX = 'http://hl7.org/fhir/uv/xver/ConceptMap/';

/**
 * Return every file below a root in deterministic relative-path order.
 *
 * @param {string} root Directory to scan.
 * @returns {string[]} Root-relative POSIX paths.
 */
export function listFiles(root) {
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
 * Convert an absolute source mapping descriptor to its artifact form.
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

    return compactConceptMap(
      source,
      path.relative(xverRoot, sourceFile).split(path.sep).join('/'),
      url,
    );
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
 * Return deterministic artifact format metadata.
 *
 * @returns {Object} Component format record.
 */
function artifactFormat() {
  return {
    canonicalJson: 'sorted-object-keys-v1',
    payloadEncoding: 'base64',
    hash: 'sha256',
    compression: {
      codec: ARTIFACT_CODEC,
      implementation: 'fflate',
      implementationVersion: FFLATE_VERSION,
      level: COMPRESSION_LEVEL,
    },
  };
}

/**
 * Write a UTF-8 file under a runtime root.
 *
 * @param {string} root Runtime root.
 * @param {string} relative Root-relative POSIX path.
 * @param {string} text Content.
 * @returns {void}
 */
function writeText(root, relative, text) {
  const file = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

/**
 * Write and round-trip one runtime artifact.
 *
 * @param {string} root Candidate runtime root.
 * @param {Object[]} artifacts Component manifest artifact accumulator.
 * @param {Object} options Artifact inputs.
 * @returns {void}
 */
function writeArtifact(root, artifacts, { id, kind, sourceIds, data, modulePath }) {
  const { envelope, canonicalJson } = createArtifactEnvelope({ id, kind, sourceIds, data });
  const decoded = decodeArtifact(envelope);
  if (canonicalStringify(decoded.data) !== canonicalJson) {
    throw new Error(`Runtime artifact "${id}": round-trip content differs`);
  }
  writeText(root, modulePath, renderArtifactModule(envelope));
  artifacts.push(createManifestArtifact(envelope, modulePath, data));
}

/**
 * Project a configured FML source into generated manifest provenance.
 *
 * @param {Object} source Loaded FML source record.
 * @returns {Object} Manifest source record.
 */
function fmlManifestSource(source) {
  const result = {
    id: source.id,
    uri: source.uri,
    commit: source.commit,
    date: source.date,
    license: source.license,
    modifiedFromUpstream: source.modifiedFromUpstream,
    sha256: hashTree(source.inputRoot),
  };
  if (source.modifications !== undefined) result.modifications = source.modifications;

  return result;
}

/**
 * Project a configured FHIR source into generated manifest provenance.
 *
 * @param {Object} source Loaded FHIR source record.
 * @param {string} sha256 Exact parsed archive digest.
 * @returns {Object} Manifest source record.
 */
function fhirManifestSource(source, sha256) {
  return {
    id: source.id,
    uri: source.uri,
    version: source.version,
    date: source.date,
    license: source.license,
    sha256,
  };
}

/**
 * Generate one component into a runtime root the caller has already cleared.
 *
 * @param {string} component Runtime component.
 * @param {string} datasetRoot Source dataset root.
 * @param {string} root Runtime root to write into.
 * @returns {Promise<Object>} Generated manifest component section.
 */
async function generateComponentInto(component, datasetRoot, root) {
  const info = COMPONENT_INFO[component];
  if (!info) throw new Error(`Unsupported runtime component: ${String(component)}`);
  const dataset = loadSourceDataset(datasetRoot, component);
  const artifacts = [];
  const sources = [];

  if (component === RUNTIME_COMPONENT.FML_MAPPINGS) {
    const source = dataset.sources[0];
    sources.push(fmlManifestSource(source));
    for (const [fromVer, toVer] of DIRECTION_PAIRS) {
      const pair = `${fromVer}to${toVer}`;
      writeArtifact(root, artifacts, {
        id: `fml-mappings/${pair}`,
        kind: ARTIFACT_KIND.FML_MAPPINGS,
        sourceIds: [source.id],
        data: collectFmlMappingsPayload(fromVer, toVer, source.inputRoot),
        modulePath: `fml-mappings/${pair}.js`,
      });
    }
  } else {
    for (const source of dataset.sources) {
      const parsed = await parseFhirSpecArchive(source);
      sources.push(fhirManifestSource(source, parsed.sha256));
      writeArtifact(root, artifacts, {
        id: `fhir-tables/${source.tableVersion}`,
        kind: ARTIFACT_KIND.FHIR_TABLE,
        sourceIds: [source.id],
        data: createFhirTablePayload(parsed.data),
        modulePath: `fhir-tables/${source.tableVersion}.js`,
      });
    }
  }

  const section = {
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    format: artifactFormat(),
    sources,
    artifacts,
  };
  validateManifestComponent(section, info.manifestKey);

  return section;
}

/**
 * Verify a requested runtime output is safe and does not overlap inputs.
 *
 * @param {string} output Requested runtime root.
 * @param {string[]} sourceRoots Protected input roots.
 * @returns {string} Absolute output path.
 */
function safeOutputPath(output, sourceRoots) {
  if (typeof output !== 'string' || output.length === 0) {
    throw new Error('Runtime data root is required');
  }
  const resolved = path.resolve(output);
  if (resolved === path.parse(resolved).root) {
    throw new Error('Runtime data root must not be a filesystem root');
  }
  for (const sourceRoot of sourceRoots.map(value => path.resolve(value))) {
    if (resolved === sourceRoot || sourceRoot.startsWith(`${resolved}${path.sep}`) ||
        resolved.startsWith(`${sourceRoot}${path.sep}`)) {
      throw new Error(`Runtime data root ${resolved} overlaps protected input ${sourceRoot}`);
    }
  }

  return resolved;
}

/**
 * Read the existing manifest structure for a component update.
 *
 * The unowned component is deliberately not validated by the active builder.
 *
 * @param {string} root Existing runtime root.
 * @returns {Object} Parsed manifest.
 */
function readManifestForUpdate(root) {
  const file = path.join(root, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Runtime manifest cannot be read for update: ${file}: ${error.message}`, {
      cause: error,
    });
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest) ||
      manifest.schemaVersion !== SCHEMA_VERSION.MANIFEST ||
      manifest.components === null || typeof manifest.components !== 'object' ||
      Array.isArray(manifest.components)) {
    throw new Error(`Runtime manifest cannot be updated as schema ${SCHEMA_VERSION.MANIFEST}: ${file}`);
  }

  return manifest;
}

/**
 * Read a runtime root's manifest for update, or start an empty one.
 *
 * @param {string} root Runtime root, which need not exist yet.
 * @returns {Object} Manifest to update in place.
 */
function openManifestForUpdate(root) {
  return fs.existsSync(path.join(root, 'manifest.json'))
    ? readManifestForUpdate(root)
    : { schemaVersion: SCHEMA_VERSION.MANIFEST, components: {} };
}

/**
 * Write a manifest to a runtime root in canonical form.
 *
 * @param {string} root Runtime root.
 * @param {Object} manifest Manifest to write.
 * @returns {void}
 */
function writeManifest(root, manifest) {
  writeText(root, 'manifest.json', `${canonicalStringify(manifest)}\n`);
}

/**
 * Remove one component from a runtime root before it is rebuilt or replaced.
 *
 * The manifest section is dropped first and written out, so a run interrupted
 * at any later point leaves a root that simply lacks this component instead of
 * a directory and manifest that disagree.
 *
 * @param {string} root Runtime root.
 * @param {Object} info Component descriptor.
 * @param {Object} manifest Manifest being updated in place.
 * @returns {void}
 */
function clearComponent(root, info, manifest) {
  delete manifest.components[info.manifestKey];
  writeManifest(root, manifest);
  fs.rmSync(path.join(root, info.directory), { recursive: true, force: true });
}

/**
 * Build one independently owned runtime component in place.
 *
 * The other component is never read or written. A failed build leaves the
 * target without this component; recover from an explicit copy, or from
 * version control.
 *
 * @param {Object} options Build options.
 * @param {'fml-mappings'|'fhir-tables'} options.component Component to build.
 * @param {string} options.datasetRoot Dataset containing `sources.yaml`.
 * @param {string} options.runtimeDataRoot Target runtime-data root.
 * @returns {Promise<Object>} Generated component section.
 */
export async function buildRuntimeDataComponent({
  component,
  datasetRoot,
  runtimeDataRoot,
}) {
  const info = COMPONENT_INFO[component];
  if (!info) throw new Error(`Unsupported runtime component: ${String(component)}`);
  const output = safeOutputPath(runtimeDataRoot, [datasetRoot]);
  fs.mkdirSync(output, { recursive: true });

  const manifest = openManifestForUpdate(output);
  clearComponent(output, info, manifest);
  manifest.components[info.manifestKey] =
    await generateComponentInto(component, datasetRoot, output);
  writeManifest(output, manifest);

  return manifest.components[info.manifestKey];
}

/**
 * Build both components in place and validate the complete runtime root.
 *
 * @param {Object} options Build options.
 * @param {string} options.fmlDatasetRoot FML source dataset root.
 * @param {string} options.fhirDatasetRoot FHIR archive dataset root.
 * @param {string} options.runtimeDataRoot Target runtime-data root.
 * @returns {Promise<Object>} Complete validated manifest.
 */
export async function buildAllRuntimeData({
  fmlDatasetRoot,
  fhirDatasetRoot,
  runtimeDataRoot,
}) {
  const output = safeOutputPath(runtimeDataRoot, [fmlDatasetRoot, fhirDatasetRoot]);
  fs.mkdirSync(output, { recursive: true });

  const manifest = { schemaVersion: SCHEMA_VERSION.MANIFEST, components: {} };
  for (const info of Object.values(COMPONENT_INFO)) clearComponent(output, info, manifest);
  manifest.components.fmlMappings = await generateComponentInto(
    RUNTIME_COMPONENT.FML_MAPPINGS,
    fmlDatasetRoot,
    output,
  );
  manifest.components.fhirTables = await generateComponentInto(
    RUNTIME_COMPONENT.FHIR_TABLES,
    fhirDatasetRoot,
    output,
  );
  validateManifest(manifest);
  writeManifest(output, manifest);
  await loadRuntimeArtifactRoot(output);

  return manifest;
}

/**
 * Copy one generated component between runtime roots without rebuilding it.
 *
 * @param {Object} options Copy options.
 * @param {'fml-mappings'|'fhir-tables'} options.component Component to copy.
 * @param {string} options.fromRuntimeDataRoot Source runtime root.
 * @param {string} options.toRuntimeDataRoot Target runtime root.
 * @returns {Promise<Object>} Copied manifest component section.
 */
export async function copyRuntimeDataComponent({
  component,
  fromRuntimeDataRoot,
  toRuntimeDataRoot,
}) {
  const info = COMPONENT_INFO[component];
  if (!info) throw new Error(`Unsupported runtime component: ${String(component)}`);
  const from = path.resolve(fromRuntimeDataRoot);
  const to = safeOutputPath(toRuntimeDataRoot, [from]);
  const loaded = await loadRuntimeArtifactRoot(from, { complete: false, component });
  const section = loaded.manifest.components[info.manifestKey];
  if (!section) throw new Error(`Source runtime root has no ${component} component: ${from}`);

  fs.mkdirSync(to, { recursive: true });

  const manifest = openManifestForUpdate(to);
  clearComponent(to, info, manifest);
  fs.cpSync(path.join(from, info.directory), path.join(to, info.directory), {
    recursive: true,
  });
  manifest.components[info.manifestKey] = section;
  writeManifest(to, manifest);

  return section;
}

/**
 * Copy a complete runtime-data root without changing its contents.
 *
 * The source is validated before copying, and the destination must not exist.
 *
 * @param {Object} options Copy options.
 * @param {string} options.fromRuntimeDataRoot Source runtime root.
 * @param {string} options.toRuntimeDataRoot New target runtime root.
 * @returns {Promise<Object>} Loaded and validated target root.
 */
export async function copyRuntimeDataRoot({
  fromRuntimeDataRoot,
  toRuntimeDataRoot,
}) {
  const from = path.resolve(fromRuntimeDataRoot);
  const to = safeOutputPath(toRuntimeDataRoot, [from]);
  if (fs.existsSync(to)) {
    throw new Error(`Complete-copy target already exists: ${to}`);
  }
  await loadRuntimeArtifactRoot(from);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false });

    return await loadRuntimeArtifactRoot(to);
  } catch (error) {
    if (fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Rebuild selected source components in a temporary directory and compare.
 *
 * The selected runtime data is expected to be stable while it's being checked.
 * It's an error condition if the data changes during the check.
 *
 * @param {Object} options Check options.
 * @param {string} options.runtimeDataRoot Existing runtime root.
 * @param {'fml-mappings'|'fhir-tables'|'all'} [options.component='all']
 *   Component selection.
 * @param {string} [options.fmlDatasetRoot] FML source dataset root.
 * @param {string} [options.fhirDatasetRoot] FHIR source dataset root.
 * @returns {Promise<{fresh: true, outputsCompared: number}>} Check summary.
 */
export async function checkRuntimeDataFreshness({
  runtimeDataRoot,
  fmlDatasetRoot,
  fhirDatasetRoot,
  component = 'all',
}) {
  const info = component === 'all' ? null : COMPONENT_INFO[component];
  if (component !== 'all' && !info) {
    throw new Error(`Unsupported runtime component: ${String(component)}`);
  }
  const loadOptions = info ? { complete: false, component } : {};
  const existing = await loadRuntimeArtifactRoot(runtimeDataRoot, loadOptions);
  const sourceHashBefore = hashTree(existing.root);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-source-check-'));
  const candidateRoot = path.join(temporaryRoot, 'candidate');
  let primaryError;
  try {
    if (info) {
      await buildRuntimeDataComponent({
        component,
        datasetRoot: component === RUNTIME_COMPONENT.FML_MAPPINGS
          ? fmlDatasetRoot
          : fhirDatasetRoot,
        runtimeDataRoot: candidateRoot,
      });
    } else {
      await buildAllRuntimeData({
        fmlDatasetRoot,
        fhirDatasetRoot,
        runtimeDataRoot: candidateRoot,
      });
    }
    const candidate = await loadRuntimeArtifactRoot(candidateRoot, loadOptions);
    const existingArtifacts = info
      ? existing.manifest.components[info.manifestKey].artifacts
      : manifestArtifacts(existing.manifest);
    const candidateArtifacts = info
      ? candidate.manifest.components[info.manifestKey].artifacts
      : manifestArtifacts(candidate.manifest);
    const existingFiles = existingArtifacts.map(artifact => artifact.modulePath);
    const candidateFiles = candidateArtifacts.map(artifact => artifact.modulePath);
    if (canonicalStringify(existingFiles) !== canonicalStringify(candidateFiles)) {
      throw new Error('Runtime data root is stale; indexed output sets differ');
    }
    if (info) {
      const existingSection = existing.manifest.components[info.manifestKey];
      const candidateSection = candidate.manifest.components[info.manifestKey];
      if (canonicalStringify(existingSection) !== canonicalStringify(candidateSection)) {
        throw new Error(`Runtime data root is stale; ${component} manifest section differs`);
      }
    } else if (!fs.readFileSync(path.join(existing.root, 'manifest.json'))
      .equals(fs.readFileSync(path.join(candidate.root, 'manifest.json')))) {
      throw new Error('Runtime data root is stale; generated bytes differ for manifest.json');
    }
    const differences = existingFiles.filter(relative =>
      !fs.readFileSync(path.join(existing.root, ...relative.split('/')))
        .equals(fs.readFileSync(path.join(candidate.root, ...relative.split('/')))));
    if (differences.length > 0) {
      throw new Error(
        `Runtime data root is stale; generated bytes differ for ${differences.join(', ')}`,
      );
    }

    return Object.freeze({ fresh: true, outputsCompared: existingFiles.length + 1 });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let mutationError;
    try {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
      if (hashTree(existing.root) !== sourceHashBefore) {
        mutationError = new Error(
          `Unexpected Error: runtime data changed while the freshness check ran: ${existing.root}`
        );
      }
    } catch (error) {
      mutationError = error;
    }
    if (mutationError) {
      if (!primaryError) throw mutationError;
      if (primaryError.cause === undefined) primaryError.cause = mutationError;
      else primaryError.rootMutationError = mutationError;
    }
  }
}
