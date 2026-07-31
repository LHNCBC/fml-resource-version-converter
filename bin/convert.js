#!/usr/bin/env node
/**
 * @fileoverview Really simple command-line runner for a single-hop conversion.
 *
 * A minimal, dependency-free harness for trying out convertSingleHop from the
 * shell. Reads a FHIR resource from a JSON file (or stdin), converts it across
 * one adjacent version hop, prints the converted resource to stdout, and prints
 * a short diagnostics summary (aggregated across all conversion stages) to
 * stderr. Bundle entry.resource values are not recursively converted.
 *
 * Usage:
 *   node bin/convert.js <fromVer> <toVer> [inputFile] [options]
 *
 *   <fromVer>    Source version (R2|R3|R4|R4B|R5).
 *   <toVer>      Target version (R2|R3|R4|R4B|R5).
 *   [inputFile]  Path to the resource JSON. If omitted, reads from stdin.
 *   --verbose                         Print info-level diagnostics.
 *   --target-resource-type <type>     Select an ambiguous target resource type.
 *
 * Examples:
 *   node bin/convert.js R4 R5 ./patient.json
 *   cat patient.json | node bin/convert.js R4 R5
 *   node bin/convert.js R4 R3 ./request.json --target-resource-type ProcedureRequest
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
 * Parse supported CLI options and positional arguments.
 *
 * Options may appear before or after positional arguments. Unknown options,
 * duplicate target selectors, and missing option values are rejected rather
 * than being mistaken for an input filename.
 *
 * @param {string[]} args Raw command-line arguments after the script path.
 * @returns {{verbose: boolean, targetResourceType: string|undefined, positional: string[]}}
 * @throws {Error} If an option is unknown or malformed.
 */
function parseArgs(args) {
  let verbose = false;
  let targetResourceType;
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--verbose') {
      verbose = true;
    } else if (arg === '--target-resource-type') {
      if (targetResourceType !== undefined) {
        throw new Error('--target-resource-type may be specified only once');
      }

      const value = args[++i];
      if (!value || value.startsWith('--')) {
        throw new Error('--target-resource-type requires a resource type');
      }
      targetResourceType = value;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length > 3) {
    throw new Error('too many positional arguments');
  }

  return { verbose, targetResourceType, positional };
}

/**
 * Print the CLI usage text to stderr.
 *
 * @returns {void}
 */
function printUsage() {
  process.stderr.write(
    'Usage: node bin/convert.js <fromVer> <toVer> [inputFile] [options]\n' +
    '  Reads inputFile (or stdin) as a FHIR resource JSON and converts it\n' +
    '  across one adjacent version hop. Versions: R2|R3|R4|R4B|R5.\n' +
    '  --verbose also prints info-level diagnostics (warnings always shown).\n' +
    '  --target-resource-type <type> selects an ambiguous target mapping.\n' +
    '  Note: Bundle entry.resource values are not recursively converted.\n',
  );
}

/**
 * Parse args, run one conversion, and write the result.
 *
 * @returns {Promise<void>} Resolves after output is written.
 */
async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n`);
    printUsage();
    process.exitCode = 2;
    return;
  }

  const { verbose, targetResourceType, positional } = parsed;
  const [fromVer, toVer, inputFile] = positional;

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

  const result = convertSingleHop(resource, fromVer, toVer, {
    targetResourceType,
  });

  // Converted resource goes to stdout (pipe/redirect friendly).
  process.stdout.write(`${JSON.stringify(result.resource, null, 2)}\n`);

  // Diagnostics summary goes to stderr so it never pollutes the JSON output.
  // Aggregate messages across every executed stage (preprocessors, the FML
  // engine, and postprocessors); the result rolls status up over all of them,
  // so reading only the FML stage would hide pre/postprocessor diagnostics and
  // undercount warnings. Each message keeps its stage name for context.
  const stages = [
    ...(result.preprocessors ?? []),
    result.fml_base_conv,
    ...(result.postprocessors ?? []),
  ].filter(Boolean);
  const messages = stages.flatMap(
    stage => (stage.messages ?? []).map(m => ({ ...m, stage: stage.name })),
  );
  const warnings = messages.filter(m => m.type === 'warning');
  const infos = messages.filter(m => m.type === 'info');
  process.stderr.write(
    `\n[${fromVer} -> ${toVer}] status=${result.status} coverage=${result.coverage} ` +
    `warnings=${warnings.length} info=${infos.length}\n`,
  );
  // Always show warnings; show info only when --verbose is given.
  const shown = verbose ? messages : warnings;
  for (const m of shown) {
    process.stderr.write(`  - ${m.stage} ${m.type}: ${m.text}\n`);
  }
  if (!verbose && infos.length > 0) {
    process.stderr.write(`  (${infos.length} info messages hidden; pass --verbose to show)\n`);
  }
}

main().catch(err => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exitCode = 1;
});
