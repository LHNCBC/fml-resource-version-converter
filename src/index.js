// Public API barrel for the FHIR resource version converter.
//
// Curated (explicit) re-exports, grouped by audience:
//   - Conversion entry point (consumers).
//   - Policy / report enums (consumers, to interpret options and results).
//   - Authoring helpers (contributors writing pre-/post-processors).
//
// The two conversion entry points are objects exposing convert():
// singleHopConverter (one adjacent hop, flat result; the building block) and
// chainedConverter (multi-hop incl. length 1, hops[] result). The low-level FML
// engine factory lives behind the package's "./fml-engine" subpath, not here.
// Other internal machinery (coverage rollups, status ranking, validators) is
// private.
import { converterContext } from './converter/converterContext.js';

// ----- Conversion entry points ---------------------------------------------
export { singleHopConverter } from './converter/singleHopConverter.js';
export { chainedConverter } from './converter/chainedConverter.js';

// ----- Registry read (inspect / re-assemble a conversion's pipeline) --------
/**
 * Read the registry entry for one adjacent version hop of a resource type.
 *
 * Returns the FML coverage and the package's postprocessor descriptors so a
 * caller can reorder / subset / extend them and feed them back to a converter
 * via postproc/postprocs (e.g. a { policy: 'replace', psps } entry). The entry
 * is a safe copy - a fresh `fml` object, a fresh `processors` array, and a fresh
 * copy of each descriptor - so mutating any of it (including a descriptor's
 * `coverage` or `execute`) never affects the package tables or a later
 * lookup/conversion. Each descriptor includes its `execute` function.
 *
 * Read-only and tolerant: returns null for a tuple with no direct FML mapping
 * (unknown resource type, or invalid / non-adjacent version pair), so callers
 * can probe support without a try/catch. Needs no engine access.
 *
 * @param {string} resourceType FHIR resource type, e.g. 'Questionnaire'.
 * @param {string} fromVer      Canonical source version (R2|R3|R4|R4B|R5).
 * @param {string} toVer        Canonical target version (R2|R3|R4|R4B|R5).
 * @returns {{fml: {coverage: string, description?: string}, processors: Array<Object>}|null}
 *   The entry, or null when the tuple has no direct FML mapping.
 */
export function getRegistryEntry(resourceType, fromVer, toVer) {
  const { engineFactory, registry } = converterContext;
  if (!engineFactory.hasMapping(resourceType, fromVer, toVer)) return null;
  return registry.lookup(resourceType, fromVer, toVer);
}

// ----- Policy / report enums (used in options and result objects) ----------
// COVERAGE / STATUS / MESSAGE_TYPE appear in the result object and its reports;
// POSTPROCESS_POLICY is used in postproc/postprocs option entries.
export { POSTPROCESS_POLICY } from './converter/postprocessPolicy.js';
export { COVERAGE } from './converter/coverage.js';
export { STATUS, MESSAGE_TYPE } from './converter/diagnostics.js';

// ----- Authoring helpers for pre-/post-processors --------------------------
// Build and validate processor descriptors, and construct the diagnostic
// messages / status a processor's execute() returns.
export { makeProcessor, validateProcessorDescriptor } from './converter/processorDescriptor.js';
export {
  makeMessage,
  infoMessage,
  warningMessage,
  statusFromMessages,
} from './converter/diagnostics.js';
