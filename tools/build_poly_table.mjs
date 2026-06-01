#!/usr/bin/env node
/**
 * @fileoverview Extract polymorphic field paths from FHIR StructureDefinitions.
 *
 * Reads an HL7 FHIR specification zip archive, finds the StructureDefinition
 * Bundles inside it (profiles-resources.json and profiles-types.json), walks
 * every element across all StructureDefinitions, and writes a JSON file
 * mapping polymorphic field paths to the FHIR type codes they may carry.
 *
 * Output shape (JSON):
 *
 *   {
 *     "fhirVersion":    "R4",
 *     "generated":      "2026-06-01",
 *     "sourceArchive":  "definitions.json.zip",
 *     "sourceBundles":  ["profiles-resources.json", "profiles-types.json"],
 *     "pathCount":      186,
 *     "polyPaths": {
 *       "Observation.value":                 ["CodeableConcept", "Quantity", ...],
 *       "Patient.deceased":                  ["boolean", "dateTime"],
 *       "Questionnaire.item.initial.value":  ["Attachment", "Coding", ...]
 *     }
 *   }
 *
 * Detection: an element is treated as polymorphic if either
 *   - its `path` ends with "[x]", or
 *   - its `type` array contains more than one entry.
 * The two signals usually coincide. Using both is defensive: sliced /
 * constrained polymorphic elements may carry a single type but still have
 * the "[x]" path; primitives sometimes use only multi-type without the
 * suffix in older spec versions.
 *
 * Usage:
 *   node tools/build_poly_table.mjs <VERSION> <out.json> <archive.zip>
 *
 * Arguments:
 *   <VERSION>       Label written verbatim into the output JSON's
 *                   "fhirVersion" field. Convention: DSTU2, STU3, R4, R4B,
 *                   R5. The script does not validate it.
 *   <out.json>      Output file path. Parent directories are created if
 *                   missing. Existing files are overwritten without
 *                   prompting.
 *   <archive.zip>   FHIR specification zip. The script scans entries for
 *                   names ending in "profiles-resources.json" or
 *                   "profiles-types.json" (under any directory prefix,
 *                   with forward or backward slashes). Forms found in the
 *                   wild that are handled:
 *                     - STU3/R4/R5:  entries at the zip root
 *                     - R4B:         entries under "definitions.json/"
 *                     - DSTU2:       entries under "site\" (backslashes)
 *
 * Example:
 *   node tools/build_poly_table.mjs R4 data/fhir-defs/poly-paths/R4.json \
 *        data/fhir-spec-downloads/R4/definitions.json.zip
 *
 * Where to get the archives:
 *   See data/fhir-spec-downloads/README.md.
 *
 * Exit codes:
 *   0  success
 *   1  I/O error reading the archive, or no matching bundles found inside
 *   2  bad or missing arguments
 *
 * Diagnostics (written to stderr):
 *   - List of matched bundle entries inside the archive.
 *   - Per-bundle warning when the parsed JSON is not a FHIR Bundle.
 *   - Summary at end: StructureDefinitions seen / skipped, elements
 *     scanned, polymorphic paths produced.
 *   - One-line note for each of the first 5 elements whose type.code is
 *     missing or empty (older spec versions occasionally encode the type
 *     via an extension instead of a code).
 *
 * @module tools/build_poly_table
 */
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
const args = process.argv.slice(2);
if (args.length !== 3) {
  console.error('Usage: node tools/build_poly_table.mjs <VERSION> <out.json> <archive.zip>');
  process.exit(2);
}
const [version, outFile, zipFile] = args;
/** path -> Set<string> of FHIR type codes the field may hold */
const polyPaths = new Map();
let sdSeen = 0;
let sdSkipped = 0;
let elementsSeen = 0;
let missingTypeCodes = 0;
/**
 * Matches zip entry names whose final path segment is one of the
 * StructureDefinition bundles we care about. Handles both forward (/)
 * and backward (\) path separators.
 */
const BUNDLE_ENTRY_RE = /(^|[\\/])profiles-(resources|types)\.json$/i;
let zipBytes;
try {
  zipBytes = fs.readFileSync(zipFile);
}
catch (e) {
  console.error(`Error reading ${zipFile}: ${e.message}`);
  process.exit(1);
}
const zip = await JSZip.loadAsync(zipBytes);
// Pick the matching entries; sort for deterministic processing order.
const matchedEntries = [];
zip.forEach((entryName, entry) => {
  if (!entry.dir && BUNDLE_ENTRY_RE.test(entryName)) {
    matchedEntries.push(entry);
  }
});
matchedEntries.sort((a, b) => a.name.localeCompare(b.name));
if (matchedEntries.length === 0) {
  console.error(`Error: no profiles-resources.json or profiles-types.json entries found in ${zipFile}`);
  process.exit(1);
}
console.error(`Matched ${matchedEntries.length} bundle(s) in ${path.basename(zipFile)}:`);
for (const e of matchedEntries) console.error(`  ${e.name}`);
const sourceBundleNames = [];
for (const entry of matchedEntries) {
  const text = await entry.async('string');
  // Bundle name for the output record: just the final filename, ignoring
  // any directory prefix the archive happens to use.
  sourceBundleNames.push(entry.name.split(/[\\/]/).pop());
  let bundle;
  try {
    bundle = JSON.parse(text);
  }
  catch (e) {
    console.error(`Warning: failed to parse ${entry.name}: ${e.message}, skipping`);
    continue;
  }
  if (bundle.resourceType !== 'Bundle') {
    console.error(`Warning: ${entry.name} is not a Bundle (resourceType=${bundle.resourceType}), skipping`);
    continue;
  }
  for (const bEntry of bundle.entry || []) {
    const sd = bEntry.resource;
    if (sd?.resourceType !== 'StructureDefinition') continue;
    sdSeen++;
    // Prefer snapshot (fully resolved); fall back to differential.
    const elements = sd.snapshot?.element || sd.differential?.element || [];
    if (elements.length === 0) {
      sdSkipped++;
      continue;
    }
    processElements(elements, sd.id || sd.name || '(unknown)');
  }
}
/**
 * Walk one StructureDefinition's element list, recording polymorphic paths.
 *
 * @param {Array} elements - snapshot.element or differential.element entries.
 * @param {string} sdId    - StructureDefinition id, for diagnostics.
 */
function processElements(elements, sdId) {
  for (const el of elements) {
    elementsSeen++;
    if (!el.path) continue;
    // contentReference elements are pointers; they have no own type array.
    if (!Array.isArray(el.type) || el.type.length === 0) continue;
    const endsWithX = el.path.endsWith('[x]');
    const multiType = el.type.length > 1;
    if (!endsWithX && !multiType) continue;
    const cleanPath = endsWithX ? el.path.slice(0, -3) : el.path;
    const codes = [];
    for (const t of el.type) {
      if (t && typeof t.code === 'string' && t.code.length > 0) {
        codes.push(t.code);
      }
      else {
        // DSTU2 / older versions occasionally encode the type via a
        // structuredefinition-fhir-type extension and omit code.
        missingTypeCodes++;
        if (missingTypeCodes <= 5) {
          console.error(`Note: missing type.code at ${el.path} in ${sdId}`);
        }
      }
    }
    if (codes.length === 0) continue;
    let set = polyPaths.get(cleanPath);
    if (!set) {
      set = new Set();
      polyPaths.set(cleanPath, set);
    }
    for (const c of codes) set.add(c);
  }
}
// Sort paths and types for deterministic, diff-friendly output.
const sortedPaths = [...polyPaths.keys()].sort();
/** @type {Object<string,string[]>} */
const polyPathsObj = {};
for (const p of sortedPaths) {
  polyPathsObj[p] = [...polyPaths.get(p)].sort();
}
const output = {
  fhirVersion:   version,
  generated:     new Date().toISOString().split('T')[0],
  sourceArchive: path.basename(zipFile),
  sourceBundles: sourceBundleNames,
  pathCount:     sortedPaths.length,
  polyPaths:     polyPathsObj,
};
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(output, null, 2) + '\n');
console.error(`Wrote ${outFile}`);
console.error(`  StructureDefinitions: ${sdSeen} (${sdSkipped} skipped, no snapshot/differential)`);
console.error(`  Elements scanned:     ${elementsSeen}`);
console.error(`  Polymorphic paths:    ${sortedPaths.length}`);
if (missingTypeCodes > 0) {
  console.error(`  Elements with missing type.code: ${missingTypeCodes}`);
}
