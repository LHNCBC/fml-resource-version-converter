/**
 * @fileoverview Node-only loading for complete alternate runtime roots.
 *
 * Alternate roots are trusted maintainer inputs. Loading their JavaScript
 * artifact modules executes code from the selected root before the exported
 * envelopes are decoded and validated.
 *
 * @module tools/runtime-data-root
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import dstu2Model from 'fhirpath/fhir-context/dstu2/index.js';
import r4Model from 'fhirpath/fhir-context/r4/index.js';
import r5Model from 'fhirpath/fhir-context/r5/index.js';
import stu3Model from 'fhirpath/fhir-context/stu3/index.js';
import { decodeArtifact } from '../src/runtime/decode.js';
import {
  assembleDecodedRuntimeData,
  createFhirPathModel,
} from '../src/runtime/assembler.js';
import {
  canonicalStringify,
  validateManifest,
} from '../src/runtime/schema.js';
import { validateRuntimeRootArtifacts } from './runtime-root-validation.js';

/**
 * Resolve and validate a selected runtime root directory.
 *
 * @param {string} runtimeDataRoot Caller-selected runtime root.
 * @returns {string} Absolute directory path.
 */
function resolveRoot(runtimeDataRoot) {
  if (typeof runtimeDataRoot !== 'string' || runtimeDataRoot.length === 0) {
    throw new TypeError('Runtime data root must be a non-empty directory path');
  }
  const root = path.resolve(runtimeDataRoot);
  let stats;
  try {
    stats = fs.statSync(root);
  } catch (error) {
    throw new Error(`Runtime data root cannot be read: ${root}: ${error.message}`, {
      cause: error,
    });
  }
  if (!stats.isDirectory()) throw new Error(`Runtime data root is not a directory: ${root}`);

  return root;
}

/**
 * Read and validate a canonical runtime manifest.
 *
 * @param {string} root Absolute runtime root.
 * @returns {{manifest: Object, text: string}} Parsed manifest and exact source.
 */
function readManifest(root) {
  const file = path.join(root, 'manifest.json');
  let text;
  let manifest;
  try {
    text = fs.readFileSync(file, 'utf8');
    manifest = JSON.parse(text);
  } catch (error) {
    throw new Error(`Runtime manifest cannot be read: ${file}: ${error.message}`, {
      cause: error,
    });
  }
  validateManifest(manifest);
  if (text !== `${canonicalStringify(manifest)}\n`) {
    throw new Error(`Runtime manifest is not canonical JSON: ${file}`);
  }

  return { manifest, text };
}

/**
 * Import one dependency-free artifact module from its exact source bytes.
 *
 * @param {string} root Absolute runtime root.
 * @param {Object} entry Manifest artifact entry.
 * @returns {Promise<Object>} Exported artifact envelope.
 */
async function importEnvelope(root, entry) {
  const file = path.join(root, ...entry.modulePath.split('/'));
  let source;
  try {
    source = fs.readFileSync(file);
  } catch (error) {
    throw new Error(`Runtime artifact module cannot be read: ${file}: ${error.message}`, {
      cause: error,
    });
  }
  const moduleUrl = `data:text/javascript;base64,${source.toString('base64')}`;

  let imported;
  try {
    imported = await import(moduleUrl);
  } catch (error) {
    throw new Error(`Runtime artifact module cannot be imported: ${file}: ${error.message}`, {
      cause: error,
    });
  }
  if (!Object.hasOwn(imported, 'default')) {
    throw new Error(`Runtime artifact module has no default export: ${file}`);
  }

  return imported.default;
}

/**
 * Load and validate every artifact in a complete alternate runtime root.
 *
 * This lower-level result is used by maintainer generation when verified FHIR
 * table artifacts are reused. Ordinary converter setup should call
 * `loadRuntimeDataRoot()` instead.
 *
 * @param {string} runtimeDataRoot Complete trusted runtime root.
 * @returns {Promise<{root: string, manifest: Object, artifacts: Object[]}>}
 *   Validated manifest plus loaded envelope and decoded artifact records.
 */
export async function loadRuntimeArtifactRoot(runtimeDataRoot) {
  const root = resolveRoot(runtimeDataRoot);
  const { manifest, text } = readManifest(root);
  const artifacts = [];
  for (const entry of manifest.artifacts) {
    const envelope = await importEnvelope(root, entry);
    artifacts.push(Object.freeze({
      entry,
      envelope,
      decoded: decodeArtifact(envelope),
    }));
  }
  validateRuntimeRootArtifacts(manifest, artifacts);

  return Object.freeze({
    root,
    manifest,
    manifestSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    artifacts: Object.freeze(artifacts),
  });
}

/**
 * Load a complete trusted runtime root into opaque converter runtime data.
 *
 * Loading is asynchronous because Node imports the artifact modules. After the
 * returned promise resolves, converter construction and conversion remain
 * synchronous.
 *
 * @param {string} runtimeDataRoot Complete trusted runtime root.
 * @returns {Promise<Object>} Frozen runtime data accepted by converterFactory.
 */
export async function loadRuntimeDataRoot(runtimeDataRoot) {
  const loaded = await loadRuntimeArtifactRoot(runtimeDataRoot);
  const mappingArtifacts = loaded.artifacts
    .filter(item => item.decoded.kind === 'fml-mappings')
    .map(item => item.decoded);
  const fhirTableArtifacts = loaded.artifacts
    .filter(item => item.decoded.kind === 'fhir-table')
    .map(item => item.decoded);

  return assembleDecodedRuntimeData({
    id: `runtime/root-${loaded.manifestSha256.slice(0, 16)}`,
    mappingArtifacts,
    fhirTableArtifacts,
    fhirPathModels: [
      createFhirPathModel('fhirpath/dstu2', ['R2'], dstu2Model),
      createFhirPathModel('fhirpath/stu3', ['R3'], stu3Model),
      createFhirPathModel('fhirpath/r4', ['R4', 'R4B'], r4Model),
      createFhirPathModel('fhirpath/r5', ['R5'], r5Model),
    ],
  });
}
