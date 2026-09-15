#!/usr/bin/env node
/**
 * @fileoverview Derive runtime FHIR lookup tables directly from a spec ZIP.
 *
 * The parser reads the archive once, hashes the exact bytes it parses, and
 * extracts only the two bundle paths declared by the source dataset. It does
 * not create a persistent intermediate directory.
 *
 * A single pass over the StructureDefinitions derives four sibling sub-tables,
 * all keyed by FHIR dotted path: polyPaths, arrayPaths, elementTypes, and
 * contentReferences. Deriving them together keeps the cost at one archive read
 * per version and stops the tables drifting apart in their reading of the
 * source data.
 *
 * contentReferences maps a path whose child definitions are supplied by another
 * element of the same StructureDefinition to that referenced path (for example
 * "Questionnaire.item.item" -> "Questionnaire.item"). The FML engine uses it to
 * resolve schema metadata below recursive backbone elements. DSTU2 predates the
 * `contentReference` element and expresses the same idea as `nameReference`
 * (a pointer to another element's `name`); both spellings are normalized into
 * this one table, so the table is populated for every supported version.
 *
 * @module tools/fhir-spec-parser
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { canonicalStringify } from '../src/runtime/schema.js';
import { processElements } from './fhir-tables-lib.js';

/**
 * Normalize an archive entry name for comparison with source configuration.
 *
 * @param {string} entryName ZIP entry name.
 * @returns {string} POSIX-style entry name.
 */
function normalizeEntryName(entryName) {
  return entryName.replaceAll('\\', '/');
}

/**
 * Read and open a specification archive from exact file bytes.
 *
 * @param {string} archiveFile Archive filename.
 * @returns {Promise<{sha256: string, zip: JSZip}>} Open archive.
 */
async function openArchive(archiveFile) {
  let bytes;
  try {
    bytes = fs.readFileSync(archiveFile);
  } catch (error) {
    throw new Error(`FHIR specification archive cannot be read: ${archiveFile}: ${error.message}`, {
      cause: error,
    });
  }

  let zip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (error) {
    throw new Error(`FHIR specification archive is not a readable ZIP: ${archiveFile}: ${error.message}`, {
      cause: error,
    });
  }

  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    zip,
  };
}

/**
 * Select the exact declared bundle entries from an open ZIP.
 *
 * @param {JSZip} zip Open ZIP archive.
 * @param {string[]} bundlePaths Declared POSIX bundle paths.
 * @param {string} archiveFile Archive name for diagnostics.
 * @returns {Object[]} Selected JSZip entries in declared order.
 */
function selectBundleEntries(zip, bundlePaths, archiveFile) {
  if (!Array.isArray(bundlePaths) || bundlePaths.length !== 2) {
    throw new Error('FHIR specification bundlePaths must contain exactly two paths');
  }
  const entryByPath = new Map();
  zip.forEach((entryName, entry) => {
    if (!entry.dir) entryByPath.set(normalizeEntryName(entryName), entry);
  });

  return bundlePaths.map(bundlePath => {
    const entry = entryByPath.get(bundlePath);
    if (!entry) {
      throw new Error(
        `FHIR specification archive ${archiveFile} does not contain ${bundlePath}`,
      );
    }

    return entry;
  });
}

/**
 * Verify that an archive is readable and contains its declared bundles.
 *
 * @param {Object} options Archive options.
 * @param {string} options.archiveFile Archive filename.
 * @param {string[]} options.bundlePaths Declared ZIP-internal paths.
 * @returns {Promise<{sha256: string}>} Exact archive digest.
 */
export async function inspectFhirSpecArchive({ archiveFile, bundlePaths }) {
  const opened = await openArchive(archiveFile);
  selectBundleEntries(opened.zip, bundlePaths, archiveFile);

  return Object.freeze({ sha256: opened.sha256 });
}

/**
 * Derive deterministic lookup tables from one specification archive.
 *
 * @param {Object} options Parser options.
 * @param {string} options.tableVersion Runtime FHIR table label.
 * @param {string} options.archiveFile Archive filename.
 * @param {string[]} options.bundlePaths Exact ZIP-internal bundle paths.
 * @returns {Promise<{data: Object, sha256: string, stats: Object}>} Derived data,
 *   exact archive hash, and diagnostics.
 */
export async function parseFhirSpecArchive({ tableVersion, archiveFile, bundlePaths }) {
  const opened = await openArchive(archiveFile);
  const entries = selectBundleEntries(opened.zip, bundlePaths, archiveFile);
  const polyPaths = new Map();
  const arrayPaths = new Set();
  const elementTypes = new Map();
  const resourceTypes = new Set();
  const contentReferences = new Map();
  const stats = {
    structureDefinitions: 0,
    skippedStructureDefinitions: 0,
    elements: 0,
    missingTypeCodes: 0,
    contentReferenceIssues: 0,
  };

  for (const entry of entries) {
    let bundle;
    try {
      bundle = JSON.parse(await entry.async('string'));
    } catch (error) {
      throw new Error(`FHIR bundle cannot be parsed: ${entry.name}: ${error.message}`, {
        cause: error,
      });
    }
    if (bundle.resourceType !== 'Bundle') {
      throw new Error(`FHIR bundle ${entry.name} does not declare resourceType Bundle`);
    }

    for (const bundleEntry of bundle.entry || []) {
      const definition = bundleEntry.resource;
      if (definition?.resourceType !== 'StructureDefinition') continue;
      stats.structureDefinitions++;
      if (definition.kind === 'resource') {
        const typeName = definition.type || definition.id || definition.name;
        if (typeName) resourceTypes.add(typeName);
      }

      const elements = definition.snapshot?.element || definition.differential?.element || [];
      if (elements.length === 0) {
        stats.skippedStructureDefinitions++;
        continue;
      }
      stats.elements += processElements(
        elements,
        polyPaths,
        arrayPaths,
        elementTypes,
        () => stats.missingTypeCodes++,
        definition.id || definition.name || '(unknown)',
        contentReferences,
        () => stats.contentReferenceIssues++,
      );
    }
  }

  const polyPathsObject = {};
  for (const key of [...polyPaths.keys()].sort()) {
    polyPathsObject[key] = [...polyPaths.get(key)].sort();
  }
  const elementTypesObject = {};
  for (const key of [...elementTypes.keys()].sort()) {
    elementTypesObject[key] = elementTypes.get(key);
  }
  const contentReferencesObject = {};
  for (const key of [...contentReferences.keys()].sort()) {
    contentReferencesObject[key] = contentReferences.get(key);
  }

  return Object.freeze({
    data: Object.freeze({
      fhirVersion: tableVersion,
      polyPaths: polyPathsObject,
      arrayPaths: [...arrayPaths].sort(),
      elementTypes: elementTypesObject,
      contentReferences: contentReferencesObject,
      resourceTypes: [...resourceTypes].sort(),
    }),
    sha256: opened.sha256,
    stats: Object.freeze(stats),
  });
}

/**
 * Run the investigation-oriented command-line interface.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {Promise<number>} Process exit code.
 */
export async function main(argv) {
  if (argv.length !== 4 || argv.includes('--help') || argv.includes('-h')) {
    console.error(
      'Usage: node tools/fhir-spec-parser.js ' +
      '<TABLE_VERSION> <ARCHIVE.zip> <profiles-resources-path> <profiles-types-path>',
    );

    return argv.includes('--help') || argv.includes('-h') ? 0 : 2;
  }
  const [tableVersion, archiveFile, resourcesPath, typesPath] = argv;
  try {
    const result = await parseFhirSpecArchive({
      tableVersion,
      archiveFile,
      bundlePaths: [resourcesPath, typesPath],
    });
    process.stdout.write(`${canonicalStringify(result.data)}\n`);
    console.error(
      `Derived ${tableVersion} from ${path.basename(archiveFile)} ` +
      `(${result.stats.elements} elements, sha256 ${result.sha256}).`,
    );

    return 0;
  } catch (error) {
    console.error(`Error: ${error.message}`);

    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
