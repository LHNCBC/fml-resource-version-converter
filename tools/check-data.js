#!/usr/bin/env node
/**
 * @fileoverview Maintainer data-integrity check for the bundled FHIR
 * cross-version data.
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
 *   - It also reports the mapping-selection ambiguities declared by the FML
 *     files. This part is INFORMATIONAL ONLY and never affects the exit code:
 *     an ambiguity is not a defect, but a change to the list is something a
 *     contributor should notice and address (see below).
 *
 * WHEN TO RUN: after refreshing the bundled data/fhir-cross-version/ snapshot.
 * Refreshes are infrequent, so this check is deliberately a manual step rather
 * than part of the test suite. Compare the reported ambiguities against
 * CONVERSION-AMBIGUITY.md: a new or disappeared entry means that document, and
 * possibly README.md, needs updating.
 *
 * Exit code: 0 when the data is clean; 1 when any referenced standalone map is
 * missing or unparseable. Reported ambiguities do not influence it.
 *
 * Usage:
 *   node tools/check-data.js [dataRoot]
 *     dataRoot - optional FML input root to check
 *                (default: the bundled data/fhir-cross-version/input)
 *
 * @module tools/check-data
 */
import path from 'node:path';
import { getAdjacentPairs } from '../src/fml_base_conv/create_converter.js';
import { scanConceptMaps, DEFAULT_XVER_ROOT } from '../src/fml_base_conv/conceptmaps.js';
import { scanResourceMappings } from '../src/fml_base_conv/fml_mapping_catalog.js';

/**
 * Find the mapping-selection ambiguities declared for one version direction.
 *
 * Type A is a source resource type that declares more than one target resource
 * type; the caller must then name the intended target. Type B is a
 * source/target pair served by more than one mapping file, which the converter
 * cannot resolve on its own.
 *
 * @param {string} fromVer Canonical source version.
 * @param {string} toVer Canonical target version.
 * @param {string} dataRoot FML input root to scan.
 * @returns {{typeA: Array<Object>, typeB: Array<Object>}} Ambiguities found.
 */
function findMappingAmbiguities(fromVer, toVer, dataRoot) {
  const bySource = scanResourceMappings(fromVer, toVer, dataRoot);
  const typeA = [];
  const typeB = [];

  for (const [sourceType, candidates] of bySource) {
    const targets = [...new Set(candidates.map(c => c.targetResourceType))].sort();
    if (targets.length > 1) typeA.push({ sourceType, targets });

    const byTarget = new Map();
    for (const candidate of candidates) {
      const group = byTarget.get(candidate.targetResourceType) || [];
      group.push(candidate);
      byTarget.set(candidate.targetResourceType, group);
    }

    for (const [targetType, group] of byTarget) {
      if (group.length < 2) continue;
      typeB.push({
        sourceType,
        targetType,
        mapFiles: group.map(d => path.basename(d.filePath)).sort(),
      });
    }
  }

  typeA.sort((a, b) => a.sourceType.localeCompare(b.sourceType));
  typeB.sort((a, b) =>
    a.sourceType.localeCompare(b.sourceType) || a.targetType.localeCompare(b.targetType));
  return { typeA, typeB };
}

/**
 * Print the informational mapping-ambiguity report for all adjacent pairs.
 *
 * Deliberately does not affect the exit code: the point is to make a change
 * visible to whoever refreshed the data, not to fail the run.
 *
 * @param {Array<[string, string]>} pairs Directed adjacent version pairs.
 * @param {string} dataRoot FML input root to scan.
 * @returns {void}
 */
function reportMappingAmbiguities(pairs, dataRoot) {
  console.log('\nMapping selection ambiguities (informational)');

  let typeATotal = 0;
  let typeBTotal = 0;

  for (const [from, to] of pairs) {
    let found;
    try {
      found = findMappingAmbiguities(from, to, dataRoot);
    } catch (e) {
      // Reported, but not fatal: this pass is advisory, and the ConceptMap
      // check above owns the exit code.
      console.log(`  WARN  ${from} -> ${to}: could not scan mappings: ${e.message}`);
      continue;
    }

    const { typeA, typeB } = found;
    if (typeA.length === 0 && typeB.length === 0) continue;
    typeATotal += typeA.length;
    typeBTotal += typeB.length;

    console.log(`  ${from} -> ${to}:`);
    for (const a of typeA) {
      console.log(`    Type A  ${a.sourceType} -> ${a.targets.join(' | ')}`);
    }
    for (const b of typeB) {
      console.log(
        `    Type B  ${b.sourceType} -> ${b.targetType}: ${b.mapFiles.join(', ')}`,
      );
    }
  }

  if (typeATotal === 0 && typeBTotal === 0) {
    console.log('  none found.');
    return;
  }
  console.log(
    `\n  ${typeATotal} Type A and ${typeBTotal} Type B ambiguity/ambiguities found.`,
  );
  console.log(
    '  These are not errors. If this list differs from CONVERSION-AMBIGUITY.md,\n' +
    '  update that document (and README.md if a documented limitation changed).',
  );
}

/**
 * Run the data-integrity check across all adjacent version pairs and print a
 * per-pair report. A pair whose scan throws (e.g. a missing/unreadable data
 * root) is reported as a per-pair ERROR and the run continues, so every problem
 * pair is enumerated in one pass. Exits the process non-zero if any problem is
 * found.
 *
 * @returns {void}
 */
function main() {
  const dataRoot = process.argv[2] || DEFAULT_XVER_ROOT;
  console.log(`Checking data root: ${dataRoot}\n`);


  const pairs = getAdjacentPairs();
  let missingTotal = 0;
  let parseErrorTotal = 0;
  let scanErrorTotal = 0;

  for (const [from, to] of pairs) {
    let result;
    try {
      result = scanConceptMaps(from, to, dataRoot);
    } catch (e) {
      // A scan that throws (e.g. a missing/unreadable pair directory under the
      // given root) is a per-pair failure, not a reason to abort the whole run.
      // Report it cleanly and continue so every problem pair is enumerated in a
      // single pass and the summary below is always printed.
      scanErrorTotal += 1;
      console.error(`ERROR ${from} -> ${to}: ${e.message}`);
      continue;
    }

    const { missingConceptMaps, parseErrors } = result;
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
    `${missingTotal} missing, ${parseErrorTotal} unparseable, ${scanErrorTotal} scan error(s).`,
  );

  // Advisory pass; deliberately after the summary and outside the exit-code
  // decision below.
  reportMappingAmbiguities(pairs, dataRoot);

  if (missingTotal > 0 || parseErrorTotal > 0 || scanErrorTotal > 0) {
    console.error('Data integrity check FAILED.');
    process.exit(1);
  }
  console.log('Data integrity check passed.');
}

main();

