#!/usr/bin/env node
/**
 * @fileoverview Copy a complete runtime-data root or one generated component.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifestArtifacts } from '../src/runtime/schema.js';
import { formatBytes, formatDuration, formatReport, startTimer } from './measurements.js';
import {
  copyRuntimeDataComponent,
  copyRuntimeDataRoot,
  RUNTIME_COMPONENT,
} from './runtime-data-generator.js';

const SCOPE_OPTIONS = Object.freeze({
  '--all': 'all',
  '--fml-mappings': RUNTIME_COMPONENT.FML_MAPPINGS,
  '--fhir-tables': RUNTIME_COMPONENT.FHIR_TABLES,
});

/**
 * Print CLI usage.
 *
 * @returns {void}
 */
function printUsage() {
  console.log(`Usage: node tools/copy-runtime-data.js \\
  [--all|--fml-mappings|--fhir-tables] \\
  --from-runtime-data-root SOURCE --to-runtime-data-root TARGET

With no scope option, the command copies the complete runtime root. A complete
copy requires a new target path. A component copy replaces only that component
and its manifest section in the target; the other component is left unchanged.
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
 * Parse copy arguments.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {Object} Parsed options.
 */
export function parseArgs(argv) {
  const options = {
    component: 'all',
    fromRuntimeDataRoot: null,
    toRuntimeDataRoot: null,
    help: false,
  };
  const seenOptions = new Set();
  let selectedScope = null;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith('-')) {
      throw new Error(`Unexpected argument: ${argument}`);
    }
    const optionKey = argument === '-h' ? '--help' : argument;
    if (seenOptions.has(optionKey)) throw new Error(`Duplicate option: ${argument}`);
    seenOptions.add(optionKey);
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (Object.hasOwn(SCOPE_OPTIONS, argument)) {
      if (selectedScope !== null) {
        throw new Error(`Copy scope options are mutually exclusive: ${selectedScope}, ${argument}`);
      }
      selectedScope = argument;
      options.component = SCOPE_OPTIONS[argument];
      continue;
    }
    if (!['--from-runtime-data-root', '--to-runtime-data-root'].includes(argument)) {
      throw new Error(`Unknown option: ${argument}`);
    }
    options[argument === '--from-runtime-data-root'
      ? 'fromRuntimeDataRoot'
      : 'toRuntimeDataRoot'] = optionValue(argv, index++);
  }

  return options;
}

/**
 * Run the copy CLI.
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
    if (!options.fromRuntimeDataRoot) throw new Error('--from-runtime-data-root is required');
    if (!options.toRuntimeDataRoot) throw new Error('--to-runtime-data-root is required');
    const elapsed = startTimer();
    const artifacts = options.component === 'all'
      ? manifestArtifacts((await copyRuntimeDataRoot(options)).manifest)
      : (await copyRuntimeDataComponent(options)).artifacts;
    const canonicalBytes = artifacts
      .reduce((sum, entry) => sum + entry.uncompressedLength, 0);
    process.stderr.write(formatReport(
      `Copied ${options.component} to ${path.resolve(options.toRuntimeDataRoot)}.`,
      [
        ['from', path.resolve(options.fromRuntimeDataRoot)],
        ['artifacts', artifacts.length],
        ['canonical JSON', formatBytes(canonicalBytes)],
        ['copy and validate', formatDuration(elapsed())],
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
