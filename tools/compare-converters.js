#!/usr/bin/env node

/**
 * @fileoverview Compare FML-based and legacy (hand-coded) Questionnaire converters.
 *
 * Usage:
 *   node test/compare-converters.js <from-version> <to-version> <questionnaire.json> [output-dir]
 *
 * Examples:
 *   node test/compare-converters.js R4 R5 test/data/qn-ver-conv-test-r4base.json
 *   node test/compare-converters.js R4 R5 test/data/qn-ver-conv-test-r4base.json ./output
 *   node test/compare-converters.js STU3 R4 my-questionnaire.json /tmp/out
 *
 * Versions: STU3 (or R3), R4, R4B, R5
 *
 * Output:
 *   - Runs both converters and reports success/failure
 *   - Optionally writes results to output-dir as <basename>-fml.json and <basename>-legacy.json
 *   - Compares outputs (key order insignificant, array order significant)
 *   - Reports "MATCH" or lists specific differences with JSON paths
 */

import fs from 'node:fs';
import path from 'node:path';
import { createFmlEngineFactory } from '../src/fml_base_conv/create_converter.js';
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
 */
function findDiffs(a, b, path, diffs) {
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
      findDiffs(a[i], b[i], `${path}[${i}]`, diffs);
    }
    return;
  }

  // Both are objects
  const keysA = new Set(Object.keys(a));
  const keysB = new Set(Object.keys(b));

  for (const key of keysA) {
    if (!keysB.has(key)) {
      diffs.push(`${path}.${key}: present in FML output, missing in legacy`);
    } else {
      findDiffs(a[key], b[key], `${path}.${key}`, diffs);
    }
  }

  for (const key of keysB) {
    if (!keysA.has(key)) {
      diffs.push(`${path}.${key}: missing in FML output, present in legacy`);
    }
  }
}


/**
 * Compare two JSON values, ignoring object key order.
 *
 * @param {*} a First value.
 * @param {*} b Second value.
 * @returns {{ match: boolean, diffs: string[] }}
 */
function compareJson(a, b) {
  const sortedA = sortKeys(a);
  const sortedB = sortKeys(b);

  if (JSON.stringify(sortedA) === JSON.stringify(sortedB)) {
    return { match: true, diffs: [] };
  }

  const diffs = [];
  findDiffs(sortedA, sortedB, '$', diffs);
  return { match: false, diffs };
}


// --- Main ---

const args = process.argv.slice(2);

if (args.length < 3 || args.includes('-h') || args.includes('--help')) {
  console.log(`Usage: node tools/compare-converters.js <from-version> <to-version> <questionnaire.json> [output-dir]

Versions: STU3 (or R3), R4, R4B, R5

If output-dir is provided, writes:
  <basename>-fml.json     FML converter output
  <basename>-legacy.json  Legacy converter output

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

if (fmlOutput && legacyOutput) {
  const { match, diffs } = compareJson(fmlOutput, legacyOutput);

  if (match) {
    console.log('Comparison: MATCH');
    process.exit(0);
  } else {
    console.log(`Comparison: ${diffs.length} difference(s) (FML vs Legacy)`);
    for (const diff of diffs.slice(0, 20)) {
      console.log(`  ${diff}`);
    }
    if (diffs.length > 20) {
      console.log(`  ... and ${diffs.length - 20} more`);
    }
    process.exit(1);
  }
} else if (fmlOutput && !legacyOutput) {
  console.log('Comparison: SKIPPED (legacy converter failed)');
  process.exit(1);
} else if (!fmlOutput && legacyOutput) {
  console.log('Comparison: SKIPPED (FML converter failed)');
  process.exit(1);
} else {
  console.log('Comparison: SKIPPED (both converters failed)');
  process.exit(1);
}

