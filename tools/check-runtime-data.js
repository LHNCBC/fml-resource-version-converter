#!/usr/bin/env node
/**
 * @fileoverview Validate a selected runtime-data root without rebuilding it.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntimeArtifactRoot } from './runtime-data-root.js';

/**
 * Parse validation arguments.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {Object} Parsed options.
 */
export function parseArgs(argv) {
  const options = { runtimeDataRoot: null, complete: false, help: false };
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
        'Usage: node tools/check-runtime-data.js ' +
        '--runtime-data-root DIR [--complete]',
      );

      return 0;
    }
    if (!options.runtimeDataRoot) throw new Error('--runtime-data-root is required');
    const loaded = await loadRuntimeArtifactRoot(options.runtimeDataRoot, {
      complete: options.complete,
    });
    console.error(
      `Validated ${loaded.artifacts.length} runtime artifacts in ` +
      `${path.resolve(options.runtimeDataRoot)}${options.complete ? ' as a complete root' : ''}.`,
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
