#!/usr/bin/env node
/**
 * @fileoverview Really simple command-line runner for resource conversion.
 *
 * A minimal, dependency-free harness for trying out chainedConverter.convert
 * from the shell. Reads a FHIR resource from a JSON file (or stdin), converts it
 * across one or more version hops, prints the converted resource to stdout, and
 * prints a short diagnostics summary to stderr.
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
 *   node bin/convert.js R3 R5 ./questionnaire.json
 *   cat patient.json | node bin/convert.js R4 R5
 *
 * @module bin/convert
 */
import fs from 'node:fs';
import { chainedConverter } from '../src/converter/chainedConverter.js';

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
    '  across one or more version hops. Versions: R2|R3|R4|R4B|R5.\n' +
    '  --verbose also prints info-level diagnostics (warnings always shown).\n',
  );
}

/**
 * Collect diagnostics from every report component in a chained result.
 *
 * @param {Array<Object>} hops Per-hop conversion reports.
 * @returns {Array<Object>} Messages annotated with hop and component metadata.
 */
function collectMessages(hops) {
  const messages = [];

  for (const hop of hops) {
    const hopLabel = `${hop.fromVer} -> ${hop.toVer}`;
    const components = [
      ...(hop.preprocessors || []),
      hop.fml_base_conv,
      ...(hop.postprocessors || []),
    ].filter(Boolean);

    for (const component of components) {
      for (const message of (component.messages || [])) {
        messages.push({
          ...message,
          component: component.name,
          hop: hopLabel,
        });
      }
    }
  }

  return messages;
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

  const result = chainedConverter.convert(resource, fromVer, toVer);

  // Converted resource goes to stdout (pipe/redirect friendly).
  process.stdout.write(`${JSON.stringify(result.resource, null, 2)}\n`);

  // Diagnostics summary goes to stderr so it never pollutes the JSON output.
  const messages = collectMessages(result.hops);
  const warnings = messages.filter(m => m.type === 'warning');
  const infos = messages.filter(m => m.type === 'info');
  process.stderr.write(
    `\n[${fromVer} -> ${toVer}] status=${result.status} coverage=${result.coverage} ` +
    `hops=${result.hops.length} warnings=${warnings.length} info=${infos.length}\n`,
  );
  // Always show warnings; show info only when --verbose is given.
  const shown = verbose ? messages : warnings;
  for (const m of shown) {
    process.stderr.write(`  - [${m.hop} ${m.component}] ${m.type}: ${m.text}\n`);
  }
  if (!verbose && infos.length > 0) {
    process.stderr.write(`  (${infos.length} info messages hidden; pass --verbose to show)\n`);
  }
}

main().catch(err => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exitCode = 1;
});
