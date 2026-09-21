#!/usr/bin/env node
/**
 * @fileoverview Component-oriented runtime-data build CLI.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAllRuntimeData,
  buildRuntimeDataComponent,
  RUNTIME_COMPONENT,
} from './runtime-data-generator.js';
import {
  formatBytes,
  formatDuration,
  formatReport,
  startTimer,
} from './measurements.js';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(TOOL_DIR, '..');
const DEFAULT_RUNTIME_DATA_ROOT = path.join(PROJECT_ROOT, 'data/runtime');
const DEFAULT_FML_DATASET_ROOT = path.join(PROJECT_ROOT, 'data/fhir-cross-version');
const DEFAULT_FHIR_DATASET_ROOT = path.join(PROJECT_ROOT, 'data/fhir-spec-downloads');

/**
 * Print CLI usage.
 *
 * @returns {void}
 */
function printUsage() {
  console.log(`Usage:
  node tools/build-runtime-data.js <fml-mappings|fhir-tables> \\
    [--runtime-data-root DIR] [--dataset-root DIR]

  node tools/build-runtime-data.js all \\
    [--runtime-data-root DIR] \\
    [--fml-dataset-root DIR] [--fhir-dataset-root DIR]

The build writes into the runtime root in place, defaulting to data/runtime.
Each component build replaces only its owned directory and manifest section.
The all build runs the same two builders and validates the complete result.
`);
}

/**
 * Read an option value following the current argument.
 *
 * @param {string[]} argv CLI arguments.
 * @param {number} index Current index.
 * @returns {string} Option value.
 */
function optionValue(argv, index) {
  const value = argv[index + 1];
  if (!value || value.startsWith('-')) throw new Error(`${argv[index]} requires a value`);

  return value;
}

/**
 * Parse command-line arguments.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {Object} Parsed options.
 */
export function parseArgs(argv) {
  const options = {
    component: null,
    runtimeDataRoot: DEFAULT_RUNTIME_DATA_ROOT,
    datasetRoot: null,
    fmlDatasetRoot: DEFAULT_FML_DATASET_ROOT,
    fhirDatasetRoot: DEFAULT_FHIR_DATASET_ROOT,
    help: false,
  };
  const seenOptions = new Set();
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith('-')) {
      if (options.component !== null) throw new Error(`Unexpected argument: ${argument}`);
      options.component = argument;
      continue;
    }
    const optionKey = argument === '-h' ? '--help' : argument;
    if (seenOptions.has(optionKey)) throw new Error(`Duplicate option: ${argument}`);
    seenOptions.add(optionKey);
    switch (argument) {
      case '--runtime-data-root':
        options.runtimeDataRoot = optionValue(argv, index++);
        break;
      case '--dataset-root':
        options.datasetRoot = optionValue(argv, index++);
        break;
      case '--fml-dataset-root':
        options.fmlDatasetRoot = optionValue(argv, index++);
        break;
      case '--fhir-dataset-root':
        options.fhirDatasetRoot = optionValue(argv, index++);
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${argument}`);
    }
  }
  if (options.help) return options;
  if (![
    RUNTIME_COMPONENT.FML_MAPPINGS,
    RUNTIME_COMPONENT.FHIR_TABLES,
    'all',
  ].includes(options.component)) {
    throw new Error('A component is required: fml-mappings, fhir-tables, or all');
  }
  if (options.component === 'all' && seenOptions.has('--dataset-root')) {
    throw new Error('--dataset-root does not apply to all');
  }
  if (options.component !== 'all' &&
      (seenOptions.has('--fml-dataset-root') || seenOptions.has('--fhir-dataset-root'))) {
    throw new Error('Full-build dataset options do not apply to a component build');
  }

  return options;
}

/**
 * Measure the generated modules a manifest section indexes.
 *
 * @param {string} root Runtime root written by the build.
 * @param {Object[]} artifacts Manifest artifact entries.
 * @returns {Array<[string, string]>} Measurement rows.
 */
function sizeRows(root, artifacts) {
  const canonicalBytes = artifacts.reduce((sum, entry) => sum + entry.uncompressedLength, 0);
  const moduleBytes = artifacts.reduce((sum, entry) =>
    sum + fs.statSync(path.join(root, ...entry.modulePath.split('/'))).size, 0);

  return [
    ['canonical JSON', formatBytes(canonicalBytes)],
    ['generated modules', formatBytes(moduleBytes)],
    ['module size ratio', `${((moduleBytes / canonicalBytes) * 100).toFixed(1)}% of canonical`],
  ];
}

/**
 * Run the maintainer build CLI.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {Promise<number>} Process exit code.
 */
export async function main(argv) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      printUsage();

      return 0;
    }
    const root = path.resolve(options.runtimeDataRoot);
    const elapsed = startTimer();
    if (options.component === 'all') {
      const manifest = await buildAllRuntimeData(options);
      const artifacts = [
        ...manifest.components.fmlMappings.artifacts,
        ...manifest.components.fhirTables.artifacts,
      ];
      process.stderr.write(formatReport(`Built both components in ${root}.`, [
        ['fml-mappings artifacts', manifest.components.fmlMappings.artifacts.length],
        ['fhir-tables artifacts', manifest.components.fhirTables.artifacts.length],
        ...sizeRows(root, artifacts),
        ['build and validate', formatDuration(elapsed())],
      ]));
    } else {
      const datasetRoot = options.datasetRoot || (
        options.component === RUNTIME_COMPONENT.FML_MAPPINGS
          ? DEFAULT_FML_DATASET_ROOT
          : DEFAULT_FHIR_DATASET_ROOT
      );
      const section = await buildRuntimeDataComponent({
        component: options.component,
        datasetRoot,
        runtimeDataRoot: options.runtimeDataRoot,
      });
      process.stderr.write(formatReport(`Built ${options.component} in ${root}.`, [
        ['artifacts', section.artifacts.length],
        ...sizeRows(root, section.artifacts),
        ['build', formatDuration(elapsed())],
      ]));
    }

    return 0;
  } catch (error) {
    console.error(`Error: ${error.message}`);

    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
