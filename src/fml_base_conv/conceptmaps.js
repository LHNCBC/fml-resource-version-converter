/**
 * @fileoverview Internal ConceptMap resolution and data-integrity scan.
 *
 * Owns the whole ConceptMap concern in one place:
 *   - Resolution primitives (extractConceptMapUrls, conceptMapPath,
 *     resolveConceptMaps) - used by the engine (create_converter.js buildEngine)
 *     to load the maps a conversion needs.
 *   - A static, per-version-pair scan (scanConceptMaps) - used by the maintainer
 *     data check (tools/check-data.js) and its test to audit a data root.
 *
 * This module is INTERNAL. It is not re-exported by the package barrels
 * (`./` or `./fml-engine`) - it is imported directly by the engine and by the
 * tools that need it. Keeping it separate keeps the engine pure (conversion
 * only) without exposing these details on any public API. (The engine imports
 * the resolution helpers from here; it does not depend on `tools/`, which is why
 * this shared code lives under `src/` rather than in the tool.)
 *
 * @module fml_base_conv/conceptmaps
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Absolute path to the bundled FML cross-version input root (FML files and the
 * ConceptMap folders). The default data root for both the engine factory and
 * the scan tool; callers may override it (e.g. to evaluate a candidate data
 * drop before committing to it).
 * @type {string}
 */
export const DEFAULT_XVER_ROOT =
  path.resolve(import.meta.dirname, '../../data/fhir-cross-version/input');

/**
 * Scan FML text for ConceptMap URLs referenced by `translate(...)` calls.
 * Tolerates both single and double quotes around URL and code-mode args.
 *
 * @param {string} fmlText  The raw FML source text.
 * @returns {string[]} Unique canonical ConceptMap URLs, in declaration order.
 */
export function extractConceptMapUrls(fmlText) {
  const urls = new Set();
  const re = /translate\s*\([^,]+,\s*['"]([^'"]+)['"]\s*,\s*['"][^'"]*['"]\s*\)/g;
  let m;
  while ((m = re.exec(fmlText)) !== null) urls.add(m[1]);
  return [...urls];
}

/**
 * ConceptMap id-prefix -> containing subdirectory.
 *
 * The cross-version package groups ConceptMaps by the vocabulary they translate:
 * the data-type and resource-type name maps live in their own folders under a
 * fixed `types-`/`resources-` id prefix (likewise `elements-`/`search-params-`),
 * while every value-set/terminology map is named after its value set and lives
 * in `codes/`. The id therefore determines the folder with no filesystem probing.
 * @type {Array<[string, string]>}
 */
const CM_SUBDIR_BY_PREFIX = [
  ['types-',         'types'],
  ['resources-',     'resources'],
  ['elements-',      'elements'],
  ['search-params-', 'search-params'],
];

/**
 * Derive the local ConceptMap JSON path from its canonical URL.
 * URL pattern:  `http://hl7.org/fhir/uv/xver/ConceptMap/{id}`
 * File pattern: `{subdir}/ConceptMap-{id}.json`, where the subdirectory is
 * chosen from the id prefix (see CM_SUBDIR_BY_PREFIX); unprefixed ids are
 * value-set maps under `codes/`.
 *
 * @param {string} url      The canonical ConceptMap URL.
 * @param {string} xverRoot Absolute path to the FML input root.
 * @returns {string} Absolute path to the ConceptMap JSON file.
 */
export function conceptMapPath(url, xverRoot) {
  const id = url.split('/').pop();
  const hit = CM_SUBDIR_BY_PREFIX.find(([prefix]) => id.startsWith(prefix));
  const subdir = hit ? hit[1] : 'codes';
  return path.join(xverRoot, subdir, `ConceptMap-${id}.json`);
}

/**
 * Resolve a set of referenced ConceptMap URLs against the data install.
 *
 * Classifies each referenced URL and returns both the loaded maps and the
 * environmental facts (what the install is missing):
 *   - loaded:     standalone ConceptMap file found and parsed (in conceptMaps).
 *   - contained:  a `#`-fragment (contained) ConceptMap; inline in its holder,
 *                 never a standalone file, so it is skipped silently.
 *   - missing:    a standalone ConceptMap file is referenced but absent (id in
 *                 missingConceptMaps).
 *   - parseError: the file exists but is not valid JSON (in parseErrors).
 *
 * This is a static, environmental view: a missing / unparseable map affects a
 * conversion only if a rule actually translates against it, at which point the
 * engine warns at translate time. The maintainer scan surfaces these facts up
 * front; the per-conversion path does not warn about them eagerly.
 *
 * @param {Iterable<string>} cmUrls  Referenced ConceptMap canonical URLs.
 * @param {string} xverRoot          Absolute path to the FML input root.
 * @returns {{conceptMaps: Object[], missingConceptMaps: string[],
 *            parseErrors: Array<{id: string, error: string}>}}
 */
export function resolveConceptMaps(cmUrls, xverRoot) {
  const conceptMaps = [];
  const missingConceptMaps = [];
  const parseErrors = [];
  for (const url of cmUrls) {
    const id = url.split('/').pop();
    // Contained (#-fragment) ConceptMaps live inside their holder resource and
    // are never standalone files; skip them silently (no missing-file fact).
    if (id.startsWith('#')) continue;
    const cmFile = conceptMapPath(url, xverRoot);
    if (!fs.existsSync(cmFile)) {
      missingConceptMaps.push(id);
      continue;
    }
    try {
      conceptMaps.push(JSON.parse(fs.readFileSync(cmFile, 'utf-8')));
    } catch (e) {
      parseErrors.push({ id, error: e.message });
    }
  }
  return { conceptMaps, missingConceptMaps, parseErrors };
}

/**
 * Union of ConceptMap URLs referenced across every FML file in a version-pair
 * directory. Resource-type agnostic: because the wildcard imports pull in all
 * sibling maps, the referenced set is a property of the pair's directory, not
 * any single resource type.
 *
 * Throws rather than swallowing filesystem errors: a missing pair directory or
 * an unreadable FML file under the given root is a real data-integrity problem
 * (a mistyped root, an incomplete install, bad permissions), not "no
 * references". Surfacing it loudly stops the maintainer scan from returning a
 * false clean bill of health.
 *
 * @param {string} fromVer  Canonical source version.
 * @param {string} toVer    Canonical target version.
 * @param {string} xverRoot Absolute path to the FML input root.
 * @returns {Set<string>} Referenced ConceptMap URLs across the pair's FML files.
 * @throws {Error} If the pair directory is missing/unreadable, or an FML file in
 *   it cannot be read.
 */
function collectPairConceptMapUrls(fromVer, toVer, xverRoot) {
  const dir = path.join(xverRoot, `${fromVer}to${toVer}`);
  const urls = new Set();

  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (e) {
    throw new Error(
      `Cannot read ConceptMap directory ${dir} for ${fromVer}->${toVer}: ${e.message}`,
    );
  }

  for (const entry of entries) {
    if (!entry.endsWith('.fml')) continue;
    // Let an unreadable FML file throw (Node includes the path) rather than
    // silently skipping it, which would hide the ConceptMaps it references.
    const text = fs.readFileSync(path.join(dir, entry), 'utf-8');
    for (const url of extractConceptMapUrls(text)) urls.add(url);
  }
  return urls;
}

/**
 * Statically audit the standalone ConceptMaps a version pair references against
 * a data root. Environmental and resource-type agnostic (see
 * collectPairConceptMapUrls). Returns the facts; the caller decides how to
 * report them or whether to treat them as failures.
 *
 * Used by the maintainer data check (tools/check-data.js); not part of the
 * conversion path.
 *
 * @param {string} fromVer  Canonical source version.
 * @param {string} toVer    Canonical target version.
 * @param {string} [xverRoot=DEFAULT_XVER_ROOT] Data root to check; override to
 *        evaluate a candidate data drop before committing to it.
 * @returns {{missingConceptMaps: string[], parseErrors: Array<{id: string, error: string}>}}
 * @throws {Error} If the pair directory or an FML file cannot be read (a missing
 *   or unreadable data root surfaces here rather than as a false clean result).
 */
export function scanConceptMaps(fromVer, toVer, xverRoot = DEFAULT_XVER_ROOT) {
  const urls = collectPairConceptMapUrls(fromVer, toVer, xverRoot);
  const { missingConceptMaps, parseErrors } = resolveConceptMaps(urls, xverRoot);
  return { missingConceptMaps, parseErrors };
}



