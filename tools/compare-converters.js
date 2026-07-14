#!/usr/bin/env node

/**
 * @fileoverview Compare Questionnaire converters: raw FML engine, full
 * integration pipeline (convertSingleHop), and the legacy (hand-coded) converter.
 *
 * Three outputs per run:
 *   - FML: the raw FML engine only (no postprocessors)
 *   - Full: the integration API convertSingleHop() (FML + package postprocessors)
 *   - Legacy: the hand-rolled Questionnaire converter
 *
 * Usage:
 *   node tools/compare-converters.js <from-version> <to-version> <questionnaire.json> [output-dir]
 *
 * Examples:
 *   node tools/compare-converters.js R4 R5 test/data/qn-ver-conv-test-r4base.json
 *   node tools/compare-converters.js R4 R5 test/data/qn-ver-conv-test-r4base.json ./output
 *   node tools/compare-converters.js STU3 R4 my-questionnaire.json /tmp/out
 *
 * Versions: STU3 (or R3), R4, R4B, R5
 *
 * Output:
 *   - Runs all three converters and reports success/failure
 *   - Optionally writes results to output-dir as
 *       <basename>-input.json, <basename>-fml.json, <basename>-full.json,
 *       <basename>-legacy.json
 *   - Compares FML-vs-Legacy AND Full-vs-Legacy (key order insignificant, array
 *     order significant), reporting "MATCH" or listing specific differences
 *     with JSON paths. Exit code is 0 only when the Full pipeline matches
 *     Legacy (the primary comparison); the raw-FML comparison is informational.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createFmlEngineFactory } from '../src/fml_base_conv/create_converter.js';
import { convertSingleHop } from '../src/converter/singleHopConverter.js';
import { getConverter } from '../src/hand_rolled_qn_conv/qnvconv.js';


/**
 * Normalize version name for FML converter (uses R3, not STU3).
 *
 * @param {string} version Input version string.
 * @returns {string} Normalized version for FML converter.
 */
function toFmlVersion(version) {
  const v = version.toUpperCase();
  if (v === 'STU3') return 'R3';
  return v;
}


/**
 * Normalize version name for legacy converter (uses STU3, not R3).
 *
 * @param {string} version Input version string.
 * @returns {string} Normalized version for legacy converter.
 */
function toLegacyVersion(version) {
  const v = version.toUpperCase();
  if (v === 'R3') return 'STU3';
  return v;
}


/**
 * Sort object keys recursively for comparison.
 * Arrays preserve order (FHIR arrays are order-significant).
 *
 * @param {*} value Any JSON value.
 * @returns {*} Value with objects having sorted keys.
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
 * @param {string} path Current JSON path.
 * @param {string[]} diffs Accumulator for difference descriptions.
 * @param {{labelA?: string, labelB?: string}} [labels] Labels for asymmetric
 *   messages (default: 'A' and 'B').
 */
function findDiffs(a, b, path, diffs, labels = {}) {
  const labelA = labels.labelA || 'A';
  const labelB = labels.labelB || 'B';
  if (a === b) return;

  if (a === null || b === null || typeof a !== typeof b) {
    diffs.push(`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    return;
  }

  if (typeof a !== 'object') {
    if (a !== b) {
      diffs.push(`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    }
    return;
  }

  if (Array.isArray(a) !== Array.isArray(b)) {
    diffs.push(`${path}: array vs object mismatch`);
    return;
  }

  if (Array.isArray(a)) {
    if (a.length !== b.length) {
      diffs.push(`${path}: array length ${a.length} vs ${b.length}`);
    }
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      findDiffs(a[i], b[i], `${path}[${i}]`, diffs, labels);
    }
    return;
  }

  // Both are objects
  const keysA = new Set(Object.keys(a));
  const keysB = new Set(Object.keys(b));

  for (const key of keysA) {
    if (!keysB.has(key)) {
      diffs.push(`${path}.${key}: present in ${labelA} output, missing in ${labelB}`);
    } else {
      findDiffs(a[key], b[key], `${path}.${key}`, diffs, labels);
    }
  }

  for (const key of keysB) {
    if (!keysA.has(key)) {
      diffs.push(`${path}.${key}: missing in ${labelA} output, present in ${labelB}`);
    }
  }
}


/**
 * Compare two JSON values, ignoring object key order.
 *
 * @param {*} a First value.
 * @param {*} b Second value.
 * @param {{labelA?: string, labelB?: string}} [labels] Labels for asymmetric messages.
 * @returns {{ match: boolean, diffs: string[] }}
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
 * @param {string} title Comparison title, e.g. 'FML vs Legacy'.
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


// --- Main ---

const args = process.argv.slice(2);

if (args.length < 3 || args.includes('-h') || args.includes('--help')) {
  console.log(`Usage: node tools/compare-converters.js <from-version> <to-version> <questionnaire.json> [output-dir]

Versions: STU3 (or R3), R4, R4B, R5

If output-dir is provided, writes:
  <basename>-input.json   input (with keys sorted)
  <basename>-fml.json     raw FML engine output
  <basename>-full.json    full integration pipeline (convertSingleHop) output
  <basename>-legacy.json  legacy converter output

Examples:
  node tools/compare-converters.js R4 R5 test/data/qn-ver-conv-test-r4base.json
  node tools/compare-converters.js R4 R5 test/data/qn-ver-conv-test-r4base.json ./output`);
  process.exit(args.includes('-h') || args.includes('--help') ? 0 : 2);
}

const [fromVer, toVer, inputFile, outputDir] = args;
const fmlFrom = toFmlVersion(fromVer);
const fmlTo = toFmlVersion(toVer);
const legacyFrom = toLegacyVersion(fromVer);
const legacyTo = toLegacyVersion(toVer);

let input;
try {
  input = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
} catch (e) {
  console.error(`Error reading input file: ${e.message}`);
  process.exit(1);
}

if (input.resourceType !== 'Questionnaire') {
  console.error(`Error: Input must be a Questionnaire resource (got ${input.resourceType})`);
  process.exit(1);
}

console.log(`Input: ${inputFile}`);
console.log(`Converting: ${fromVer} -> ${toVer}\n`);

// Run FML converter
let fmlOutput = null;
let fmlError = null;
try {
  const fmlWarnings = [];
  const fmlEngine = createFmlEngineFactory().createEngine('Questionnaire', fmlFrom, fmlTo, {
    onWarning: msg => fmlWarnings.push(msg),
  });
  fmlOutput = fmlEngine.convert({ input });
  console.log(`FML converter: OK${fmlWarnings.length ? ` (${fmlWarnings.length} warnings)` : ''}`);
} catch (e) {
  fmlError = e.message;
  console.log(`FML converter: FAILED - ${fmlError}`);
}

// Run full integration pipeline (FML + package postprocessors)
let fullOutput = null;
let fullError = null;
try {
  const result = convertSingleHop(input, fmlFrom, fmlTo);
  fullOutput = result.resource;
  const ppCount = Array.isArray(result.postprocessors) ? result.postprocessors.length : 0;
  console.log(
    `Full pipeline:  OK (coverage=${result.coverage}, status=${result.status}, `
    + `postprocessors=${ppCount})`,
  );
} catch (e) {
  fullError = e.message;
  console.log(`Full pipeline:  FAILED - ${fullError}`);
}

// Run legacy converter
let legacyOutput = null;
let legacyError = null;
try {
  const legacyConverter = getConverter(legacyFrom, legacyTo);
  if (!legacyConverter) {
    throw new Error(`Unsupported version pair: ${legacyFrom} -> ${legacyTo}`);
  }
  const result = legacyConverter(input);
  legacyOutput = result.data;
  console.log(`Legacy converter: OK${result.status < 1 ? ` (status=${result.status})` : ''}`);
} catch (e) {
  legacyError = e.message;
  console.log(`Legacy converter: FAILED - ${legacyError}`);
}

// Write output files if output-dir provided
if (outputDir) {
  const basename = path.basename(inputFile, '.json');
  fs.mkdirSync(outputDir, { recursive: true });

  const inputPath = path.join(outputDir, `${basename}-input.json`);
  fs.writeFileSync(inputPath, JSON.stringify(sortKeys(input), null, 2));
  console.log(`Wrote: ${inputPath}`);

  if (fmlOutput) {
    const fmlPath = path.join(outputDir, `${basename}-fml.json`);
    fs.writeFileSync(fmlPath, JSON.stringify(sortKeys(fmlOutput), null, 2));
    console.log(`Wrote: ${fmlPath}`);
  }

  if (fullOutput) {
    const fullPath = path.join(outputDir, `${basename}-full.json`);
    fs.writeFileSync(fullPath, JSON.stringify(sortKeys(fullOutput), null, 2));
    console.log(`Wrote: ${fullPath}`);
  }

  if (legacyOutput) {
    const legacyPath = path.join(outputDir, `${basename}-legacy.json`);
    fs.writeFileSync(legacyPath, JSON.stringify(sortKeys(legacyOutput), null, 2));
    console.log(`Wrote: ${legacyPath}`);
  }
}

// Compare outputs
console.log('');

if (!outputDir) {
  console.log('(Provide output-dir argument to save converted results to files)\n');
}

// Two comparisons against the legacy converter (the ground-truth reference):
//   - Full  vs Legacy: the primary check; drives the process exit code.
//   - FML   vs Legacy: informational (shows what the postprocessors correct).
let exitCode;
if (fullOutput && legacyOutput) {
  const fullResult = compareJson(fullOutput, legacyOutput, { labelA: 'Full', labelB: 'Legacy' });
  reportComparison('Full vs Legacy', fullResult);
  exitCode = fullResult.match ? 0 : 1;
} else if (!fullOutput && legacyOutput) {
  console.log('Full vs Legacy: SKIPPED (full pipeline failed)');
  exitCode = 1;
} else if (fullOutput && !legacyOutput) {
  console.log('Full vs Legacy: SKIPPED (legacy converter failed)');
  exitCode = 1;
} else {
  console.log('Full vs Legacy: SKIPPED (both failed)');
  exitCode = 1;
}

if (fmlOutput && legacyOutput) {
  const fmlResult = compareJson(fmlOutput, legacyOutput, { labelA: 'FML', labelB: 'Legacy' });
  reportComparison('FML  vs Legacy', fmlResult);
} else if (!fmlOutput && legacyOutput) {
  console.log('FML  vs Legacy: SKIPPED (FML converter failed)');
} else if (fmlOutput && !legacyOutput) {
  console.log('FML  vs Legacy: SKIPPED (legacy converter failed)');
} else {
  console.log('FML  vs Legacy: SKIPPED (both failed)');
}

process.exit(exitCode);

