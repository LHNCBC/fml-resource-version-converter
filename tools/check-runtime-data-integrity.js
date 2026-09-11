#!/usr/bin/env node
/**
 * @fileoverview Validate the integrity of a selected runtime-data root.
 *
 * Integrity means the root is well formed, undamaged, and internally
 * consistent: canonical manifest, importable artifact modules, verified
 * hashes and canonical payloads, and manifest metadata that matches every
 * envelope and decoded payload. It does not compare the root with the
 * upstream sources it was generated from; see
 * `tools/check-runtime-data-freshness.js` for that.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntimeArtifactRoot } from './runtime-data-root.js';
import {
  artifactSizeRows,
  formatDuration,
  formatReport,
  startTimer,
  summarizeArtifactSizes,
} from './measurements.js';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RUNTIME_DATA_ROOT = path.resolve(TOOL_DIR, '../data/runtime');

/**
 * Check the integrity of one runtime-data root.
 *
 * Shared by this CLI and by package validation so both perform the same
 * named check rather than each calling the loader directly.
 *
 * @param {string} runtimeDataRoot Runtime-data root to validate.
 * @param {Object} [options] Validation options.
 * @param {boolean} [options.complete=true] Require both runtime components.
 * @param {'fml-mappings'|'fhir-tables'} [options.component] Validate only one
 *   independently owned component.
 * @returns {Promise<{root: string, manifest: Object, artifacts: Object[]}>}
 *   Validated manifest plus loaded envelope and decoded artifact records.
 * @throws {Error} If the root is incomplete, damaged, or internally inconsistent.
 */
export async function checkRuntimeDataIntegrity(runtimeDataRoot, options = {}) {
  return loadRuntimeArtifactRoot(runtimeDataRoot, options);
}

/**
 * Parse validation arguments.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {Object} Parsed options.
 */
export function parseArgs(argv) {
  const options = {
    runtimeDataRoot: DEFAULT_RUNTIME_DATA_ROOT,
    complete: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--complete') {
      options.complete = true;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument === '--runtime-data-root') {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) throw new Error(`${argument} requires a value`);
      options.runtimeDataRoot = value;
      index++;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  return options;
}

/**
 * Run the validation CLI.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {Promise<number>} Process exit code.
 */
export async function main(argv) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      console.log(
        'Usage: node tools/check-runtime-data-integrity.js ' +
        '[--runtime-data-root DIR] [--complete]\n' +
        'The runtime-data root defaults to data/runtime.',
      );

      return 0;
    }
    const elapsed = startTimer();
    const loaded = await checkRuntimeDataIntegrity(options.runtimeDataRoot, {
      complete: options.complete,
    });
    const milliseconds = elapsed();
    const sizes = summarizeArtifactSizes(loaded.artifacts.map(item => item.envelope));
    process.stderr.write(formatReport(
      `Integrity verified for ${path.resolve(options.runtimeDataRoot)}` +
      `${options.complete ? ' as a complete root' : ''}.`,
      [
        ['artifacts', sizes.count],
        ...artifactSizeRows(sizes),
        ['load, decode, validate', formatDuration(milliseconds)],
      ],
    ));

    return 0;
  } catch (error) {
    console.error(`Error: ${error.message}`);

    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
