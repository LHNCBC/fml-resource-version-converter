#!/usr/bin/env node
/**
 * @fileoverview Copy one generated component between runtime-data roots.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  migrateRuntimeDataComponent,
  RUNTIME_COMPONENT,
} from './runtime-data-generator.js';

/**
 * Print CLI usage.
 *
 * @returns {void}
 */
function printUsage() {
  console.log(`Usage: node tools/migrate-runtime-data.js <fml-mappings|fhir-tables> \\
  --from-runtime-data-root SOURCE --to-runtime-data-root TARGET

The command copies only the selected generated component and its complete
manifest section. It does not rebuild data or obtain the other component.
`);
}

/**
 * Parse migration arguments.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {Object} Parsed options.
 */
export function parseArgs(argv) {
  const options = {
    component: null,
    fromRuntimeDataRoot: null,
    toRuntimeDataRoot: null,
    help: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith('-')) {
      if (options.component !== null) throw new Error(`Unexpected argument: ${argument}`);
      options.component = argument;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (!['--from-runtime-data-root', '--to-runtime-data-root'].includes(argument)) {
      throw new Error(`Unknown option: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('-')) throw new Error(`${argument} requires a value`);
    options[argument === '--from-runtime-data-root'
      ? 'fromRuntimeDataRoot'
      : 'toRuntimeDataRoot'] = value;
    index++;
  }

  return options;
}

/**
 * Run the migration CLI.
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
    if (![RUNTIME_COMPONENT.FML_MAPPINGS, RUNTIME_COMPONENT.FHIR_TABLES]
      .includes(options.component)) {
      throw new Error('A component is required: fml-mappings or fhir-tables');
    }
    if (!options.fromRuntimeDataRoot) throw new Error('--from-runtime-data-root is required');
    if (!options.toRuntimeDataRoot) throw new Error('--to-runtime-data-root is required');
    const section = await migrateRuntimeDataComponent(options);
    console.error(
      `Migrated ${section.artifacts.length} ${options.component} artifacts from ` +
      `${path.resolve(options.fromRuntimeDataRoot)} to ` +
      path.resolve(options.toRuntimeDataRoot),
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
