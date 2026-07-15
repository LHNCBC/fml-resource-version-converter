/**
 * @fileoverview Top-level postprocessor registry.
 *
 * Aggregates the per-direction sub-registries into one consolidated table and
 * exposes createRegistry(engineFactory) -> { lookup }. The registry maps a
 * conversion tuple to a registry entry describing the FML mapping's coverage and
 * any package postprocessors for that resource type on that hop.
 *
 * Entry shape:
 *   {
 *     fml: {
 *       coverage:     'not_reviewed' | 'partial' | 'complete',  // default not_reviewed
 *       description?: string,       // optional note on the FML coverage
 *     },
 *     processors:     Array<Object>, // postprocessor descriptors, possibly empty
 *   }
 *
 * The final cumulative coverage for a conversion (FML stage rolled up with the
 * postprocessors) is not stored on the entry - it is derived. It is generated
 * into COVERAGE.md from fml.coverage and each processor's coverage.
 *
 * Loading strategy: the sub-registries are imported statically (one file per
 * direction, always present as at least an empty placeholder). This keeps the
 * module synchronous - no top-level await, no runtime filesystem scan - so it
 * stays require()-compatible. The direction files exist for the closed set of
 * FML version pairs (see getAdjacentPairs); a new pair is only added at a major
 * release, which is the only time this import list changes. Adding resource
 * types to an existing pair edits that pair's sub-registry, never this file.
 *
 * Validity gate: a registry instance is created with an engine factory (see
 * createRegistry), and lookup() uses that factory's hasMapping as the single
 * source of truth for whether a (resourceType, fromVer, toVer) tuple is
 * convertible at all. An invalid version pair or unknown resource type throws;
 * a valid-but-unreviewed tuple resolves to the functional default entry. This
 * ensures lookup() never returns a misleading "not reviewed" for a tuple that
 * cannot be converted. The consolidated postprocessor tables are root-
 * independent and built once at module load; only validity uses the factory.
 *
 * See the design documents ("The postprocessor registry") for the authoritative design.
 *
 * @module postprocessors/registry
 */
import { COVERAGE, isCoverageLevel } from '../converter/coverage.js';
import { validateProcessorDescriptor } from '../converter/processorDescriptor.js';

import { registry as R2_TO_R3 } from './R2_R3/registry_R2_to_R3.js';
import { registry as R3_TO_R2 } from './R2_R3/registry_R3_to_R2.js';
import { registry as R3_TO_R4 } from './R3_R4/registry_R3_to_R4.js';
import { registry as R4_TO_R3 } from './R3_R4/registry_R4_to_R3.js';
import { registry as R4_TO_R5 } from './R4_R5/registry_R4_to_R5.js';
import { registry as R5_TO_R4 } from './R4_R5/registry_R5_to_R4.js';
import { registry as R4B_TO_R5 } from './R4B_R5/registry_R4B_to_R5.js';
import { registry as R5_TO_R4B } from './R4B_R5/registry_R5_to_R4B.js';

/**
 * Direction key -> raw sub-registry map. The key set is the closed list of
 * directed adjacent pairs; a consistency test checks it against
 * getAdjacentPairs() so a missing stub for a new pair fails loudly.
 * @type {Object<string, Object>}
 */
const DIRECTION_REGISTRIES = {
  'R2->R3':  R2_TO_R3,
  'R3->R2':  R3_TO_R2,
  'R3->R4':  R3_TO_R4,
  'R4->R3':  R4_TO_R3,
  'R4->R5':  R4_TO_R5,
  'R5->R4':  R5_TO_R4,
  'R4B->R5': R4B_TO_R5,
  'R5->R4B': R5_TO_R4B,
};

/**
 * Build a direction key from a version pair.
 *
 * @param {string} fromVer Source version.
 * @param {string} toVer   Target version.
 * @returns {string} e.g. 'R4->R5'.
 */
function directionKey(fromVer, toVer) {
  return `${fromVer}->${toVer}`;
}

/**
 * Build the functional default registry entry used on a lookup miss.
 *
 * A fresh object is returned on every call so callers may freely mutate the
 * entry (e.g. append processors) without affecting later lookups.
 *
 * @returns {{fml: {coverage: string}, processors: Array<Object>}} Default entry.
 */
function defaultEntry() {
  return { fml: { coverage: COVERAGE.NOT_REVIEWED }, processors: [] };
}

/**
 * Normalize and validate an entry's `fml` stage object.
 *
 * A missing fml object or coverage falls through to the default; an unknown
 * coverage level throws (fail-fast). The optional `description` is passed
 * through untouched.
 *
 * @param {Object|null|undefined} rawFml Raw fml object from a sub-registry entry.
 * @param {string} label Human-readable label for error messages.
 * @returns {{coverage: string, description?: string}} Normalized fml object.
 * @throws {Error} If fml.coverage is an unknown level.
 */
function normalizeFml(rawFml, label) {
  const fml = { ...(rawFml || {}) };
  fml.coverage ??= COVERAGE.NOT_REVIEWED;   // coerce missing/null/undefined -> default
  if (!isCoverageLevel(fml.coverage)) {
    throw new Error(`registry: invalid fml.coverage for ${label}: ${fml.coverage}`);
  }
  return fml;
}

/**
 * Normalize a raw sub-registry entry over the defaults and validate it.
 * Called once per entry at module load, so a malformed entry fails fast.
 *
 * A missing field falls through to the default; an explicit null/undefined is
 * coerced to the default too (object spread copies an explicit undefined, so we
 * cannot rely on the spread alone). Genuinely wrong values (e.g. a non-array
 * processors or an unknown coverage level) still throw.
 *
 * @param {Object} raw   Raw entry from a sub-registry.
 * @param {string} label Human-readable label for error messages.
 * @returns {{fml: {coverage: string}, processors: Array<Object>}} Normalized entry.
 * @throws {Error} If fml.coverage or processors are malformed.
 */
function normalizeEntry(raw, label) {
  const entry = { ...defaultEntry(), ...raw };
  entry.fml = normalizeFml(entry.fml, label);
  entry.processors ??= [];                       // coerce null/undefined -> default

  if (!Array.isArray(entry.processors)) {
    throw new Error(`registry: processors must be an array for ${label}`);
  }
  for (const [i, proc] of entry.processors.entries()) {
    validateProcessorDescriptor(proc, { label: `${label} processors[${i}]` });
  }

  return entry;
}

/**
 * Consolidated, validated table: direction key -> (resourceType -> entry).
 * Built once at load; malformed entries throw here (fail-fast).
 * @type {Object<string, Object<string, Object>>}
 */
const CONSOLIDATED = {};
for (const [key, subRegistry] of Object.entries(DIRECTION_REGISTRIES)) {
  const normalized = {};
  for (const [resourceType, raw] of Object.entries(subRegistry || {})) {
    normalized[resourceType] = normalizeEntry(raw, `${key} ${resourceType}`);
  }
  CONSOLIDATED[key] = normalized;
}

/**
 * Return a fresh copy of a normalized entry with copied fml and processors,
 * so callers can mutate the result without corrupting the shared table.
 * The processor descriptors themselves are shared (they are stateless).
 *
 * @param {{fml: {coverage: string}, processors: Array<Object>}} entry Source entry.
 * @returns {{fml: {coverage: string}, processors: Array<Object>}} A safe copy.
 */
function cloneEntry(entry) {
  return { ...entry, fml: { ...entry.fml }, processors: [...entry.processors] };
}

/**
 * Create a registry instance bound to an engine factory.
 *
 * The engine factory supplies the hasMapping validity gate; the consolidated
 * postprocessor tables are shared module state (built once at load). The
 * returned lookup() therefore validates against the given factory while reading
 * the shared, root-independent tables.
 *
 * @param {{hasMapping: Function}} engineFactory Engine factory exposing
 *   `hasMapping(resType, fromVer, toVer) -> boolean`.
 * @returns {{lookup: Function}} Registry instance.
 * @throws {Error} If engineFactory does not expose a hasMapping function.
 */
export function createRegistry(engineFactory) {
  if (!engineFactory || typeof engineFactory.hasMapping !== 'function') {
    throw new Error('createRegistry: engineFactory with a hasMapping function is required');
  }

  /**
   * Look up the registry entry for a resource type on one adjacent version hop.
   *
   * The bound factory's hasMapping is the single source of truth for tuple
   * validity: if the tuple is not convertible (unknown version pair or resource
   * type with no FML mapping), this throws rather than returning a misleading
   * default. For a valid tuple, a reviewed entry is returned (as a safe copy);
   * an unreviewed one resolves to the functional default.
   *
   * @param {string} resourceType FHIR resource type, e.g. 'Patient'.
   * @param {string} fromVer      Canonical source version (R2|R3|R4|R4B|R5).
   * @param {string} toVer        Canonical target version (R2|R3|R4|R4B|R5).
   * @returns {{fml: {coverage: string}, processors: Array<Object>}} Registry entry.
   * @throws {Error} If the tuple is not convertible (invalid version pair or
   *   unknown resource type).
   */
  function lookup(resourceType, fromVer, toVer) {
    if (!engineFactory.hasMapping(resourceType, fromVer, toVer)) {
      throw new Error(
        `registry.lookup: no FML mapping for ${resourceType} ${fromVer}->${toVer} ` +
        '(invalid version pair or resource type)',
      );
    }

    const entry = CONSOLIDATED[directionKey(fromVer, toVer)]?.[resourceType];
    return entry ? cloneEntry(entry) : defaultEntry();
  }

  return { lookup };
}

/**
 * Return the set of direction keys the registry has sub-registries for.
 * Exposed for the consistency test that checks these against the lane-derived
 * adjacent pairs (see getAdjacentPairs).
 *
 * @returns {string[]} e.g. ['R2->R3', 'R3->R2', ...].
 */
export function registeredDirections() {
  return Object.keys(DIRECTION_REGISTRIES);
}

/**
 * Return a read-only snapshot of the consolidated, normalized registry tables,
 * for tooling such as the COVERAGE.md generator.
 *
 * The shape is `directionKey -> (resourceType -> entry)`, where each entry is
 * the same normalized object `lookup()` returns. Entries are copied (via
 * cloneEntry), so callers cannot mutate the shared tables. This reads the
 * root-independent postprocessor tables only; it needs no engine factory and
 * performs no validity check (unlike lookup()).
 *
 * @returns {Object<string, Object<string, {fml: {coverage: string, description?: string}, processors: Array<Object>}>>}
 *   The consolidated tables.
 */
export function getConsolidatedRegistry() {
  const snapshot = {};
  for (const [key, table] of Object.entries(CONSOLIDATED)) {
    const perType = {};
    for (const [resourceType, entry] of Object.entries(table)) {
      perType[resourceType] = cloneEntry(entry);
    }
    snapshot[key] = perType;
  }
  return snapshot;
}

