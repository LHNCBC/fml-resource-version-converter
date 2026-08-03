#!/usr/bin/env node

/**
 * @fileoverview CLI for converting FHIR resources between FHIR versions.
 *
 * Usage:
 *   node convert_cli.js [options] <from-version> <to-version> <resource-file.json>
 *
 * Options:
 *   -o, --output <file>    Write output to file instead of stdout
 *   -v, --verbose          Show info-level diagnostics (in addition to warnings)
 *   -q, --quiet            Suppress all diagnostics
 *       --strict           Fail on missing ConceptMaps or unmappable codes
 *   -h, --help             Show this help message
 *
 * Examples:
 *   node convert_cli.js R4 R5 questionnaire.json
 *   node convert_cli.js -v R5 R4 patient.json
 *   node convert_cli.js --strict -o out.json R4 R5 questionnaire.json
 *
 * Diagnostics are written to stderr so JSON output on stdout stays clean
 * for shell pipelines:
 *   node convert_cli.js R4 R5 in.json | jq .item > items.json
 *
 * Exit codes:
 *   0  Success
 *   1  Error during conversion, OR --strict was set and warnings were emitted
 *   2  CLI usage error (unknown flag, missing args)
 *
 * Supported versions: R2, R3, R4, R4B, R5
 *
 * @module fml_base_conv/convert_cli
 */

import fs from 'node:fs';
import { createFmlEngineFactory } from './create_converter.js';

const USAGE = `Usage: node convert_cli.js [options] <from-version> <to-version> <resource-file.json>

Options:
  -o, --output <file>   Write output to file instead of stdout
  -v, --verbose         Show info-level diagnostics
  -q, --quiet           Suppress all diagnostics
      --strict          Fail on missing ConceptMaps or unmappable codes
  -h, --help            Show this help

Supported versions: R2, R3, R4, R4B, R5`;

/**
 * Parse command-line arguments into an options object.
 * Throws on unknown flags so the user gets a clear error rather than
 * silently mis-parsed input.
 *
 * @param {string[]} argv  Argv slice (excluding `node` and script name).
 * @returns {{
 *   output:     string|null,
 *   verbose:    boolean,
 *   quiet:      boolean,
 *   strict:     boolean,
 *   help:       boolean,
 *   positional: string[],
 * }}
 * @throws {Error} On unknown option.
 */
function parseArgs(argv) {
  const opts = { output: null, verbose: false, quiet: false, strict: false, help: false, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if      (a === '-h' || a === '--help')    opts.help    = true;
    else if (a === '-v' || a === '--verbose') opts.verbose = true;
    else if (a === '-q' || a === '--quiet')   opts.quiet   = true;
    else if (a === '--strict')                opts.strict  = true;
    else if (a === '-o' || a === '--output')  opts.output  = argv[++i];
    else if (a.startsWith('-'))               throw new Error(`Unknown option: ${a}`);
    else                                       opts.positional.push(a);
  }
  return opts;
}

// ----- Argument parsing ---------------------------------------------------
let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(e.message);
  console.error('\n' + USAGE);
  process.exit(2);
}

if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}

if (opts.positional.length < 3) {
  console.error('Error: missing required arguments\n');
  console.error(USAGE);
  process.exit(2);
}

const [fromVer, toVer, resourceFile] = opts.positional;

// ----- Diagnostic plumbing ------------------------------------------------
// Counts let us emit a one-line summary at the end (and fail-on-warning in
// strict mode). Messages go to stderr so stdout can be piped to a file.
let warningCount = 0;
let infoCount    = 0;
const onWarning = opts.quiet
  ? () => { warningCount++; }
  : (msg) => { warningCount++; console.error(`Warning: ${msg}`); };
const onInfo = (opts.quiet || !opts.verbose)
  ? () => { infoCount++; }
  : (msg) => { infoCount++; console.error(`Info:    ${msg}`); };

// ----- Conversion ---------------------------------------------------------
try {
  const inputJson = fs.readFileSync(resourceFile, 'utf-8');
  const input     = JSON.parse(inputJson);

  if (!input.resourceType) {
    console.error('Error: Input file must be a FHIR resource (missing resourceType)');
    process.exit(1);
  }

  const engine = createFmlEngineFactory().createEngine(input.resourceType, fromVer, toVer, {
    strict: opts.strict,
    onWarning,
    onInfo,
  });

  const output     = engine.convert({ input });
  const outputJson = JSON.stringify(output, null, 2);

  if (opts.output) {
    fs.writeFileSync(opts.output, outputJson);
    if (!opts.quiet) {
      console.error(`Wrote ${output.resourceType} (${fromVer} -> ${toVer}) to ${opts.output}`);
    }
  } else {
    console.log(outputJson);
  }

  // Summary line: printed only when there's something worth saying.
  if (!opts.quiet) {
    const parts = [];
    if (warningCount > 0)              parts.push(`${warningCount} warning${warningCount === 1 ? '' : 's'}`);
    if (opts.verbose && infoCount > 0) parts.push(`${infoCount} info`);
    if (parts.length > 0) {
      console.error(`Conversion completed with ${parts.join(', ')}.`);
    }
  }

  process.exit(warningCount > 0 && opts.strict ? 1 : 0);

} catch (err) {
  console.error('Error:', err.message);
  if (err.code === 'ENOENT') console.error(`File not found: ${resourceFile}`);
  process.exit(1);
}

