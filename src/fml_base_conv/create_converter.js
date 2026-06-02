/**
 * @fileoverview Factory functions to create FML cross-version converters.
 *
 * Three levels of abstraction:
 *   - `createFmlEngine`        — compiles a single FML file (lowest level)
 *   - `createConverter`        — single-hop conversion with optional pre/post processors
 *   - `createChainedConverter` — multi-hop conversion with per-hop processors via factory
 *
 * @module fml_base_conv/create_converter
 */
import fs from 'node:fs';
import path from 'node:path';
import { compileFmlXver } from './fml_xver_engine.js';

const __dirname = import.meta.dirname;
const DEFAULT_XVER_ROOT = path.resolve(__dirname, '../../fhir-cross-version/input');
const POLY_PATHS_DIR    = path.resolve(__dirname, '../../data/fhir-defs/poly-paths');

const VER_SUFFIX = { R2: '2', R3: '3', R4: '4', R4B: '4B', R5: '5' };

/**
 * FHIR-version label -> poly-paths JSON file basename.
 * R2 is HL7's later alias for DSTU2; the table is published under DSTU2.
 */
const POLY_PATHS_FILE = {
  R2:   'DSTU2.json',
  R3:   'STU3.json',
  R4:   'R4.json',
  R4B:  'R4B.json',
  R5:   'R5.json',
};

/**
 * Load and parse the poly-paths table for one FHIR version.
 * Returns null (with a warning) when the file is missing or malformed; the
 * engine treats absence as "no expansion possible" and behaves as before.
 *
 * @param {string} ver        'R2' | 'R3' | 'R4' | 'R4B' | 'R5'.
 * @param {Function} [onWarning] Optional warning sink.
 * @returns {Object|null} The parsed JSON or null on failure.
 */
function loadPolyPaths(ver, onWarning) {
  const file = POLY_PATHS_FILE[ver];
  if (!file) return null;
  const full = path.join(POLY_PATHS_DIR, file);
  try {
    return JSON.parse(fs.readFileSync(full, 'utf-8'));
  } catch (e) {
    onWarning?.(`Failed to load poly-paths table for ${ver} (${full}): ${e.message}; polymorphic expansion disabled for this version`);
    return null;
  }
}

/**
 * Find the FML file path for a resource type and version pair.
 * Tries the versioned filename first (e.g. `Questionnaire4to5.fml`), then
 * falls back to the plain filename (e.g. `Questionnaire.fml`).
 *
 * @param {string} resType  FHIR resource type, e.g. 'Questionnaire'.
 * @param {string} fromVer  Source version, e.g. 'R4'.
 * @param {string} toVer    Target version, e.g. 'R5'.
 * @param {string} xverRoot Absolute path to the xver input directory.
 * @returns {string|null} Absolute path to the FML file, or null if not found.
 */
function findFmlFile(resType, fromVer, toVer, xverRoot) {
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
 * Scan FML text for ConceptMap URLs referenced by `translate(...)` calls.
 * Tolerates both single and double quotes around URL and code-mode args.
 *
 * @param {string} fmlText  The raw FML source text.
 * @returns {string[]} Unique canonical ConceptMap URLs, in declaration order.
 */
function extractConceptMapUrls(fmlText) {
  const urls = new Set();
  const re = /translate\s*\([^,]+,\s*['"]([^'"]+)['"]\s*,\s*['"][^'"]*['"]\s*\)/g;
  let m;
  while ((m = re.exec(fmlText)) !== null) urls.add(m[1]);
  return [...urls];
}

/**
 * Derive the local ConceptMap JSON filename from its canonical URL.
 * URL pattern: `http://hl7.org/fhir/uv/xver/ConceptMap/{id}`
 * File pattern: `codes/ConceptMap-{id}.json`
 *
 * @param {string} url      The canonical ConceptMap URL.
 * @param {string} codesDir Absolute path to the codes directory.
 * @returns {string} Absolute path to the ConceptMap JSON file.
 */
function conceptMapPath(url, codesDir) {
  const id = url.split('/').pop();
  return path.join(codesDir, `ConceptMap-${id}.json`);
}

// ===== createFmlEngine =====================================================

/**
 * Compile a single FML file into a conversion engine. Lowest level.
 *
 * @param {string}  resType  FHIR resource type, e.g. 'Questionnaire'.
 * @param {string}  fromVer  'R2' | 'R3' | 'R4' | 'R4B' | 'R5'.
 * @param {string}  toVer    'R2' | 'R3' | 'R4' | 'R4B' | 'R5'.
 * @param {Object}  [opts]
 * @param {string}  [opts.xverInputRoot]         Path to fhir-cross-version/input.
 * @param {boolean} [opts.strict=false]           Throw on missing maps/codes and
 *                                                disallow R4B->R4 substitution.
 * @param {Function}[opts.onWarning]             `(msg) => void`
 * @param {Function}[opts.onInfo]                `(msg) => void`
 * @param {Function}[opts.onRuleExec]            `({rule, srcVal}) => void`
 * @returns {{metadata: Object, uses: Object[], groups: string[], convert: Function}}
 * @throws {Error} If the FML file is missing, or if strict is set
 *                 and a referenced ConceptMap file is missing or unparseable.
 */
export function createFmlEngine(resType, fromVer, toVer, opts = {}) {
  const xverRoot = opts.xverInputRoot || DEFAULT_XVER_ROOT;
  const codesDir = path.join(xverRoot, 'codes');

  const fmlFile = findFmlFile(resType, fromVer, toVer, xverRoot);
  if (!fmlFile) throw new Error(`FML file not found for ${resType} ${fromVer}->${toVer}`);
  const fmlText = fs.readFileSync(fmlFile, 'utf-8');

  const cmUrls = extractConceptMapUrls(fmlText);
  const conceptMaps = [];
  for (const url of cmUrls) {
    const cmFile = conceptMapPath(url, codesDir);
    if (!fs.existsSync(cmFile)) {
      if (opts.strict) throw new Error(`ConceptMap file not found: ${cmFile} (referenced by ${url})`);
      opts.onWarning?.(`ConceptMap file not found: ${cmFile} (referenced by ${url}); translations using this map will return source codes unchanged`);
      continue;
    }
    try {
      conceptMaps.push(JSON.parse(fs.readFileSync(cmFile, 'utf-8')));
    } catch (e) {
      if (opts.strict) throw e;
      opts.onWarning?.(`Failed to parse ConceptMap ${cmFile}: ${e.message}`);
    }
  }

  return compileFmlXver({
    fmlText, conceptMaps,
    strict: opts.strict ?? false,
    fromVer, toVer,
    srcPolyPaths: loadPolyPaths(fromVer, opts.onWarning),
    tgtPolyPaths: loadPolyPaths(toVer,   opts.onWarning),
    onWarning: opts.onWarning, onInfo: opts.onInfo, onRuleExec: opts.onRuleExec,
  });
}

// ===== createConverter =====================================================

/**
 * Run an array of processor functions over a resource, in order.
 * Each processor receives the resource and must return the (possibly modified) resource.
 *
 * @param {Array<Function>|null|undefined} processors
 * @param {Object} resource
 * @returns {Object} The processed resource.
 */
function runProcessors(processors, resource) {
  if (!processors || processors.length === 0) return resource;
  let current = resource;
  for (const fn of processors) current = fn(current);
  return current;
}

/**
 * Single-hop converter: pre-processors -> FML engine -> post-processors.
 *
 * @param {string} resType
 * @param {string} fromVer
 * @param {string} toVer
 * @param {Object} [opts]
 * @param {Array<Function>} [opts.pre]  Pre-processors: (resource) => resource
 * @param {Array<Function>} [opts.post] Post-processors: (resource) => resource
 */
export function createConverter(resType, fromVer, toVer, opts = {}) {
  const pre  = opts.pre  || [];
  const post = opts.post || [];
  const engine = createFmlEngine(resType, fromVer, toVer, opts);

  return {
    ...engine,
    convert({ input }) {
      let resource = runProcessors(pre, input);
      resource = engine.convert({ input: resource });
      resource = runProcessors(post, resource);
      return resource;
    },
  };
}

// ===== createChainedConverter ==============================================

/** Ordered list of FHIR versions for determining hop chains. */
const VERSION_ORDER = ['R2', 'R3', 'R4', 'R4B', 'R5'];

/**
 * Compute single-hop [from, to] pairs needed to get from `fromVer` to `toVer`.
 *
 * @param {string} fromVer
 * @param {string} toVer
 * @returns {Array<[string, string]>} e.g. [['R3','R4'], ['R4','R5']]
 * @throws {Error} If either version is not in VERSION_ORDER.
 */
function versionHops(fromVer, toVer) {
  const fromIdx = VERSION_ORDER.indexOf(fromVer);
  const toIdx   = VERSION_ORDER.indexOf(toVer);
  if (fromIdx < 0) throw new Error(`Unknown FHIR version: ${fromVer}`);
  if (toIdx < 0)   throw new Error(`Unknown FHIR version: ${toVer}`);
  if (fromIdx === toIdx) return [];

  const step = fromIdx < toIdx ? 1 : -1;
  const hops = [];
  for (let i = fromIdx; i !== toIdx; i += step) hops.push([VERSION_ORDER[i], VERSION_ORDER[i + step]]);
  return hops;
}

/**
 * Multi-hop converter with per-hop processors via processorFactory.
 *
 * @param {string} resType
 * @param {string} fromVer
 * @param {string} toVer
 * @param {Object} [opts]
 * @param {Object} [opts.processorFactory] { getPre(fromVer), getPost(fromVer) }
 */
export function createChainedConverter(resType, fromVer, toVer, opts = {}) {
  if (fromVer === toVer) {
    return { hops: [], convert({ input }) { return input; } };
  }

  const hops = versionHops(fromVer, toVer);
  const xverRoot = opts.xverInputRoot || DEFAULT_XVER_ROOT;
  const factory = opts.processorFactory || null;

  const converters = [];
  for (const [hopFrom, hopTo] of hops) {
    // R4<->R4B: skip this hop entirely (they are treated as equivalent).
    if ((hopFrom === 'R4' && hopTo === 'R4B') || (hopFrom === 'R4B' && hopTo === 'R4')) {
      opts.onWarning?.(`${resType}: R4 and R4B are treated as equivalent; compatibility is not guaranteed for all resource types`);
      continue;
    }

    let actualFrom = hopFrom, actualTo = hopTo;
    if (!findFmlFile(resType, actualFrom, actualTo, xverRoot)) {
      if (opts.strict) {
        throw new Error(`FML file not found for ${resType} ${hopFrom}->${hopTo}`);
      }
      // Non-strict: attempt R4B <-> R4 substitution with a warning.
      if (actualFrom === 'R4B' && findFmlFile(resType, 'R4', actualTo, xverRoot)) actualFrom = 'R4';
      else if (actualTo === 'R4B' && findFmlFile(resType, actualFrom, 'R4', xverRoot)) actualTo = 'R4';
      else throw new Error(`FML file not found for ${resType} ${hopFrom}->${hopTo} (no R4 substitution available)`);
      opts.onWarning?.(`${resType}: No FML for ${hopFrom}->${hopTo}; using ${actualFrom}->${actualTo} as substitute. R4/R4B compatibility is not guaranteed for all resource types.`);
    }

    const pre  = factory?.getPre?.(hopFrom)  || [];
    const post = factory?.getPost?.(hopFrom) || [];
    converters.push(createConverter(resType, actualFrom, actualTo, { ...opts, pre, post }));
  }

  return {
    hops,
    convert({ input }) {
      let current = input;
      for (const c of converters) current = c.convert({ input: current });
      return current;
    },
  };
}
