#!/usr/bin/env node
/**
 * @fileoverview Maintainer data-integrity check for the bundled FHIR
 * cross-version ConceptMap data.
 *
 * SCOPE - deliberately narrow. This is a maintainer/CI utility, NOT part of the
 * runtime library and NOT intended for package consumers:
 *   - For every adjacent version pair, it statically verifies that each
 *     standalone ConceptMap referenced by the FML mappings is present on disk
 *     and parses as JSON.
 *   - Contained (#-fragment) ConceptMaps are inline in their holder resource and
 *     are intentionally NOT checked here (they are never standalone files).
 *   - It does NOT validate mapping *content* (e.g. whether a particular source
 *     code is covered by a map). That is input-dependent and is reported per
 *     conversion at translate time, not statically.
 *
 *
 * Exit code: 0 when the data is clean; 1 when any referenced standalone map is
 * missing or unparseable.
 *
 * Usage:
 *   node tools/check-data.js [dataRoot]
 *     dataRoot - optional FML input root to check
 *                (default: the bundled data/fhir-cross-version/input)
 *
 * @module tools/check-data
 */
import { getAdjacentPairs } from '../src/fml_base_conv/create_converter.js';
import { scanConceptMaps, DEFAULT_XVER_ROOT } from '../src/fml_base_conv/conceptmaps.js';

/**
 * Run the data-integrity check across all adjacent version pairs and print a
 * per-pair report. Exits the process non-zero if any problem is found.
 *
 * @returns {void}
 */
function main() {
  const dataRoot = process.argv[2] || DEFAULT_XVER_ROOT;
  console.log(`Checking data root: ${dataRoot}\n`);

  const pairs = getAdjacentPairs();
  let missingTotal = 0;
  let parseErrorTotal = 0;

  for (const [from, to] of pairs) {
    const { missingConceptMaps, parseErrors } = scanConceptMaps(from, to, dataRoot);
    missingTotal += missingConceptMaps.length;
    parseErrorTotal += parseErrors.length;

    if (missingConceptMaps.length === 0 && parseErrors.length === 0) {
      console.log(`ok    ${from} -> ${to}`);
      continue;
    }
    // Parse errors are the more serious signal (a corrupt/malformed file);
    // a missing standalone map is a lesser gap. Report both.
    if (parseErrors.length) {
      console.log(`ERROR ${from} -> ${to}: ${parseErrors.length} unparseable file(s):`);
      for (const pe of parseErrors) console.log(`        - ${pe.id}: ${pe.error}`);
    }
    if (missingConceptMaps.length) {
      console.log(`WARN  ${from} -> ${to}: ${missingConceptMaps.length} missing standalone map(s):`);
      for (const id of missingConceptMaps) console.log(`        - ${id}`);
    }
  }

  console.log(
    `\nSummary: ${pairs.length} pair(s) checked; ` +
    `${missingTotal} missing, ${parseErrorTotal} unparseable.`,
  );

  if (missingTotal > 0 || parseErrorTotal > 0) {
    console.error('Data integrity check FAILED.');
    process.exit(1);
  }
  console.log('Data integrity check passed.');
}

main();

