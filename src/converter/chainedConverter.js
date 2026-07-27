/**
 * @fileoverview Multi-hop FHIR resource version conversion (public entry point).
 *
 * `chainedConverter.convert` converts a resource between any supported pair of
 * FHIR versions, chaining adjacent FML hops as needed (a single adjacent pair is
 * a chain of length 1). It is the universal one-shot entry; the single-resource
 * `singleHopConverter` is the primitive/building block.
 *
 * Unified result shape:
 *   {
 *     resource,                 // final converted resource (intermediates dropped)
 *     coverage,                 // lowest hop coverage across the chain
 *     status,                   // highest runtime severity across all hops
 *     hops: [                   // one entry per hop, in order
 *       { fromVer, toVer, preprocessors?, fml_base_conv, postprocessors? },
 *       ...
 *     ],
 *   }
 *
 * Pipeline: plan the hops (planHops validates the version pair, incl. rejecting
 * same-version and unsupported pairs), normalize the processor options once
 * against that plan, deep-clone the caller input once, then run each hop through
 * the shared runHop core, mutating the single working copy. Overall coverage and
 * status are rolled up from the per-hop results.
 *
 * Processors are per hop. The singular `preproc`/`postproc` are conveniences for
 * the outer boundaries: `preproc` (PRP) is applied to the first hop for the
 * primary type (and lands in `hops[0].preprocessors`), `postproc` (PSP) to the
 * last hop. The keyed `preprocs`/`postprocs` can target ANY hop on the path -
 * including intermediate hops - and any resource type, so preprocessors are not
 * limited to the first hop.
 *
 * @module converter/chainedConverter
 */
import { planHops } from '../fml_base_conv/create_converter.js';
import { normalizeProcessorOptions } from './processorOptions.js';
import { runHop } from './runHop.js';
import { rollupChainCoverage } from './coverage.js';
import { rollupStatus } from './diagnostics.js';

/**
 * Convert a FHIR resource between any supported version pair (multi-hop).
 *
 * @param {Object} resource FHIR resource; `resource.resourceType` must be a
 *   non-empty string.
 * @param {string} fromVer Canonical source version (R2|R3|R4|R4B|R5).
 * @param {string} toVer   Canonical target version (R2|R3|R4|R4B|R5).
 * @param {Object} [opts]
 * @param {*} [opts.preproc]   PRP: a PRPE applied to the first hop (primary type).
 * @param {*} [opts.preprocs]  PRPs: a keyed map/lookup for preprocessors.
 * @param {*} [opts.postproc]  PSP: a PSPE applied to the last hop (primary type).
 * @param {*} [opts.postprocs] PSPs: a keyed map/lookup for postprocessors.
 * @param {boolean} [opts.checkCoverage=true] Enforce non-decreasing coverage
 *   within each hop.
 * @returns {Object} Unified result object; see the module overview for the shape.
 * @throws {Error} On same-version / unsupported version pairs, unknown resource
 *   type / missing FML mapping for a required hop, invalid processor options,
 *   decreasing coverage, a warning-invariant violation, or any hard error from a
 *   processor or the engine.
 */
function convert(resource, fromVer, toVer, opts = {}) {
  const { checkCoverage = true } = opts;

  // Plan first: planHops validates the version pair (same-version, unsupported
  // pairs, and unknown versions all throw here, before any work).
  const hops = planHops(fromVer, toVer);

  const { preLookup, postLookup } = normalizeProcessorOptions(opts, {
    hops,
    primaryType: resource?.resourceType,
  });

  // Clone once; each hop mutates the shared working copy.
  let working = structuredClone(resource);
  const hopReports = [];
  const hopCoverages = [];
  const statuses = [];

  for (const [v1, v2] of hops) {
    const hop = runHop(working, v1, v2, { preLookup, postLookup, checkCoverage });
    working = hop.resource;
    hopReports.push(hop.fragment);
    hopCoverages.push(hop.hopCoverage);
    statuses.push(hop.status);
  }

  return {
    resource: working,
    coverage: rollupChainCoverage(hopCoverages),
    status: rollupStatus(statuses),
    hops: hopReports,
  };
}

/**
 * The multi-hop converter: an object exposing `convert`.
 *
 * Exposed as an object (not a bare function) for consistency with
 * singleHopConverter and a future createConverter(opts) -> { convert }.
 *
 * @type {{convert: typeof convert}}
 */
export const chainedConverter = { convert };


