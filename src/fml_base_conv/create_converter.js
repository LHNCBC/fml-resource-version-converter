/**
 * @fileoverview The pure FML cross-version conversion engine.
 *
 * Public surface:
 *   - createFmlEngineFactory({ xverInputRoot }) -> { hasMapping, createEngine }
 *       a root-bound factory; createEngine(...) yields a single-hop { convert }.
 *   - planHops(fromVer, toVer) -> [[from, to], ...]
 *       pure version-graph hop-math (no filesystem access).
 *
 * This module owns NO processor orchestration or multi-hop chaining; those
 * belong to the integration layer.
 *
 * @module fml_base_conv/create_converter
 */
import fs from 'node:fs';
import path from 'node:path';
import { compileFmlXver } from './fml_xver_engine.js';
import {
  DEFAULT_XVER_ROOT,
  extractConceptMapUrls,
  resolveConceptMaps,
} from './conceptmaps.js';

const __dirname = import.meta.dirname;
const FHIR_DEFS_DIR = path.resolve(__dirname, '../../data/fhir-defs');

const VER_SUFFIX = { R2: '2', R3: '3', R4: '4', R4B: '4B', R5: '5' };

/**
 * FHIR-version label -> consolidated definitions JSON filename.
 * R2 is HL7's later alias for DSTU2; the tables are published under DSTU2.
 */
const DEFS_FILE = {
  R2:   'DSTU2.json',
  R3:   'STU3.json',
  R4:   'R4.json',
  R4B:  'R4B.json',
  R5:   'R5.json',
};

/**
 * Process-lifetime cache for parsed FHIR defs JSONs. Keyed by version
 * label.
 * @type {Map<string, Object|null>}
 */
const fhirDefsCache = new Map();

/**
 * Load and parse the consolidated FHIR definitions table for one version.
 * The file is produced by tools/fhir-spec-parser.js and groups the
 * polyPaths, arrayPaths, and elementTypes sub-tables under one per-version
 * JSON. Returns null (with a warning) when the file is missing or
 * malformed; the engine treats absence as "no info" and behaves as
 * before.
 *
 * Result is cached at module scope for the life of the process.
 *
 * @param {string} ver           'R2' | 'R3' | 'R4' | 'R4B' | 'R5'.
 * @param {Function} [onWarning] Optional warning sink.
 * @returns {Object|null} The parsed JSON or null on failure.
 */
function loadFhirDefs(ver, onWarning) {
  if (fhirDefsCache.has(ver)) return fhirDefsCache.get(ver);
  const file = DEFS_FILE[ver];
  if (!file) { fhirDefsCache.set(ver, null); return null; }
  const full = path.join(FHIR_DEFS_DIR, file);
  try {
    const defs = JSON.parse(fs.readFileSync(full, 'utf-8'));
    fhirDefsCache.set(ver, defs);
    return defs;
  } catch (e) {
    onWarning?.(`Failed to load FHIR defs for ${ver} (${full}): ${e.message}; behavior depending on these tables is disabled`);
    fhirDefsCache.set(ver, null);
    return null;
  }
}


/**
 * Process-lifetime cache for FML-file existence resolution. Keyed by
 * `${xverRoot}::${resType}::${fromVer}::${toVer}` -> resolved path | null.
 * hasMapping()/buildEngine() both resolve the same paths repeatedly (e.g. the
 * integration layer checks hasMapping, then the registry consults it again),
 * and each resolution does up to two fs.existsSync calls; caching removes that
 * redundant filesystem work.
 * @type {Map<string, string|null>}
 */
const fmlFileCache = new Map();

/**
 * Find the FML file path for a resource type and version pair.
 * Tries the versioned filename first (e.g. `Questionnaire4to5.fml`), then
 * falls back to the plain filename (e.g. `Questionnaire.fml`). The result
 * (path or null) is cached for the life of the process.
 *
 * @param {string} resType  FHIR resource type, e.g. 'Questionnaire'.
 * @param {string} fromVer  Source version, e.g. 'R4'.
 * @param {string} toVer    Target version, e.g. 'R5'.
 * @param {string} xverRoot Absolute path to the xver input directory.
 * @returns {string|null} Absolute path to the FML file, or null if not found.
 */
function findFmlFile(resType, fromVer, toVer, xverRoot) {
  const cacheKey = `${xverRoot}::${resType}::${fromVer}::${toVer}`;
  if (fmlFileCache.has(cacheKey)) return fmlFileCache.get(cacheKey);

  const result = resolveFmlFile(resType, fromVer, toVer, xverRoot);
  fmlFileCache.set(cacheKey, result);
  return result;
}

/**
 * Resolve the FML file path without caching (see findFmlFile for the cached
 * entry point).
 *
 * @param {string} resType  FHIR resource type.
 * @param {string} fromVer  Source version.
 * @param {string} toVer    Target version.
 * @param {string} xverRoot Absolute path to the xver input directory.
 * @returns {string|null} Absolute path to the FML file, or null if not found.
 */
function resolveFmlFile(resType, fromVer, toVer, xverRoot) {
  const fromSuffix = VER_SUFFIX[fromVer];
  const toSuffix   = VER_SUFFIX[toVer];
  if (!fromSuffix || !toSuffix) return null;

  const dir = path.join(xverRoot, `${fromVer}to${toVer}`);
  const versionedPath = path.join(dir, `${resType}${fromSuffix}to${toSuffix}.fml`);
  if (fs.existsSync(versionedPath)) return versionedPath;

  const plainPath = path.join(dir, `${resType}.fml`);
  if (fs.existsSync(plainPath)) return plainPath;

  return null;
}

/**
 * Process-lifetime cache for imported FML texts. Keyed by
 * `${fmlDir}::${mainFmlFile}`. Each entry directory typically holds
 * dozens of sibling .fml files.
 * I/O.
 * @type {Map<string, string[]>}
 */
const importedFmlCache = new Map();

/**
 * Extract the imports wildcard pattern from FML text and resolve matching
 * FML files in the same directory.
 *
 * FML `imports` declarations look like:
 *   imports "http://hl7.org/fhir/uv/xver/StructureMap/*4to3"
 *
 * The wildcard `*4to3` means "all StructureMaps in this package whose
 * canonical name ends with 4to3". In practice, every `.fml` file in a
 * version directory (e.g. R4toR3/) belongs to the same package and shares
 * the same version suffix in its internal name. The filenames themselves
 * are plain (e.g. `Coding.fml`, not `Coding4to3.fml`), so we load all
 * sibling `.fml` files in the directory, excluding only the main file
 * itself to avoid circular imports.
 *
 * Results are cached at module scope for the life of the process.
 *
 * @param {string} fmlText      The raw FML source text.
 * @param {string} fmlDir       Absolute path to the directory containing
 *                              the main FML file.
 * @param {string} mainFmlFile  Absolute path of the main FML file (excluded
 *                              from results to prevent self-import).
 * @param {Function} [onWarning]
 * @returns {string[]} Array of FML source texts from imported files.
 */
function loadImportedFmlTexts(fmlText, fmlDir, mainFmlFile, onWarning) {
  // Only proceed if the FML text declares at least one wildcard import.
  const importRe = /imports\s+['"]([^'"]+)['"]/g;
  let hasWildcardImport = false;
  let match;
  while ((match = importRe.exec(fmlText)) !== null) {
    const lastSeg = match[1].split('/').pop();
    if (lastSeg && lastSeg.startsWith('*')) {
      hasWildcardImport = true;
      break;
    }
  }

  if (!hasWildcardImport) return [];

  const cacheKey = `${fmlDir}::${mainFmlFile}`;
  if (importedFmlCache.has(cacheKey)) return importedFmlCache.get(cacheKey);

  // Load all sibling .fml files (they all belong to the same import set).
  let dirEntries;
  try {
    dirEntries = fs.readdirSync(fmlDir);
  } catch (e) {
    onWarning?.(`loadImportedFmlTexts: cannot read directory ${fmlDir}: ${e.message}`);
    importedFmlCache.set(cacheKey, []);
    return [];
  }

  const texts = [];
  for (const entry of dirEntries) {
    if (!entry.endsWith('.fml')) continue;
    const fullPath = path.join(fmlDir, entry);
    if (fullPath === mainFmlFile) continue;

    try {
      texts.push(fs.readFileSync(fullPath, 'utf-8'));
    } catch (e) {
      onWarning?.(`loadImportedFmlTexts: failed to read ${fullPath}: ${e.message}`);
    }
  }

  importedFmlCache.set(cacheKey, texts);
  return texts;
}

// ===== version lanes (hop-math) ============================================

/**
 * Linear conversion lanes: ordered version sequences connected by direct FML
 * mappings. A conversion is supported only when both endpoints lie on the SAME
 * lane; the hops are then the consecutive steps between them along that lane.
 *   - main lane: R2 - R3 - R4 - R5
 *   - R4B lane:  R4B - R5
 * R5 is the only version shared by both lanes; every other version belongs to
 * exactly one. Consequently R4B converts only with R5, and R4B is never an
 * intermediate hop (multi-hop routing stays on the main lane).
 * @type {string[][]}
 */
const CONVERSION_LANES = [
  ['R2', 'R3', 'R4', 'R5'],
  ['R4B', 'R5'],
];

/** All canonical versions known to the hop-math (the union of the lanes). */
const KNOWN_VERSIONS = new Set(CONVERSION_LANES.flat());

/**
 * Plan the (shortest) conversion path from fromVer to toVer, e.g., R3 -> R5 is
 * accomplished by two hops: R3->R4 and R4->R5, because there is no direct FML
 * mapping file between R3 and R5.
 *
 * R4B has FML mappings only with R5. Conversions between R4B and {R2,R3} are not
 * supported and an error will be thrown. Callers may consider using R4 in place
 * of R4B for this type of conversion, which should be sufficient in general.
 *
 * @param {string} fromVer  Canonical source version (R2|R3|R4|R4B|R5).
 * @param {string} toVer    Canonical target version (R2|R3|R4|R4B|R5).
 * @returns {Array<[string, string]>} e.g. [['R3','R4'], ['R4','R5']].
 * @throws {Error} On unknown versions, an unsupported R4B pair, or when no path
 *          exists. Specifically, an error will be thrown if fromVer === toVer
 *          or if the conversion is between R4 and R4B (in either direction).
 */
export function planHops(fromVer, toVer) {
  if (!KNOWN_VERSIONS.has(fromVer)) throw new Error(`Unknown FHIR version: ${fromVer}`);
  if (!KNOWN_VERSIONS.has(toVer))   throw new Error(`Unknown FHIR version: ${toVer}`);

  // Special cases handled up front.
  if (fromVer === toVer) {
    throw new Error(`Unsupported conversion ${fromVer} -> ${toVer}: source and target versions are the same`);
  }
  if ((fromVer === 'R4' && toVer === 'R4B') || (fromVer === 'R4B' && toVer === 'R4')) {
    throw new Error(`Unsupported conversion ${fromVer} -> ${toVer}: R4 and R4B are near-equivalent and have no conversion between them`);
  }

  // Both endpoints must lie on the same lane; the hops are the consecutive
  // steps between them along that lane (in the requested direction).
  for (const lane of CONVERSION_LANES) {
    const i = lane.indexOf(fromVer);
    const j = lane.indexOf(toVer);
    if (i === -1 || j === -1) continue;
    const step = i < j ? 1 : -1;
    const hops = [];
    for (let k = i; k !== j; k += step) hops.push([lane[k], lane[k + step]]);
    return hops;
  }

  // No shared lane: e.g. R4B paired with R2 or R3.
  throw new Error(`Unsupported conversion ${fromVer} -> ${toVer}`);
}

/**
 * List every directed adjacent version pair that has a direct FML mapping.
 *
 * Derived from the conversion lanes (the single source of truth for the
 * version graph): each consecutive lane pair contributes both directions.
 * Duplicates are removed (R5 is shared by both lanes). This is the closed set
 * of one-hop conversions and drives the postprocessor sub-registry layout.
 *
 * @returns {Array<[string, string]>} e.g. [['R2','R3'],['R3','R2'],...].
 */
export function getAdjacentPairs() {
  const seen = new Set();
  const pairs = [];
  for (const lane of CONVERSION_LANES) {
    for (let i = 0; i < lane.length - 1; i++) {
      for (const [from, to] of [[lane[i], lane[i + 1]], [lane[i + 1], lane[i]]]) {
        const key = `${from}->${to}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push([from, to]);
      }
    }
  }
  return pairs;
}

// ===== engine factory ======================================================

/**
 * Compile a single FML file into a single-hop conversion engine. Internal
 * helper behind the factory's createEngine().
 *
 * @param {string}  resType   FHIR resource type, e.g. 'Questionnaire'.
 * @param {string}  fromVer   Canonical source version.
 * @param {string}  toVer     Canonical target version.
 * @param {string}  xverRoot  Absolute path to the FML input root.
 * @param {Object}  [opts]    Per-conversion options (see createEngine).
 * @returns {{convert: Function}}
 * @throws {Error} If the FML file is missing, or if strict is set and a
 *                 referenced ConceptMap file is missing or unparseable.
 */
function buildEngine(resType, fromVer, toVer, xverRoot, opts = {}) {

  const fmlFile = findFmlFile(resType, fromVer, toVer, xverRoot);
  if (!fmlFile) throw new Error(`FML file not found for ${resType} ${fromVer}->${toVer}`);
  const fmlText = fs.readFileSync(fmlFile, 'utf-8');

  // Resolve imported type-group FML files (Coding, Reference, etc.)
  const fmlDir = path.dirname(fmlFile);
  const importedFmlTexts = loadImportedFmlTexts(fmlText, fmlDir, fmlFile, opts.onWarning);

  const cmUrls = new Set(extractConceptMapUrls(fmlText));
  // Imported type-group FML files (e.g. Coding.fml, Reference.fml) can
  // contain their own translate() calls; the main file isn't required
  // to reference those ConceptMaps directly. Scan them too so every
  // map a transitively-invoked group might need is preloaded.
  for (const importedText of importedFmlTexts) {
    for (const url of extractConceptMapUrls(importedText)) cmUrls.add(url);
  }
  // Resolve referenced ConceptMaps. Missing files and parse errors are
  // environmental facts (a property of the data install), surfaced up front by
  // the maintainer scan (tools/check-data.js), NOT the per-conversion sink:
  // they affect a conversion only if a rule actually translates against the map,
  // in which case the engine warns at translate time. In strict mode, any such
  // gap is instead a hard error.
  const { conceptMaps, missingConceptMaps, parseErrors } = resolveConceptMaps(cmUrls, xverRoot);
  if (opts.strict && (missingConceptMaps.length || parseErrors.length)) {
    const miss = missingConceptMaps.join(', ');
    const perr = parseErrors.map(p => `${p.id}: ${p.error}`).join('; ');
    throw new Error(
      `ConceptMap resolution failed (strict): missing [${miss}]; parseErrors [${perr}]`,
    );
  }

  const engine = compileFmlXver({
    fmlText, conceptMaps, importedFmlTexts,
    strict: opts.strict ?? false,
    fromVer, toVer,
    srcDefs: loadFhirDefs(fromVer, opts.onWarning),
    tgtDefs: loadFhirDefs(toVer,   opts.onWarning),
    onWarning: opts.onWarning, onInfo: opts.onInfo, onRuleExec: opts.onRuleExec,
  });

  // Pure engine surface: expose only convert(). The compiler's introspection
  // fields (metadata/uses/groups) stay internal to keep the contract minimal.
  return { convert: engine.convert };
}

/**
 * Create a root-bound FML engine factory. The FML mapping files root is
 * resolved once here; the returned helpers are keyed only by resource type
 * and version pair.
 *
 * @param {Object} [config]
 * @param {string} [config.xverInputRoot] FML mapping files root; defaults to
 *        the bundled data path (data/fhir-cross-version/input).
 * @returns {{
 *   hasMapping: (resType: string, fromVer: string, toVer: string) => boolean,
 *   createEngine: (resType: string, fromVer: string, toVer: string, opts?: Object) => {convert: Function},
 * }}
 */
export function createFmlEngineFactory({ xverInputRoot } = {}) {
  const xverRoot = xverInputRoot || DEFAULT_XVER_ROOT;

  return {
    /**
     * Whether an FML mapping exists for this resource type on this hop.
     * Lets the integration layer decide before building an engine.
     *
     * @param {string} resType
     * @param {string} fromVer
     * @param {string} toVer
     * @returns {boolean}
     */
    hasMapping(resType, fromVer, toVer) {
      return !!findFmlFile(resType, fromVer, toVer, xverRoot);
    },

    /**
     * Build a single-hop engine for this resource type and version pair.
     *
     * @param {string}   resType
     * @param {string}   fromVer
     * @param {string}   toVer
     * @param {Object}   [opts]              Per-conversion options.
     * @param {boolean}  [opts.strict=false] Throw on missing ConceptMap /
     *        unmappable code (otherwise warn and continue).
     * @param {Function} [opts.onWarning]    `(msg) => void` soft-issue sink.
     * @param {Function} [opts.onInfo]       `(msg) => void` info sink.
     * @param {Function} [opts.onRuleExec]   `({rule, srcVal}) => void` per-rule
     *        tracing hook (observational only).
     * @returns {{convert: Function}}
     */
    createEngine(resType, fromVer, toVer, opts = {}) {
      return buildEngine(resType, fromVer, toVer, xverRoot, opts);
    },
  };
}

