/**
 * @fileoverview Factory function to create an FML cross-version conversion
 * engine for a given FHIR resource type and version pair.
 *
 * Locates the FML file and required ConceptMap files from the
 * fhir-cross-version/input/ directory and compiles them into a ready-to-use
 * engine via compileFmlXver().
 *
 * Directory layout this expects:
 *
 *   fhir-cross-version/input/
 *     +-- R4toR5/
 *     |     +-- Questionnaire4to5.fml      (versioned filename preferred)
 *     |     +-- Patient.fml                (plain filename as fallback)
 *     |     +-- ...
 *     +-- R5toR4/
 *     |     +-- ...
 *     +-- codes/
 *           +-- ConceptMap-resource-status-4to5.json
 *           +-- ...
 *
 * Usage:
 *   import { createEngine, createFmlEngine } from './create_engine.js';
 *
 *   // High-level: handles chaining across multiple versions
 *   const engine = createEngine('Questionnaire', 'R4', 'R5', {
 *     onWarning: msg => console.warn(msg),
 *     onInfo:    msg => console.log(msg),
 *   });
 *   const r5 = engine.convert({ input: r4Questionnaire });
 *
 *   // Low-level: compiles a single FML file (one version hop)
 *   const fmlEngine = createFmlEngine('Questionnaire', 'R4', 'R5');
 *   const r5b = fmlEngine.convert({ input: r4Questionnaire });
 *
 *   // Or with a custom xver input directory:
 *   const engine2 = createEngine('Patient', 'R4', 'R5', {
 *     xverInputRoot: '/path/to/fhir-cross-version/input',
 *   });
 *
 * @module fml_base_conv/create_engine
 */
import fs from 'node:fs';
import path from 'node:path';
import { compileFmlXver } from './fml_xver_engine.js';

const __dirname = import.meta.dirname;
const DEFAULT_XVER_ROOT = path.resolve(__dirname, '../../fhir-cross-version/input');

/**
 * Version label -> filename suffix used in versioned FML filenames.
 * e.g. R4 -> '4', R4B -> '4B', composed as `Questionnaire4to5.fml`.
 */
const VER_SUFFIX = { R2: '2', R3: '3', R4: '4', R4B: '4B', R5: '5' };

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
 *
 * The FML syntax for translation is:
 *   `translate(srcVar, '<conceptMapUrl>', 'code')`
 *
 * Tolerates both single and double quotes around URL and code-mode args.
 *
 * @param {string} fmlText
 * @returns {string[]} Unique canonical ConceptMap URLs, declaration order.
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
 * @param {string} url
 * @param {string} codesDir Absolute path to the codes directory.
 * @returns {string} Absolute path to the ConceptMap JSON file.
 */
function conceptMapPath(url, codesDir) {
  const id = url.split('/').pop();
  return path.join(codesDir, `ConceptMap-${id}.json`);
}

/**
 * Create a compiled FML conversion engine for the given resource type and
 * version pair. The returned engine exposes:
 *   - `metadata` - FML `///` metadata as an object
 *   - `uses`     - `uses` declarations
 *   - `groups`   - list of group names defined in the FML
 *   - `convert({ input, entryGroup? })` - the converter function
 *
 * Missing ConceptMap files emit a warning by default; pass
 * `strictTranslate: true` to throw instead.
 *
 * @param {string}  resType  FHIR resource type, e.g. 'Questionnaire'.
 * @param {string}  fromVer  'R2' | 'R3' | 'R4' | 'R4B' | 'R5'.
 * @param {string}  toVer    'R2' | 'R3' | 'R4' | 'R4B' | 'R5'.
 * @param {Object}  [opts]
 * @param {string}  [opts.xverInputRoot]         Path to the fhir-cross-version
 *                                               input directory. Defaults to
 *                                               the bundled fhir-cross-version/input/.
 * @param {boolean} [opts.strictTranslate=false] Throw on missing maps / codes.
 * @param {Function}[opts.onWarning]             `(msg) => void`
 * @param {Function}[opts.onInfo]                `(msg) => void`
 * @param {Function}[opts.onRuleExec]            `({rule, srcVal}) => void`
 * @returns {{metadata: Object, uses: Object[], groups: string[], convert: Function}}
 * @throws {Error} If the FML file is missing, or if `strictTranslate` is set
 *                 and a referenced ConceptMap file is missing or unparseable.
 */
export function createFmlEngine(resType, fromVer, toVer, opts = {}) {
  const xverRoot = opts.xverInputRoot || DEFAULT_XVER_ROOT;
  const codesDir = path.join(xverRoot, 'codes');

  // 1. Locate and read the FML file.
  const fmlFile = findFmlFile(resType, fromVer, toVer, xverRoot);
  if (!fmlFile) {
    throw new Error(`FML file not found for ${resType} ${fromVer}→${toVer}`);
  }
  const fmlText = fs.readFileSync(fmlFile, 'utf-8');

  // 2. Discover and load every ConceptMap referenced by translate() calls.
  const cmUrls = extractConceptMapUrls(fmlText);
  const conceptMaps = [];
  for (const url of cmUrls) {
    const cmFile = conceptMapPath(url, codesDir);
    if (!fs.existsSync(cmFile)) {
      if (opts.strictTranslate) {
        throw new Error(`ConceptMap file not found: ${cmFile} (referenced by ${url})`);
      }
      opts.onWarning?.(`ConceptMap file not found: ${cmFile} (referenced by ${url}); translations using this map will return source codes unchanged`);
      continue;
    }
    try {
      conceptMaps.push(JSON.parse(fs.readFileSync(cmFile, 'utf-8')));
    } catch (e) {
      if (opts.strictTranslate) throw e;
      opts.onWarning?.(`Failed to parse ConceptMap ${cmFile}: ${e.message}`);
    }
  }

  // 3. Compile. Forward known options explicitly to avoid leaking unknown
  //    keys through to the engine via a `...opts` spread.
  return compileFmlXver({
    fmlText,
    conceptMaps,
    strictTranslate: opts.strictTranslate ?? false,
    fromVer,
    toVer,
    onWarning:       opts.onWarning,
    onInfo:          opts.onInfo,
    onRuleExec:      opts.onRuleExec,
  });
}

// ----- Chained (multi-hop) engine -----------------------------------------

/**
 * Ordered list of FHIR versions for determining hop chains.
 * R4B is included; when no direct FML file exists for an R4B hop,
 * R4 is used as a substitute (with a warning).
 */
const VERSION_ORDER = ['R2', 'R3', 'R4', 'R4B', 'R5'];

/**
 * Compute the list of single-hop [from, to] pairs needed to get from
 * `fromVer` to `toVer`.
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
  for (let i = fromIdx; i !== toIdx; i += step) {
    hops.push([VERSION_ORDER[i], VERSION_ORDER[i + step]]);
  }
  return hops;
}

/**
 * Create a (possibly chained) conversion engine for the given resource type
 * and version pair. If fromVer and toVer are adjacent, this behaves the same
 * as `createEngine`. If they are non-adjacent (e.g. R3 to R5), it chains
 * multiple single-hop engines.
 *
 * R4B handling: if no FML file exists for an R4B hop, it substitutes R4 and
 * emits a warning that R4/R4B compatibility is not guaranteed for all
 * resource types.
 *
 * Usage:
 *   import { createEngine } from './create_engine.js';
 *
 *   const engine = createEngine('Questionnaire', 'R3', 'R5', {
 *     onWarning: msg => console.warn(msg),
 *   });
 *   const r5 = engine.convert({ input: r3Questionnaire });
 *
 * @param {string}  resType  FHIR resource type, e.g. 'Questionnaire'.
 * @param {string}  fromVer  'R2' | 'R3' | 'R4' | 'R4B' | 'R5'.
 * @param {string}  toVer    'R2' | 'R3' | 'R4' | 'R4B' | 'R5'.
 * @param {Object}  [opts]   Same options as createEngine.
 * @returns {{convert: Function, hops: Array<[string,string]>}}
 * @throws {Error} If any hop's FML file is missing and cannot be substituted.
 */
export function createEngine(resType, fromVer, toVer, opts = {}) {
  if (fromVer === toVer) {
    return {
      hops: [],
      convert({ input }) { return input; },
    };
  }

  const hops = versionHops(fromVer, toVer);
  const xverRoot = opts.xverInputRoot || DEFAULT_XVER_ROOT;

  // Build a single-hop engine for each pair, substituting R4B↔R4 when needed.
  const engines = [];
  for (const [hopFrom, hopTo] of hops) {
    let effectiveFrom = hopFrom;
    let effectiveTo   = hopTo;

    // Check if this hop can be skipped (R4↔R4B: same resource, only profile differs).
    if ((hopFrom === 'R4' && hopTo === 'R4B') || (hopFrom === 'R4B' && hopTo === 'R4')) {
      // No FML file needed; just a profile change. The engine's meta.profile
      // logic handles this. Push a no-op engine.
      engines.push({
        convert({ input }) {
          return JSON.parse(JSON.stringify(input));
        },
        _noop: true,
      });
      opts.onWarning?.(`${resType}: R4 and R4B are treated as equivalent; compatibility is not guaranteed for all resource types`);
      continue;
    }

    // Try to create engine for this hop; if no FML exists for R4B, substitute R4.
    let actualFrom = effectiveFrom;
    let actualTo   = effectiveTo;

    if (!findFmlFile(resType, actualFrom, actualTo, xverRoot)) {
      // Attempt R4B → R4 substitution
      if (actualFrom === 'R4B' && findFmlFile(resType, 'R4', actualTo, xverRoot)) {
        actualFrom = 'R4';
      } else if (actualTo === 'R4B' && findFmlFile(resType, actualFrom, 'R4', xverRoot)) {
        actualTo = 'R4';
      } else {
        throw new Error(`FML file not found for ${resType} ${effectiveFrom}→${effectiveTo} (no R4 substitution available)`);
      }
      opts.onWarning?.(`${resType}: No FML for ${effectiveFrom}→${effectiveTo}; using ${actualFrom}→${actualTo} as substitute. R4/R4B compatibility is not guaranteed for all resource types.`);
    }

    engines.push(createFmlEngine(resType, actualFrom, actualTo, opts));
  }

  return {
    hops,
    convert({ input }) {
      let current = input;
      for (const engine of engines) {
        current = engine.convert({ input: current });
      }
      return current;
    },
  };
}

