#!/usr/bin/env node

/**
 * @fileoverview Non-rewriting validation of the package that npm would publish.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadRuntimeArtifactRoot } from './runtime-data-root.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const MAX_UNPACKED_BYTES = 2_000_000;
const MAX_FILE_COUNT = 90;
const PUBLIC_RUNTIME_MODULES = [
  'all',
  'r2-to-r3',
  'r3-to-r2',
  'r3-to-r4',
  'r4-to-r3',
  'r4-to-r5',
  'r4b-to-r5',
  'r5-to-r4',
  'r5-to-r4b',
];

/**
 * Ask npm for the exact dry-run package report without invoking lifecycle
 * scripts recursively.
 *
 * @returns {Object} The single npm package report.
 */
export function collectPackageReport() {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const npmCache = path.join(os.tmpdir(), 'fml-resource-version-converter-npm-cache');
  const result = spawnSync(npmCommand, [
    'pack',
    '--dry-run',
    '--ignore-scripts',
    '--json',
    '--cache',
    npmCache,
  ], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });

  if (result.status !== 0) {
    throw new Error(`npm pack --dry-run failed:\n${result.stderr || result.stdout}`);
  }

  let reports;
  try {
    reports = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`npm pack returned invalid JSON: ${error.message}`, { cause: error });
  }
  if (!Array.isArray(reports) || reports.length !== 1) {
    throw new Error(`npm pack returned ${Array.isArray(reports) ? reports.length : 'no'} reports`);
  }

  return reports[0];
}

/**
 * Return the committed artifact module paths from the authoritative manifest.
 *
 * @returns {string[]} Package-relative artifact paths.
 */
function getArtifactPaths() {
  const manifestPath = path.join(PROJECT_ROOT, 'data/runtime/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  return manifest.artifacts.map(entry => `data/runtime/${entry.modulePath}`);
}

/**
 * Validate package contents and size thresholds.
 *
 * @param {Object} report npm pack JSON report.
 * @returns {{unpackedBytes: number, compressedBytes: number, fileCount: number}}
 *   Validated package measurements.
 */
export function validatePackageReport(report) {
  if (!report || !Array.isArray(report.files)) {
    throw new TypeError('Package report must contain a files array');
  }

  const files = new Set(report.files.map(entry => entry.path));
  const required = [
    'data/runtime/README.md',
    'data/runtime/manifest.json',
    'src/converter/converterFactory.js',
    ...PUBLIC_RUNTIME_MODULES.map(name => `src/runtime/data_modules/${name}.js`),
    ...getArtifactPaths(),
  ];
  const missing = required.filter(file => !files.has(file));
  if (missing.length > 0) {
    throw new Error(`Packed package is missing required files: ${missing.join(', ')}`);
  }

  const forbiddenPrefixes = [
    'data/fhir-cross-version/',
    'data/fhir-defs/',
    'data/fhir-spec-downloads/',
  ];
  const forbidden = [...files].filter(file =>
    forbiddenPrefixes.some(prefix => file.startsWith(prefix)) ||
    (file.startsWith('data/runtime/') && file.endsWith('.map'))
  );
  if (forbidden.length > 0) {
    throw new Error(`Packed package contains forbidden files: ${forbidden.join(', ')}`);
  }

  if (report.unpackedSize > MAX_UNPACKED_BYTES) {
    throw new Error(
      `Packed package is ${report.unpackedSize} unpacked bytes; limit is ${MAX_UNPACKED_BYTES}`,
    );
  }
  if (report.entryCount > MAX_FILE_COUNT) {
    throw new Error(
      `Packed package has ${report.entryCount} files; limit is ${MAX_FILE_COUNT}`,
    );
  }

  return {
    unpackedBytes: report.unpackedSize,
    compressedBytes: report.size,
    fileCount: report.entryCount,
  };
}

/**
 * Validate the complete committed runtime root without rewriting it.
 *
 * @returns {Promise<{artifactCount: number}>} Validated runtime-root summary.
 */
export async function validateCommittedRuntimeRoot() {
  const loaded = await loadRuntimeArtifactRoot(path.join(PROJECT_ROOT, 'data/runtime'));

  return { artifactCount: loaded.artifacts.length };
}

/**
 * Run package validation and print its measurements.
 *
 * @returns {Promise<void>} Resolves after runtime and package validation.
 */
async function main() {
  const runtime = await validateCommittedRuntimeRoot();
  const measurements = validatePackageReport(collectPackageReport());
  process.stdout.write(
    `Package validation passed: ${runtime.artifactCount} runtime artifacts, ` +
    `${measurements.unpackedBytes} unpacked bytes, ` +
    `${measurements.compressedBytes} compressed bytes, ${measurements.fileCount} files.\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
