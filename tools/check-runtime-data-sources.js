#!/usr/bin/env node
/**
 * @fileoverview Maintainer source-equivalence check for committed runtime data.
 *
 * This Node-only command derives FHIR tables from the ignored official
 * specification archives in a temporary directory, regenerates all indexed
 * runtime artifacts there, and compares their bytes with `data/runtime/`.
 * Neither the committed runtime root nor `data/fhir-defs/` is modified.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  checkRuntimeDataFreshness,
  FHIR_TABLE_SOURCES,
} from './runtime-data-generator.js';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(TOOL_DIR, '..');
const PARSER = path.join(TOOL_DIR, 'fhir-spec-parser.js');
const XVER_ROOT = path.join(PROJECT_ROOT, 'data/fhir-cross-version/input');
const FHIR_SPEC_ROOT = path.join(PROJECT_ROOT, 'data/fhir-spec-downloads');
const RUNTIME_ROOT = path.join(PROJECT_ROOT, 'data/runtime');

/**
 * Derive all FHIR table intermediates from the official specification zips.
 *
 * @param {string} output Caller-owned temporary output directory.
 * @returns {void}
 */
function deriveFhirDefinitions(output) {
  for (const spec of FHIR_TABLE_SOURCES) {
    const archive = path.join(FHIR_SPEC_ROOT, ...spec.archive.split('/'));
    if (!fs.existsSync(archive)) {
      throw new Error(
        `Missing FHIR specification archive: ${archive}; ` +
        'run npm run build:fhir-defs -- --download-missing',
      );
    }
    const result = spawnSync(process.execPath, [
      PARSER,
      spec.tableVersion,
      archive,
      output,
    ], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    if (result.status !== 0) {
      throw new Error(
        `FHIR table derivation failed for ${spec.tableVersion}:\n` +
        `${result.stderr || result.stdout}`,
      );
    }
  }
}

/**
 * Run the full official-source equivalence check.
 *
 * @returns {Promise<Object>} Freshness summary.
 */
export async function checkRuntimeDataSources() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-source-check-'));
  const fhirDefsRoot = path.join(temporaryRoot, 'fhir-defs');

  try {
    deriveFhirDefinitions(fhirDefsRoot);

    return await checkRuntimeDataFreshness({
      runtimeDataRoot: RUNTIME_ROOT,
      xverRoot: XVER_ROOT,
      fhirDefsRoot,
      fhirSpecRoot: FHIR_SPEC_ROOT,
    });
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

/**
 * Run the command-line entry point.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {Promise<number>} Process exit code.
 */
export async function main(argv) {
  if (argv.length > 0) {
    if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
      console.log('Usage: node tools/check-runtime-data-sources.js');

      return 0;
    }
    throw new Error(`Unknown option: ${argv[0]}`);
  }

  const result = await checkRuntimeDataSources();
  console.error(
    `Runtime data matches official sources (${result.filesCompared} indexed files).`,
  );

  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}
