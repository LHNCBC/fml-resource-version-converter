// Public API barrel for the FHIR resource version converter.
//
// Curated (explicit) re-exports, grouped by audience:
//   - Conversion entry point (consumers).
//   - Policy / report enums (consumers, to interpret options and results).
//   - Authoring helpers (contributors writing pre-/post-processors).
//
// The multi-hop convert() is added in a later phase; for now the single-hop
// entry point is the public conversion function. The low-level FML engine
// factory lives behind the package's "./fml-engine" subpath, not here. Other
// internal machinery (coverage rollups, status ranking, validators) is private.
import { converterContext } from './converter/converterContext.js';

// ----- Conversion entry point ----------------------------------------------
export { convertSingleHop } from './converter/singleHopConverter.js';

// ----- Registry read (inspect / re-assemble a conversion's pipeline) --------
/**
 * Read the registry entry for one adjacent version hop of a resource type.
 *
 * Returns the FML coverage and the package's postprocessor descriptors so a
 * caller can reorder / subset / extend them and feed them back to
 * convertSingleHop via opts.postprocs (with the 'replace' policy). The entry is
 * a safe copy - a fresh `fml` object and a fresh `processors` array (the
 * descriptors are shared but stateless) - so mutating it never affects the
 * package tables. Each descriptor includes its `execute` function.
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
// POSTPROCESS_POLICY is used in convertSingleHop options.
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

