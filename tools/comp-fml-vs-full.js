#!/usr/bin/env node

/**
 * @fileoverview Compare raw FML output with the full single-hop pipeline.
 *
 * Two outputs per run:
 *   - FML: raw FML engine only (no postprocessors)
 *   - Full: singleHopConverter.convert() (FML + package postprocessors)
 *
 * Usage:
 *   node tools/comp-fml-vs-full.js <from-version> <to-version> <resource.json> [output-dir]
 *
 * Examples:
 *   node tools/comp-fml-vs-full.js R4 R5 test/data/qn-ver-conv-test-r4base.json
 *   node tools/comp-fml-vs-full.js R5 R4 test/data/qn-ver-conv-test-r5base.json ./output
 *   node tools/comp-fml-vs-full.js STU3 R4 my-resource.json /tmp/out
 *
 * Versions: R2, R3 (or STU3), R4, R4B, R5
 *
 * Output:
 *   - Runs the raw FML engine and the full pipeline.
 *   - Reports whether package postprocessors ran.
 *   - Optionally writes results to output-dir as
 *       <basename>-input.json, <basename>-fml.json, <basename>-full.json
 *   - Compares FML-vs-Full (key order insignificant, array order significant),
 *     reporting MATCH or listing specific differences with JSON paths.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createFmlEngineFactory } from '../src/fml_base_conv/create_converter.js';
import { singleHopConverter } from '../src/index.js';

/**
 * Normalize version name for public/FML APIs.
 *
 * @param {string} version Input version string.
 * @returns {string} Normalized version token.
 */
function normalizeVersion(version) {
  const v = version.toUpperCase();
  if (v === 'STU3') return 'R3';
  if (v === 'DSTU2') return 'R2';
  return v;
}

/**
 * Sort object keys recursively for comparison.
 * Arrays preserve order because FHIR arrays are order-significant.
 *
 * @param {*} value Any JSON value.
 * @returns {*} Value with object keys sorted.
 */
function sortKeys(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }

  const sorted = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortKeys(value[key]);
  }
  return sorted;
}

/**
 * Find differences between two values recursively.
 *
 * @param {*} a First value.
 * @param {*} b Second value.
 * @param {string} jsonPath Current JSON path.
 * @param {string[]} diffs Accumulator for difference descriptions.
 * @param {{labelA?: string, labelB?: string}} [labels] Labels for asymmetric messages.
 */
function findDiffs(a, b, jsonPath, diffs, labels = {}) {
  const labelA = labels.labelA || 'A';
  const labelB = labels.labelB || 'B';
  if (a === b) return;

  if (a === null || b === null || typeof a !== typeof b) {
    diffs.push(`${jsonPath}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    return;
  }

  if (typeof a !== 'object') {
    if (a !== b) {
      diffs.push(`${jsonPath}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    }
    return;
  }

  if (Array.isArray(a) !== Array.isArray(b)) {
    diffs.push(`${jsonPath}: array vs object mismatch`);
    return;
  }

  if (Array.isArray(a)) {
    if (a.length !== b.length) {
      diffs.push(`${jsonPath}: array length ${a.length} vs ${b.length}`);
    }
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      findDiffs(a[i], b[i], `${jsonPath}[${i}]`, diffs, labels);
    }
    return;
  }

  const keysA = new Set(Object.keys(a));
  const keysB = new Set(Object.keys(b));

  for (const key of keysA) {
    if (!keysB.has(key)) {
      diffs.push(`${jsonPath}.${key}: present in ${labelA} output, missing in ${labelB}`);
    }
    else {
      findDiffs(a[key], b[key], `${jsonPath}.${key}`, diffs, labels);
    }
  }

  for (const key of keysB) {
    if (!keysA.has(key)) {
      diffs.push(`${jsonPath}.${key}: missing in ${labelA} output, present in ${labelB}`);
    }
  }
}

/**
 * Compare two JSON values, ignoring object key order.
 *
 * @param {*} a First value.
 * @param {*} b Second value.
 * @param {{labelA?: string, labelB?: string}} [labels] Labels for asymmetric messages.
 * @returns {{match: boolean, diffs: string[]}} Comparison result.
 */
function compareJson(a, b, labels = {}) {
  const sortedA = sortKeys(a);
  const sortedB = sortKeys(b);

  if (JSON.stringify(sortedA) === JSON.stringify(sortedB)) {
    return { match: true, diffs: [] };
  }

  const diffs = [];
  findDiffs(sortedA, sortedB, '$', diffs, labels);
  return { match: false, diffs };
}

/**
 * Report a comparison to stdout: MATCH or a bounded list of differences.
 *
 * @param {string} title Comparison title.
 * @param {{match: boolean, diffs: string[]}} result Result from compareJson.
 */
function reportComparison(title, result) {
  if (result.match) {
    console.log(`${title}: MATCH`);
    return;
  }
  console.log(`${title}: ${result.diffs.length} difference(s)`);
  for (const diff of result.diffs.slice(0, 20)) {
    console.log(`  ${diff}`);
  }
  if (result.diffs.length > 20) {
    console.log(`  ... and ${result.diffs.length - 20} more`);
  }
}

/**
 * Print usage information.
 */
function printUsage() {
  console.log(`Usage: node tools/comp-fml-vs-full.js <from-version> <to-version> <resource.json> [output-dir]

Versions: R2, R3 (or STU3), R4, R4B, R5

If output-dir is provided, writes:
  <basename>-input.json   input (with keys sorted)
  <basename>-fml.json     raw FML engine output
  <basename>-full.json    full integration pipeline output

Examples:
  node tools/comp-fml-vs-full.js R4 R5 test/data/qn-ver-conv-test-r4base.json
  node tools/comp-fml-vs-full.js R5 R4 test/data/qn-ver-conv-test-r5base.json ./output`);
}

/**
 * Read and parse a JSON input file.
 *
 * @param {string} inputFile File path.
 * @returns {Object} Parsed JSON resource.
 */
function readInput(inputFile) {
  return JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
}

/**
 * Write a sorted JSON file.
 *
 * @param {string} file Output file path.
 * @param {*} value JSON value.
 */
function writeSortedJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(sortKeys(value), null, 2) + '\n');
}

/**
 * Report full-pipeline postprocessor details.
 *
 * @param {Object} result singleHopConverter.convert result object.
 * @param {string} resourceType FHIR resource type.
 * @param {string} fromVer Source version.
 * @param {string} toVer Target version.
 */
function reportPostprocessors(result, resourceType, fromVer, toVer) {
  const postprocessors = Array.isArray(result.postprocessors) ? result.postprocessors : [];
  if (postprocessors.length === 0) {
    console.log(`Postprocessors: none for ${resourceType} ${fromVer}->${toVer}`);
    console.log('  Raw FML and full output are expected to match unless caller processors are supplied.');
    return;
  }

  console.log(`Postprocessors: ${postprocessors.length}`);
  for (const proc of postprocessors) {
    const coverage = proc.coverage == null ? 'neutral' : proc.coverage;
    const messageCount = Array.isArray(proc.messages) ? proc.messages.length : 0;
    console.log(`  - ${proc.name}: coverage=${coverage}, status=${proc.status}, messages=${messageCount}`);
    for (const message of (proc.messages || [])) {
      console.log(`      ${message.type}: ${message.text}`);
    }
  }
}

const args = process.argv.slice(2);

if (args.length < 3 || args.includes('-h') || args.includes('--help')) {
  printUsage();
  process.exit(args.includes('-h') || args.includes('--help') ? 0 : 2);
}

const [fromArg, toArg, inputFile, outputDir] = args;
const fromVer = normalizeVersion(fromArg);
const toVer = normalizeVersion(toArg);

let input;
try {
  input = readInput(inputFile);
}
catch (e) {
  console.error(`Error reading input file: ${e.message}`);
  process.exit(1);
}

const resourceType = input?.resourceType;
if (typeof resourceType !== 'string' || resourceType.length === 0) {
  console.error('Error: input resource.resourceType is required');
  process.exit(1);
}

console.log(`Input: ${inputFile}`);
console.log(`Resource type: ${resourceType}`);
console.log(`Converting: ${fromVer} -> ${toVer}\n`);

let fmlOutput = null;
try {
  const fmlWarnings = [];
  const fmlEngine = createFmlEngineFactory().createEngine(resourceType, fromVer, toVer, {
    onWarning: msg => fmlWarnings.push(msg),
  });
  // The engine returns an envelope ({ resource, spinOffResources? }). Compare
  // and serialize only the primary resource so it lines up with the full
  // pipeline's fullResult.resource (otherwise every field is a false diff).
  const { resource: fmlResource } = fmlEngine.convert({ input });
  fmlOutput = fmlResource;
  console.log(`Raw FML: OK (${fmlWarnings.length} warning(s))`);
  for (const warning of fmlWarnings) {
    console.log(`  warning: ${warning}`);
  }
}
catch (e) {
  console.log(`Raw FML: FAILED - ${e.message}`);
}

let fullOutput = null;
let fullResult = null;
try {
  fullResult = singleHopConverter.convert(input, fromVer, toVer);
  fullOutput = fullResult.resource;
  console.log(
    `Full pipeline: OK (coverage=${fullResult.coverage}, status=${fullResult.status}, `
    + `fmlCoverage=${fullResult.fml_base_conv.coverage})`,
  );
  reportPostprocessors(fullResult, resourceType, fromVer, toVer);
}
catch (e) {
  console.log(`Full pipeline: FAILED - ${e.message}`);
}

if (outputDir) {
  const basename = path.basename(inputFile, '.json');
  fs.mkdirSync(outputDir, { recursive: true });

  const inputPath = path.join(outputDir, `${basename}-input.json`);
  writeSortedJson(inputPath, input);
  console.log(`Wrote: ${inputPath}`);

  if (fmlOutput) {
    const fmlPath = path.join(outputDir, `${basename}-fml.json`);
    writeSortedJson(fmlPath, fmlOutput);
    console.log(`Wrote: ${fmlPath}`);
  }

  if (fullOutput) {
    const fullPath = path.join(outputDir, `${basename}-full.json`);
    writeSortedJson(fullPath, fullOutput);
    console.log(`Wrote: ${fullPath}`);
  }
}

console.log('');

if (!outputDir) {
  console.log('(Provide output-dir argument to save converted results to files)\n');
}

let exitCode;
if (fmlOutput && fullOutput) {
  const comparison = compareJson(fmlOutput, fullOutput, { labelA: 'FML', labelB: 'Full' });
  reportComparison('FML vs Full', comparison);
  exitCode = comparison.match ? 0 : 1;
}
else if (!fmlOutput && fullOutput) {
  console.log('FML vs Full: SKIPPED (raw FML failed)');
  exitCode = 1;
}
else if (fmlOutput && !fullOutput) {
  console.log('FML vs Full: SKIPPED (full pipeline failed)');
  exitCode = 1;
}
else {
  console.log('FML vs Full: SKIPPED (both failed)');
  exitCode = 1;
}


// Set process.exitCode (rather than calling process.exit) so buffered stdout is
// flushed before the process exits; process.exit() can truncate piped output.
process.exitCode = exitCode;
