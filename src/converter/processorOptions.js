/**
 * @fileoverview Processor-option normalization for the conversion entry points.
 *
 * The public converters accept several convenient shapes for supplying pre- and
 * post-processors (see the processor-spec model). This module normalizes all of
 * them, at the API boundary, into ONE canonical internal form: two caller
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
 *   - preLookup(type, v1, v2)  -> Array<preDescriptor> | undefined
 *   - postLookup(type, v1, v2) -> { policy, processors: Array<postDescriptor> } | undefined
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
 * Return whether [v1, v2] is one of the planned hops.
 *
 * @param {string} v1 Source version.
 * @param {string} v2 Target version.
 * @param {Array<[string, string]>} hops Planned hops.
 * @returns {boolean} True when the pair is a planned hop.
 */
function hopInPlan(v1, v2, hops) {
  return hops.some(([from, to]) => from === v1 && to === v2);
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
 * Build a keyed lookup from a caller map whose keys are already canonical.
 *
 * Each key is parsed and hop-validated; the entry is normalized and stored under
 * the canonical (type, v1, v2) key. Type-only single-hop keys are canonicalized
 * upstream by the single-hop entry point (see resolveSingleHopOptionKeys), so
 * this deals only with canonical keys.
 *
 * @param {Object} map Canonical caller map (keys: "resType:v1->v2").
 * @param {Object} args
 * @param {Array<[string, string]>} args.hops Planned hops (for key validation).
 * @param {Function} args.normalizeEntry Entry normalizer (normalizePRPE/normalizePSPE).
 * @param {string} args.label Human-readable label for errors.
 * @returns {Function} A `(type, v1, v2) -> normalizedEntry | undefined` lookup.
 * @throws {Error} If a key is malformed or names a pair that is not a planned hop.
 */
function buildLookupFromUserMap(map, { hops, normalizeEntry, label }) {
  const store = new Map();
  for (const [key, rawEntry] of Object.entries(map)) {
    const { type, v1, v2 } = parseLookupKey(key);
    if (!hopInPlan(v1, v2, hops)) {
      const plan = hops.map(([f, t]) => `${f}->${t}`).join(', ');
      throw new Error(`${label}: key "${key}" is not a hop in this conversion (hops: ${plan})`);
    }
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
 * side's boundary hop (first for pre, last for post). A singular entry matches
 * the primary type at that boundary hop; a plural function or map is delegated to
 * buildLookupFromUserFn / buildLookupFromUserMap. Singular and plural are
 * mutually exclusive on a side.
 *
 * @param {Object} opts Conversion options.
 * @param {*} [opts.preproc]   PRP: a PRPE for the first-hop primary pre.
 * @param {*} [opts.preprocs]  PRPs: a keyed map or lookup for pre.
 * @param {*} [opts.postproc]  PSP: a PSPE for the last-hop primary post.
 * @param {*} [opts.postprocs] PSPs: a keyed map or lookup for post.
 * @param {Object} ctx
 * @param {Array<[string, string]>} ctx.hops Planned hops (>= 1).
 * @param {string} ctx.primaryType The input resource's type.
 * @returns {{preLookup: Function, postLookup: Function}} Canonical lookups, each
 *   `(type, v1, v2) -> normalizedEntry | undefined`.
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
      return (type, v1, v2) =>
        (type === primaryType && v1 === fromVer && v2 === toVer) ? entry : undefined;
    }
    if (typeof plural === 'function') {
      return buildLookupFromUserFn(plural, { normalizeEntry: normalize, label: `${kind}procs` });
    }
    if (isPlainObject(plural)) {
      return buildLookupFromUserMap(plural, { hops, normalizeEntry: normalize, label: `${kind}procs` });
    }
    if (plural != null) throw new Error(`${kind}procs must be a map or a lookup function`);
    return NONE;
  };

  return {
    preLookup:  build('pre',  ...hops[0]),
    postLookup: build('post', ...hops.at(-1)),
  };
}
