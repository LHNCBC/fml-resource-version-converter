/**
 * @fileoverview Processor-option normalization for the conversion entry points.
 *
 * The public converters accept several convenient shapes for supplying pre- and
 * post-processors (see the processor-spec model). This module normalizes them,
 * at the API boundary, into canonical primary-resource and contained-resource
 * lookups keyed uniformly by (type, v1, v2). The hop runner and chain loop then
 * only ever deal with a single processor-spec shape.
 *
 * Option surface (per side, pre and post):
 *   - Singular (outer boundary):
 *       preproc  (PRP)  - a PRPE applied to the first hop (primary type).
 *       postproc (PSP)  - a PSPE applied to the last hop (primary type).
 *   - Plural (keyed, map or lookup):
 *       preprocs  (PRPs) - keyed by canonical "resType:v1->v2".
 *       postprocs (PSPs) - same keying.
 *   Singular and plural are mutually exclusive on a given side.
 *
 * This module is single-/multi-hop agnostic: it always expects canonical
 * "resType:v1->v2" map keys and calls caller lookup functions as (type, v1, v2).
 * The single-hop entry point may accept type-only keys as a convenience and
 * canonicalizes them via resolveSingleHopOptionKeys before calling this module.
 *
 * Entry shapes:
 *   - PRPE: an ARRAY of preprocessor descriptors OR functions.
 *   - PSPE: `{ policy, psps: <list> }` OR a bare `<list>` (default policy
 *     'append'). The list is all descriptors OR all functions.
 *   - A "function" is an execute function; it is wrapped into a descriptor with a
 *     generated name (and, for post, neutral coverage).
 *
 * Normalized output:
 *   - preLookup/postLookup for the primary resource.
 *   - containedPreLookup/containedPostLookup for contained resources.
 * Singular options appear only in the primary lookups. Plural keyed options
 * appear in both and may include unused direct hops/resource types so callers
 * can reuse a full map across dynamic conversions.
 *   `undefined` means "no caller entry" (registry defaults apply); it is distinct
 *   from a PSPE entry with an empty list, where a policy of "replace" would disable
 *   the system/package supplied postprocessors as well (if any).
 *
 * @module converter/processorOptions
 */
import {
  makeProcessor,
  validateProcessorDescriptor,
} from './processorDescriptor.js';
import {
  POSTPROCESS_POLICY,
  assertPostprocessPolicy,
} from './postprocessPolicy.js';
import { COVERAGE } from './coverage.js';
import { planHops } from '../fml_base_conv/version_graph.js';

/** A caller lookup that never matches (no processors supplied for a side). */
const NONE = () => undefined;

/**
 * Return whether a value is a plain (non-array) object.
 *
 * @param {*} value Value to test.
 * @returns {boolean} True when value is a non-null, non-array object.
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Wrap a bare processor function into a validated descriptor.
 *
 * Anonymous functions get a generated name so reports never show a blank name.
 * Postprocessors default to neutral coverage; preprocessors carry no coverage.
 *
 * @param {Function} fn    The execute function `(resource, ctx) -> result`.
 * @param {number}   index Position in its list (for the generated name).
 * @param {'preproc'|'postproc'} kind Which side this processor is for.
 * @returns {Object} A validated descriptor.
 */
function wrapProcessorFunction(fn, index, kind) {
  const name = fn.name || `caller-${kind}-${index}`;
  if (kind === 'postproc') {
    return makeProcessor(fn, { name, coverage: COVERAGE.NEUTRAL });
  }
  // Preprocessor: no coverage (not applicable).
  return validateProcessorDescriptor(
    { name, description: 'Caller-provided processor.', execute: fn },
    { allowCoverage: false, label: `${kind}[${index}]` },
  );
}

/**
 * Normalize a processor list (all functions OR all descriptors) into validated
 * descriptors. Mixing functions and descriptors in one list is rejected.
 *
 * @param {Array<Object|Function>} list  The processor list.
 * @param {'preproc'|'postproc'}   kind  Which side this list is for.
 * @param {string}                 label Human-readable label for errors.
 * @returns {Array<Object>} Validated descriptors.
 * @throws {Error} If the list is not an array, mixes shapes, or holds an invalid
 *   entry.
 */
function normalizeProcessorList(list, kind, label) {
  if (!Array.isArray(list)) throw new Error(`${label} must be an array`);

  const hasFunction = list.some(entry => typeof entry === 'function');
  const hasObject = list.some(entry => isPlainObject(entry));
  if (hasFunction && hasObject) {
    throw new Error(`${label} must be all functions or all descriptors, not a mix`);
  }

  const allowCoverage = kind === 'postproc';
  return list.map((entry, index) => {
    if (typeof entry === 'function') return wrapProcessorFunction(entry, index, kind);
    return validateProcessorDescriptor(entry, { allowCoverage, label: `${label}[${index}]` });
  });
}

/**
 * Normalize a PRPE (Pre Processor Entry): always an array, no policy.
 *
 * @param {Array<Object|Function>} entry The PRPE.
 * @param {string} label Human-readable label for errors.
 * @returns {Array<Object>} Validated preprocessor descriptors.
 * @throws {Error} If entry is not an array (PRPE has no single-entry sugar).
 */
function normalizePRPE(entry, label) {
  if (!Array.isArray(entry)) {
    throw new Error(`${label} (PRPE) must be an array of preprocessor descriptors or functions`);
  }
  return normalizeProcessorList(entry, 'preproc', label);
}

/**
 * Normalize a PSPE (Post Processor Entry): `{ policy, psps }` or a bare list.
 *
 * @param {Object|Array} entry The PSPE.
 * @param {string} label Human-readable label for errors.
 * @returns {{policy: string, processors: Array<Object>}} Normalized post entry.
 * @throws {Error} If entry is neither a list nor a `{ policy, psps }` object, or
 *   holds an invalid policy/list.
 */
function normalizePSPE(entry, label) {
  let policy = POSTPROCESS_POLICY.APPEND;
  let list;

  if (Array.isArray(entry)) {
    list = entry;
  } else if (isPlainObject(entry) && ('policy' in entry || 'psps' in entry)) {
    policy = entry.policy ?? POSTPROCESS_POLICY.APPEND;
    assertPostprocessPolicy(policy, `${label}.policy`);
    list = entry.psps;
    if (!Array.isArray(list)) throw new Error(`${label}.psps must be an array`);
  } else {
    throw new Error(`${label} (PSPE) must be a list or a { policy, psps } object`);
  }

  return { policy, processors: normalizeProcessorList(list, 'postproc', label) };
}

/**
 * Parse a canonical lookup key "resType:v1->v2" back into its parts.
 *
 * Inverse of createLookupKey. Caller map keys reach this module already in
 * canonical form; the single-hop entry point canonicalizes any type-only keys
 * upstream (see resolveSingleHopOptionKeys), so this module never sees them.
 *
 * @param {string} key The key.
 * @returns {{type: string, v1: string, v2: string}} Parsed parts.
 * @throws {Error} If the key is malformed.
 */
function parseLookupKey(key) {
  const colon = key.indexOf(':');
  if (colon <= 0) throw new Error(`Invalid processor key "${key}" (expected "Type:v1->v2")`);
  const type = key.slice(0, colon);
  const hop = key.slice(colon + 1);
  const arrow = hop.indexOf('->');
  if (arrow <= 0) throw new Error(`Invalid processor key "${key}" (expected "Type:v1->v2")`);
  return { type, v1: hop.slice(0, arrow), v2: hop.slice(arrow + 2) };
}

/**
 * Build the canonical internal lookup key for a (type, v1, v2) tuple.
 *
 * The internal key is ALWAYS the full 3-tuple form (single-hop keys are resolved
 * to it on ingestion, filling the versions from the one planned hop). Inverse of
 * parseLookupKey.
 *
 * @param {string} type Resource type.
 * @param {string} v1 Source version.
 * @param {string} v2 Target version.
 * @returns {string} The canonical key, e.g. "Questionnaire:R4->R5".
 */
function createLookupKey(type, v1, v2) {
  return `${type}:${v1}->${v2}`;
}

/**
 * Canonicalize the keys of a single-hop caller's keyed processor options.
 *
 * A single-hop caller may key a preprocs/postprocs MAP by resource type only
 * ("Questionnaire") instead of the canonical "Questionnaire:R4->R5"; this fills
 * in the one hop's versions so the shared normalizer (which requires canonical
 * keys) treats single- and multi-hop uniformly. Already-canonical keys, function
 * (non-map) values, and the singular preproc/postproc options are left untouched.
 * If a map contains both forms for the same resource and hop, entries are
 * processed in property iteration order and the later entry replaces the
 * earlier one; their processor lists are not merged, just as if you specify
 * two entries with the same key.
 *
 * Called by the single-hop entry point before normalizeProcessorOptions; the
 * multi-hop entry point does not use it (it requires canonical keys).
 *
 * @param {Object} opts Caller conversion options.
 * @param {[string, string]} hop The single hop [v1, v2].
 * @returns {Object} A shallow copy of opts with map keys canonicalized.
 */
export function resolveSingleHopOptionKeys(opts = {}, [v1, v2]) {
  const out = { ...opts };
  for (const field of ['preprocs', 'postprocs']) {
    const value = opts[field];
    if (isPlainObject(value)) {
      const canon = {};
      for (const [key, entry] of Object.entries(value)) {
        canon[key.includes(':') ? key : createLookupKey(key, v1, v2)] = entry;
      }
      out[field] = canon;
    }
  }
  return out;
}

/**
 * Assert that a processor key names one supported direct conversion hop.
 *
 * Processor maps are reusable across conversion invocations, so a valid direct
 * hop does not need to occur in the current request. Non-adjacent and otherwise
 * unsupported pairs can never be selected by the per-hop runtime and are
 * rejected as configuration errors.
 *
 * @param {string} key Original processor-map key (for diagnostics).
 * @param {string} v1 Source version from the key.
 * @param {string} v2 Target version from the key.
 * @param {string} label Option label (`preprocs` or `postprocs`).
 * @throws {Error} If the versions do not name one supported direct hop.
 */
function assertDirectHopKey(key, v1, v2, label) {
  let planned;
  try {
    planned = planHops(v1, v2);
  } catch (error) {
    throw new Error(`${label}: key "${key}" does not name a supported direct hop: ${error.message}`);
  }

  if (planned.length !== 1 || planned[0][0] !== v1 || planned[0][1] !== v2) {
    throw new Error(`${label}: key "${key}" must name one supported direct hop`);
  }
}

/**
 * Build a keyed lookup from a caller map whose keys are already canonical.
 *
 * Each key is parsed and validated as a generally supported direct hop; the
 * entry is normalized and stored under the canonical (type, v1, v2) key.
 * Entries for resource types or hops absent from the current invocation remain
 * unused. This permits one map to be reused across dynamic conversions and
 * across parents with different contained-resource types.
 *
 * @param {Object} map Canonical caller map (keys: "resType:v1->v2").
 * @param {Object} args
 * @param {Function} args.normalizeEntry Entry normalizer (normalizePRPE/normalizePSPE).
 * @param {string} args.label Human-readable label for errors.
 * @returns {Function} A `(type, v1, v2) -> normalizedEntry | undefined` lookup.
 * @throws {Error} If a key is malformed or does not name a supported direct hop.
 */
function buildLookupFromUserMap(map, { normalizeEntry, label }) {
  const store = new Map();
  for (const [key, rawEntry] of Object.entries(map)) {
    const { type, v1, v2 } = parseLookupKey(key);
    assertDirectHopKey(key, v1, v2, label);
    store.set(createLookupKey(type, v1, v2), normalizeEntry(rawEntry, `${label}["${key}"]`));
  }

  return (type, v1, v2) => store.get(createLookupKey(type, v1, v2));
}

/**
 * Build a keyed lookup from a caller lookup function.
 *
 * The caller function is called as (type, v1, v2), lazily during the hop loop;
 * its returned entry (if any) is normalized per call.
 *
 * @param {Function} fn Caller lookup `(type, v1, v2) -> entry | undefined`.
 * @param {Object} args
 * @param {Function} args.normalizeEntry Entry normalizer (normalizePRPE/normalizePSPE).
 * @param {string} args.label Human-readable label for errors.
 * @returns {Function} A `(type, v1, v2) -> normalizedEntry | undefined` lookup.
 */
function buildLookupFromUserFn(fn, { normalizeEntry, label }) {
  return (type, v1, v2) => {
    const raw = fn(type, v1, v2);
    return raw == null ? undefined : normalizeEntry(raw, `${label}(...)`);
  };
}

/**
 * Normalize the processor options into canonical caller lookups.
 *
 * A local `build(kind, fromVer, toVer)` resolves one side: `kind` ('pre'|'post')
 * reconstructs the option field names and labels, `(fromVer, toVer)` is that
 * side's boundary hop (first for pre, last for post). A singular preprocessor
 * applies to the primary type at the first hop. A singular postprocessor applies
 * to the last hop even if an earlier hop may have renamed the resource type.
 * A plural function or map is delegated to buildLookupFromUserFn /
 * buildLookupFromUserMap. Singular and plural are mutually exclusive on a side.
 *
 * @param {Object} opts Conversion options.
 * @param {*} [opts.preproc]   PRP: a PRPE for the first-hop primary pre.
 * @param {*} [opts.preprocs]  PRPs: a keyed map or lookup for pre.
 * @param {*} [opts.postproc]  PSP: a PSPE for the last-hop primary post.
 * @param {*} [opts.postprocs] PSPs: a keyed map or lookup for post.
 * @param {Object} ctx
 * @param {Array<[string, string]>} ctx.hops Planned hops (>= 1).
 * @param {string} ctx.primaryType The input resource's type.
 * @returns {{preLookup: Function, postLookup: Function,
 *   containedPreLookup: Function, containedPostLookup: Function}} Canonical
 *   lookups for the primary resource and contained resources. Singular options
 *   appear only in the primary lookups; plural keyed options are shared by both.
 * @throws {Error} On conflicting/invalid options.
 */
export function normalizeProcessorOptions(opts = {}, ctx) {
  const { hops, primaryType } = ctx;

  // Build one side's lookup. `kind` ('pre'|'post') reconstructs the option field
  // names and labels; (fromVer, toVer) is this side's boundary hop.
  const build = (kind, fromVer, toVer) => {
    const singular = opts[`${kind}proc`];
    const plural = opts[`${kind}procs`];
    const normalize = kind === 'pre' ? normalizePRPE : normalizePSPE;

    if (singular != null && plural != null) {
      throw new Error(`${kind}proc and ${kind}procs are mutually exclusive`);
    }
    if (singular != null) {
      const entry = normalize(singular, `${kind}proc`);
      const primaryLookup = (type, v1, v2) => {
        const typeMatches = kind === 'post' || type === primaryType;
        return typeMatches && v1 === fromVer && v2 === toVer ? entry : undefined;
      };
      return { primaryLookup, containedLookup: NONE };
    }
    if (typeof plural === 'function') {
      const lookup = buildLookupFromUserFn(
        plural,
        { normalizeEntry: normalize, label: `${kind}procs` },
      );
      return { primaryLookup: lookup, containedLookup: lookup };
    }
    if (isPlainObject(plural)) {
      const lookup = buildLookupFromUserMap(
        plural,
        { normalizeEntry: normalize, label: `${kind}procs` },
      );
      return { primaryLookup: lookup, containedLookup: lookup };
    }
    if (plural != null) throw new Error(`${kind}procs must be a map or a lookup function`);
    return { primaryLookup: NONE, containedLookup: NONE };
  };

  const pre = build('pre', ...hops[0]);
  const post = build('post', ...hops.at(-1));

  return {
    preLookup: pre.primaryLookup,
    postLookup: post.primaryLookup,
    containedPreLookup: pre.containedLookup,
    containedPostLookup: post.containedLookup,
  };
}
