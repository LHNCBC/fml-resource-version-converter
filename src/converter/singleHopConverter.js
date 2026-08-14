/**
 * @fileoverview Single-hop FHIR resource version conversion (public primitive).
 *
 * `singleHopConverter.convert` converts a resource between adjacent FHIR
 * versions that have a direct FML mapping. It is the mainstream one-hop call and
 * the building block for custom multi-hop chains (compose it over planHops()).
 *
 * Flat result shape:
 *   { resource, coverage, status, preprocessors?, fml_base_conv, postprocessors? }
 * The multi-hop chainedConverter nests per-hop reports under hops[]; the two
 * entry points intentionally have different result shapes.
 *
 * Pipeline: clone the caller input once, then delegate the single hop to the
 * shared runHop core (pre -> FML -> post). Processor options
 * (preproc/preprocs/postproc/postprocs) are normalized once into the canonical
 * (type, v1, v2) lookups; for a single hop the versions are fixed to that hop.
 *
 * @module converter/singleHopConverter
 */
import { normalizeProcessorOptions, resolveSingleHopOptionKeys } from './processorOptions.js';
import { runHop } from './runHop.js';
import { rollupChainCoverage } from './coverage.js';
import { planHops } from '../fml_base_conv/create_converter.js';

/**
 * Convert a FHIR resource across one adjacent FHIR version hop.
 *
 * @param {Object} resource FHIR resource; `resource.resourceType` must be a
 *   non-empty string.
 * @param {string} fromVer Canonical source version (R2|R3|R4|R4B|R5).
 * @param {string} toVer   Canonical target version (R2|R3|R4|R4B|R5).
 * @param {Object} [opts]
 * @param {*} [opts.preproc]   PRP: a PRPE (array) applied before the FML step.
 * @param {*} [opts.preprocs]  PRPs: a keyed map/lookup for preprocessors.
 * @param {*} [opts.postproc]  PSP: a PSPE applied in postprocessing (combined with package postprocessors per policy).
 * @param {*} [opts.postprocs] PSPs: a keyed map/lookup for postprocessors.
 * @param {boolean} [opts.checkCoverage=true] Enforce non-decreasing coverage.
 * @param {string} [opts.targetResourceType] The intended target FHIR resource
 *   type. Required only when the source resource maps to more than one target on
 *   the hop (e.g. ServiceRequest R4->R3 maps to ProcedureRequest or
 *   ReferralRequest); optional for a one-to-one mapping. When supplied, it is
 *   checked against the target declared by the FML StructureMap.
 * @returns {Object} Flat result object; see the module overview for the shape.
 * @throws {Error} On unknown / same / unsupported / non-adjacent versions,
 *   unknown resource type / missing FML mapping, invalid processor options,
 *   decreasing coverage, a warning-invariant violation, or any hard error from
 *   a processor or the engine.
 */
function convert(resource, fromVer, toVer, opts = {}) {
  const { checkCoverage = true, targetResourceType } = opts;

  const hops = planHops(fromVer, toVer);
  if (hops.length !== 1) {
    throw new Error(
      `singleHopConverter.convert requires an adjacent version pair; ` +
      `use chainedConverter.convert for ${fromVer}->${toVer}`,
    );
  }

  if (targetResourceType != null &&
      (typeof targetResourceType !== 'string' || targetResourceType.length === 0)) {
    throw new Error(
      'singleHopConverter.convert: opts.targetResourceType must be a non-empty string',
    );
  }

  // Single-hop convenience: accept type-only keyed map options by canonicalizing
  // them to "type:v1->v2" before the (single-/multi-hop-agnostic) normalizer.
  const resolvedOpts = resolveSingleHopOptionKeys(opts, hops[0]);
  const { preLookup, postLookup } = normalizeProcessorOptions(resolvedOpts, {
    hops,
    primaryType: resource?.resourceType,
  });

  // Clone once so the caller's object is never touched; runHop mutates freely.
  const working = structuredClone(resource);
  const hop = runHop(working, fromVer, toVer, {
    preLookup,
    postLookup,
    checkCoverage,
    targetResourceType,
  });


  const result = {
    resource: hop.resource,
    coverage: rollupChainCoverage([hop.hopCoverage]),
    status: hop.status,
  };
  if (hop.fragment.preprocessors) result.preprocessors = hop.fragment.preprocessors;
  result.fml_base_conv = hop.fragment.fml_base_conv;
  if (hop.fragment.postprocessors) result.postprocessors = hop.fragment.postprocessors;
  return result;
}

/**
 * The single-hop converter: an object exposing `convert`.
 *
 * Exposed as an object (not a bare function) for consistency with
 * chainedConverter and a future createConverter(opts) -> { convert }.
 *
 * @type {{convert: typeof convert}}
 */
export const singleHopConverter = { convert };
