#!/usr/bin/env node
/**
 * @fileoverview Component-oriented runtime-data build CLI.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAllRuntimeData,
  buildRuntimeDataComponent,
  RUNTIME_COMPONENT,
} from './runtime-data-generator.js';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(TOOL_DIR, '..');
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
    --runtime-data-root DIR [--dataset-root DIR]

  node tools/build-runtime-data.js all --runtime-data-root DIR \\
    [--fml-dataset-root DIR] [--fhir-dataset-root DIR]

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
    runtimeDataRoot: null,
    datasetRoot: null,
    fmlDatasetRoot: DEFAULT_FML_DATASET_ROOT,
    fhirDatasetRoot: DEFAULT_FHIR_DATASET_ROOT,
    help: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith('-')) {
      if (options.component !== null) throw new Error(`Unexpected argument: ${argument}`);
      options.component = argument;
      continue;
    }
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

  return options;
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
    if (!options.runtimeDataRoot) throw new Error('--runtime-data-root is required');
    if (![
      RUNTIME_COMPONENT.FML_MAPPINGS,
      RUNTIME_COMPONENT.FHIR_TABLES,
      'all',
    ].includes(options.component)) {
      throw new Error('A component is required: fml-mappings, fhir-tables, or all');
    }

    if (options.component === 'all') {
      if (options.datasetRoot) throw new Error('--dataset-root does not apply to all');
      const manifest = await buildAllRuntimeData(options);
      console.error(
        `Built ${manifest.components.fmlMappings.artifacts.length} FML mapping and ` +
        `${manifest.components.fhirTables.artifacts.length} FHIR table artifacts in ` +
        path.resolve(options.runtimeDataRoot),
      );
    } else {
      if (argv.includes('--fml-dataset-root') || argv.includes('--fhir-dataset-root')) {
        throw new Error('Full-build dataset options do not apply to a component build');
      }
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
      console.error(
        `Built ${section.artifacts.length} ${options.component} artifacts in ` +
        path.resolve(options.runtimeDataRoot),
      );
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
