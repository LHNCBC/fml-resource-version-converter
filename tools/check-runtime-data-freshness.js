#!/usr/bin/env node
/**
 * @fileoverview Check that runtime data is fresh with respect to its sources.
 *
 * The selected component or complete root is rebuilt under a temporary
 * directory and compared with the selected runtime root. That root is never
 * rewritten. Freshness means regenerating from the currently declared sources
 * would not change the committed bytes; it does not claim the runtime data
 * carries the same information as those sources, because runtime data is a
 * derived subset. Repeat-build stability is a separate property and is
 * covered by the generator's determinism tests.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRuntimeDataFreshness } from './runtime-data-generator.js';
import { formatDuration, formatReport, startTimer } from './measurements.js';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(TOOL_DIR, '..');

/** Default roots shared by the CLI and direct function calls. */
export const DEFAULT_FRESHNESS_CHECK_ROOTS = Object.freeze({
  runtimeDataRoot: path.join(PROJECT_ROOT, 'data/runtime'),
  fmlDatasetRoot: path.join(PROJECT_ROOT, 'data/fhir-cross-version'),
  fhirDatasetRoot: path.join(PROJECT_ROOT, 'data/fhir-spec-downloads'),
});

const COMPONENTS = new Set(['fml-mappings', 'fhir-tables', 'all']);

/**
 * Parse command-line arguments.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {Object} Parsed paths.
 */
export function parseArgs(argv) {
  const options = {
    ...DEFAULT_FRESHNESS_CHECK_ROOTS,
    component: 'all',
    help: false,
  };
  let componentSpecified = false;
  let fmlDatasetSpecified = false;
  let fhirDatasetSpecified = false;
  const fieldByOption = {
    '--runtime-data-root': 'runtimeDataRoot',
    '--fml-dataset-root': 'fmlDatasetRoot',
    '--fhir-dataset-root': 'fhirDatasetRoot',
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith('-')) {
      if (componentSpecified) throw new Error(`Unexpected argument: ${argument}`);
      if (!COMPONENTS.has(argument)) throw new Error(`Unknown component: ${argument}`);
      options.component = argument;
      componentSpecified = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    const field = fieldByOption[argument];
    if (!field) throw new Error(`Unknown option: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('-')) throw new Error(`${argument} requires a value`);
    options[field] = value;
    if (field === 'fmlDatasetRoot') fmlDatasetSpecified = true;
    if (field === 'fhirDatasetRoot') fhirDatasetSpecified = true;
    index++;
  }
  if (options.component === 'fml-mappings' && fhirDatasetSpecified) {
    throw new Error('--fhir-dataset-root does not apply to fml-mappings');
  }
  if (options.component === 'fhir-tables' && fmlDatasetSpecified) {
    throw new Error('--fml-dataset-root does not apply to fhir-tables');
  }

  return options;
}

/**
 * Run a selected freshness check.
 *
 * @param {Object} [overrides] Optional component and root overrides.
 * @returns {Promise<Object>} Freshness summary.
 */
export async function runFreshnessCheck(overrides = {}) {
  return checkRuntimeDataFreshness({
    ...DEFAULT_FRESHNESS_CHECK_ROOTS,
    component: 'all',
    ...overrides,
  });
}

/**
 * Run the command-line entry point.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {Promise<number>} Process exit code.
 */
export async function main(argv) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      console.log(
        'Usage: node tools/check-runtime-data-freshness.js ' +
        '[fml-mappings|fhir-tables|all] ' +
        '[--runtime-data-root DIR] [--fml-dataset-root DIR] ' +
        '[--fhir-dataset-root DIR]\n' +
        'The component defaults to all.',
      );

      return 0;
    }
    const elapsed = startTimer();
    const result = await runFreshnessCheck(options);
    process.stderr.write(formatReport(
      `${options.component} runtime data matches declared sources.`,
      [
        ['indexed outputs compared', result.outputsCompared],
        ['rebuild and compare', formatDuration(elapsed())],
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
