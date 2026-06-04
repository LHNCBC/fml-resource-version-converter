#!/usr/bin/env node
/**
 * @fileoverview Extract derived FHIR element tables from a spec zip.
 *
 * Walks an HL7 FHIR specification zip archive, scans every element of
 * every StructureDefinition inside profiles-resources.json and
 * profiles-types.json, and writes a single consolidated JSON file per
 * FHIR version under the chosen output directory:
 *
 *   <out-dir>/<VERSION>.json
 *
 * The file groups three sibling sub-tables, all keyed by FHIR dotted
 * path (with any trailing "[x]" stripped uniformly via classifyElement):
 *
 *   polyPaths     Polymorphic field paths and their allowed FHIR type
 *                 codes. Consumed by the FML engine to expand bare
 *                 polymorphic references (e.g. STU3 "src.initial" ->
 *                 "src.initialString") and to decide whether to apply a
 *                 typed suffix on the target side.
 *
 *   arrayPaths    Paths whose max cardinality is > 1 (arrays in the JSON
 *                 encoding). Consumed by the FML engine to know when to
 *                 wrap a target write in an array container (e.g. R4
 *                 "Questionnaire.item.initial" is an array but R3
 *                 "Questionnaire.item.initial" is scalar).
 *
 *   elementTypes  Single concrete FHIR type code for each non-poly
 *                 scalar element. Consumed by the FML engine to know
 *                 when source and target element types differ across
 *                 versions, so a <<types>> conversion group can be
 *                 auto-invoked (e.g. R4 canonical -> R3 Reference).
 *
 * All three are produced from a single pass over the StructureDefinitions
 * so the cost stays at one zip read per version, and the three tables
 * cannot drift apart in their interpretation of the source data.
 *
 * Output file shape:
 *
 *   <out-dir>/<VERSION>.json
 *   {
 *     "fhirVersion":    "R4",
 *     "generated":      "2026-06-04",
 *     "sourceArchive":  "definitions.json.zip",
 *     "sourceBundles":  ["profiles-resources.json", "profiles-types.json"],
 *     "pathCounts": {
 *       "poly":         186,
 *       "array":        3153,
 *       "elementTypes": 3300
 *     },
 *     "polyPaths": {
 *       "Observation.value":                 ["CodeableConcept", "Quantity", "..."],
 *       "Questionnaire.item.initial.value":  ["Attachment", "Coding", "..."]
 *     },
 *     "arrayPaths": [
 *       "Bundle.entry",
 *       "Patient.name",
 *       "..."
 *     ],
 *     "elementTypes": {
 *       "Patient.gender":                    "code",
 *       "Patient.identifier":                "Identifier",
 *       "Questionnaire.item.answerValueSet": "canonical"
 *     }
 *   }
 *
 * Detection rules:
 *
 *   Polymorphic: element.path ends with "[x]" OR element.type has more
 *   than one entry. The two signals usually coincide; using both is
 *   defensive (constrained/sliced polymorphics may carry a single type
 *   but still have the "[x]" path).
 *
 *   Array: element.max is present and is neither "0" nor "1". Most
 *   arrays use max="*" but FHIR also permits numeric bounds like "2".
 *
 *   Scalar type: element is non-poly (single type[] entry, path does
 *   not end in "[x]") AND that entry has a non-empty `code` string.
 *
 * Usage:
 *   node tools/build_fhir_tables.mjs <VERSION> <archive.zip> <out-dir>
 *
 * Arguments:
 *   <VERSION>       Label written verbatim into the output JSON's
 *                   "fhirVersion" field. Convention: DSTU2, STU3, R4,
 *                   R4B, R5. The script does not validate it.
 *   <archive.zip>   FHIR specification zip. The script scans entries for
 *                   names ending in "profiles-resources.json" or
 *                   "profiles-types.json" (under any directory prefix,
 *                   with forward or backward slashes). Forms found in
 *                   the wild that are handled:
 *                     - STU3/R4/R5:  entries at the zip root
 *                     - R4B:         entries under "definitions.json/"
 *                     - DSTU2:       entries under "site\" (backslashes)
 *   <out-dir>       Directory under which the per-version output JSON
 *                   files will be created. Existing per-version output
 *                   files are overwritten without prompting.
 *
 * Example:
 *   node tools/build_fhir_tables.mjs R4 \
 *        data/fhir-spec-downloads/R4/definitions.json.zip \
 *        data/fhir-defs
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
 *     scanned, counts of polymorphic, array, and scalar-type paths.
 *   - One-line note for each of the first 5 elements whose type.code is
 *     missing or empty (older spec versions occasionally encode the type
 *     via an extension instead of a code).
 *
 * @module tools/build_fhir_tables
 */

import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { BUNDLE_ENTRY_RE, processElements } from './fhir_tables_lib.mjs';

const args = process.argv.slice(2);

if (args.length !== 3) {
  console.error('Usage: node tools/build_fhir_tables.mjs <VERSION> <archive.zip> <out-dir>');
  process.exit(2);
}

const [version, zipFile, outDir] = args;

/** path -> Set<string> of FHIR type codes the field may hold */
const polyPaths = new Map();

/** Set<string> of paths whose max cardinality is greater than 1 */
const arrayPaths = new Set();

/** path -> single concrete FHIR type code for non-polymorphic scalar elements */
const elementTypes = new Map();

let sdSeen = 0;
let sdSkipped = 0;
let elementsSeen = 0;
let missingTypeCodes = 0;

/** Diagnostic sink for processElements, throttled to the first 5 notes. */
function noteMissingTypeCode(elPath, sdId) {
  missingTypeCodes++;
  if (missingTypeCodes <= 5) {
    console.error(`Note: missing type.code at ${elPath} in ${sdId}`);
  }
}

let zipBytes;
try {
  zipBytes = fs.readFileSync(zipFile);
}
catch (e) {
  console.error(`Error reading ${zipFile}: ${e.message}`);
  process.exit(1);
}

const zip = await JSZip.loadAsync(zipBytes);

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

    const elements = sd.snapshot?.element || sd.differential?.element || [];
    if (elements.length === 0) {
      sdSkipped++;
      continue;
    }

    const sdId = sd.id || sd.name || '(unknown)';
    elementsSeen += processElements(elements, polyPaths, arrayPaths, elementTypes, noteMissingTypeCode, sdId);
  }
}

/**
 * Write a JSON file with sorted, deterministic content. Creates parent
 * directories as needed.
 */
function writeJson(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n');
}

const generated = new Date().toISOString().split('T')[0];
const sourceArchive = path.basename(zipFile);

// ----- Build consolidated payload (Layout A: three sibling sub-tables) -----

const sortedPolyPaths = [...polyPaths.keys()].sort();
/** @type {Object<string,string[]>} */
const polyPathsObj = {};
for (const p of sortedPolyPaths) {
  polyPathsObj[p] = [...polyPaths.get(p)].sort();
}

const sortedArrayPaths = [...arrayPaths].sort();

const sortedElementTypePaths = [...elementTypes.keys()].sort();
/** @type {Object<string,string>} */
const elementTypesObj = {};
for (const p of sortedElementTypePaths) {
  elementTypesObj[p] = elementTypes.get(p);
}

const outFile = path.join(outDir, `${version}.json`);
writeJson(outFile, {
  fhirVersion:   version,
  generated,
  sourceArchive,
  sourceBundles: sourceBundleNames,
  pathCounts: {
    poly:         sortedPolyPaths.length,
    array:        sortedArrayPaths.length,
    elementTypes: sortedElementTypePaths.length,
  },
  polyPaths:    polyPathsObj,
  arrayPaths:   sortedArrayPaths,
  elementTypes: elementTypesObj,
});

console.error(`Wrote ${outFile}`);
console.error(`  StructureDefinitions: ${sdSeen} (${sdSkipped} skipped, no snapshot/differential)`);
console.error(`  Elements scanned:     ${elementsSeen}`);
console.error(`  Polymorphic paths:    ${sortedPolyPaths.length}`);
console.error(`  Array paths:          ${sortedArrayPaths.length}`);
console.error(`  Scalar-type paths:    ${sortedElementTypePaths.length}`);
if (missingTypeCodes > 0) {
  console.error(`  Elements with missing type.code: ${missingTypeCodes}`);
}

