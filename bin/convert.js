#!/usr/bin/env node
/**
 * @fileoverview Really simple command-line runner for a single-hop conversion.
 *
 * A minimal, dependency-free harness for trying out convertSingleHop from the
 * shell. Reads a FHIR resource from a JSON file (or stdin), converts it across
 * one adjacent version hop, prints the converted resource to stdout, and prints
 * a short diagnostics summary to stderr.
 *
 * Usage:
 *   node bin/convert.js <fromVer> <toVer> [inputFile] [--verbose]
 *
 *   <fromVer>    Source version (R2|R3|R4|R4B|R5).
 *   <toVer>      Target version (R2|R3|R4|R4B|R5).
 *   [inputFile]  Path to the resource JSON. If omitted, reads from stdin.
 *   --verbose    Also print info-level diagnostics (warnings always shown).
 *
 * Examples:
 *   node bin/convert.js R4 R5 ./patient.json
 *   cat patient.json | node bin/convert.js R4 R5
 *
 * @module bin/convert
 */
import fs from 'node:fs';
import { convertSingleHop } from '../src/converter/singleHopConverter.js';

/**
 * Read the whole of a readable stream as a UTF-8 string.
 *
 * @param {NodeJS.ReadableStream} stream Stream to drain (e.g. process.stdin).
 * @returns {Promise<string>} The collected text.
 */
function readStream(stream) {
  return new Promise((resolve, reject) => {
    let data = '';
    stream.setEncoding('utf-8');
    stream.on('data', chunk => { data += chunk; });
    stream.on('end', () => resolve(data));
    stream.on('error', reject);
  });
}

/**
 * Print the CLI usage text to stderr.
 *
 * @returns {void}
 */
function printUsage() {
  process.stderr.write(
    'Usage: node bin/convert.js <fromVer> <toVer> [inputFile] [--verbose]\n' +
    '  Reads inputFile (or stdin) as a FHIR resource JSON and converts it\n' +
    '  across one adjacent version hop. Versions: R2|R3|R4|R4B|R5.\n' +
    '  --verbose also prints info-level diagnostics (warnings always shown).\n',
  );
}

/**
 * Parse args, run one conversion, and write the result.
 *
 * @returns {Promise<void>} Resolves after output is written.
 */
async function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  const [fromVer, toVer, inputFile] = args.filter(a => a !== '--verbose');

  if (!fromVer || !toVer) {
    printUsage();
    process.exitCode = 2;
    return;
  }

  // Load the input resource from a file or stdin.
  const raw = inputFile
    ? fs.readFileSync(inputFile, 'utf-8')
    : await readStream(process.stdin);

  let resource;
  try {
    resource = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`Error: input is not valid JSON: ${e.message}\n`);
    process.exitCode = 1;
    return;
  }

  const result = convertSingleHop(resource, fromVer, toVer);

  // Converted resource goes to stdout (pipe/redirect friendly).
  process.stdout.write(`${JSON.stringify(result.resource, null, 2)}\n`);

  // Diagnostics summary goes to stderr so it never pollutes the JSON output.
  const messages = result.fml_base_conv?.messages ?? [];
  const warnings = messages.filter(m => m.type === 'warning');
  const infos = messages.filter(m => m.type === 'info');
  process.stderr.write(
    `\n[${fromVer} -> ${toVer}] status=${result.status} coverage=${result.coverage} ` +
    `warnings=${warnings.length} info=${infos.length}\n`,
  );
  // Always show warnings; show info only when --verbose is given.
  const shown = verbose ? messages : warnings;
  for (const m of shown) {
    process.stderr.write(`  - ${m.type}: ${m.text}\n`);
  }
  if (!verbose && infos.length > 0) {
    process.stderr.write(`  (${infos.length} info messages hidden; pass --verbose to show)\n`);
  }
}

main().catch(err => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exitCode = 1;
});

