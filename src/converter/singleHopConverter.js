/**
 * @fileoverview Single-hop FHIR resource version conversion.
 *
 * Public entry point for converting a resource between adjacent FHIR versions
 * that have direct FML mapping file available.
 * Non-adjacent conversions (multi-hop chaining) use convert() (added later);
 * this function throws if the pair is not a single direct FML hop.
 *
 * Result shape:
 *   { resource, coverage, status, fml_base_conv, postprocessors?, preprocessors? }
 * The multi-hop convert() nests the same per-hop report fields under `hops[]`;
 * the common fields (resource, coverage, status) are identical across both.
 *
 * Pipeline:
 *   1. Validate resource shape and the FML mapping (gates version/adjacency).
 *   2. Deep-clone the caller input (caller's object is never touched).
 *   3. Run caller preprocessors once, in order.
 *   4. Resolve postprocessors (registry + caller, per postprocessPolicy) and
 *      optionally enforce non-decreasing coverage.
 *   5. Run the FML engine, capturing warnings/info into the _FML_ report.
 *   6. Run postprocessors in order.
 *   7. Assemble the flat result object.
 *
 * @module converter/singleHopConverter
 */
import { converterContext } from './converterContext.js';
import {
  POSTPROCESS_POLICY,
  assertPostprocessPolicy,
  resolvePostprocessors,
} from './postprocessPolicy.js';
import {
  assertNonDecreasingCoverage,
  COVERAGE,
  rollupChainCoverage,
  rollupHopCoverage,
} from './coverage.js';
import {
  assertWarningInvariant,
  makeMessage,
  MESSAGE_TYPE,
  rollupStatus,
  statusFromMessages,
} from './diagnostics.js';

/**
 * Convert a FHIR resource across one adjacent FHIR version hop.
 *
 * @param {Object} resource FHIR resource to convert; `resource.resourceType`
 *   must be a non-empty string.
 * @param {string} fromVer Canonical source version (R2|R3|R4|R4B|R5).
 * @param {string} toVer   Canonical target version (R2|R3|R4|R4B|R5).
 * @param {Object} [opts]
 * @param {Array<Object>} [opts.preprocs=[]] Preprocessor descriptors run once
 *   before the FML step. See processorDescriptor.js.
 * @param {Array<Object>} [opts.postprocs] Caller postprocessor descriptors for
 *   this hop, combined with the package registry's per postprocessPolicy. When
 *   omitted (undefined), the registry's postprocessors are used and the policy
 *   is moot; an explicit empty array with policy 'replace' runs none.
 * @param {string} [opts.postprocessPolicy='append'] How opts.postprocs combine
 *   with the registry's postprocessors: 'append' (registry then caller) or
 *   'replace' (caller only). See postprocessPolicy.js.
 * @param {boolean} [opts.checkCoverage=true] Enforce non-decreasing coverage
 *   along the postprocessor list.
 * @returns {Object} Flat result object; see the module overview for the shape.
 * @throws {Error} On unknown resource type, missing/non-adjacent FML mapping,
 *   invalid postprocessPolicy, decreasing coverage, warning-invariant
 *   violation, or any hard error thrown by a processor or the engine.
 */
export function convertSingleHop(resource, fromVer, toVer, opts = {}) {
  const {
    preprocs = [],
    postprocs,
    postprocessPolicy = POSTPROCESS_POLICY.APPEND,
    checkCoverage = true,
  } = opts;
  assertPostprocessPolicy(postprocessPolicy);

  // ---- 1. Validation ----------------------------------------------------
  const resType = resource?.resourceType;
  if (typeof resType !== 'string' || resType.length === 0) {
    throw new Error('convertSingleHop: resource.resourceType is required');
  }

  // ---- 2. Build engine (checks mapping) ---------------------------------
  // FML mapping files exist only for valid, distinct, adjacent version pairs,
  // so a present mapping is the single gate for this one-hop path: no file
  // means the conversion cannot be performed. Wiring comes from the shared,
  // package-owned converter context (bundled mappings root).
  const { engineFactory, registry } = converterContext;
  if (!engineFactory.hasMapping(resType, fromVer, toVer)) {
    throw new Error(
      `convertSingleHop: no direct FML mapping for ${resType} ${fromVer}->${toVer}`,
    );
  }

  // ---- 3. Deep-clone caller input (private working copy) ----------------
  let working = structuredClone(resource);

  // ---- 4. Run caller preprocessors --------------------------------------
  const preReports = [];
  for (const pre of preprocs) {
    working = runProcessor(pre, working, { fromVer, toVer }, 'preprocessor', preReports);
  }

  // ---- 5. Resolve postprocessors + coverage check -----------------------
  // sourceResource for the hop is the input to the FML step (post-preproc).
  const sourceResource = working;
  // The registry supplies the FML coverage and the package default
  // postprocessor list; caller postprocs combine per postprocessPolicy.
  const registryEntry = registry.lookup(resType, fromVer, toVer);
  const fmlCoverage = registryEntry.fml.coverage;
  const postprocessors = resolvePostprocessors(
    registryEntry.processors,
    postprocs,
    postprocessPolicy,
  );
  if (checkCoverage) {
    assertNonDecreasingCoverage(fmlCoverage, postprocessors);
  }

  // ---- 6. Run FML engine, capturing diagnostics -------------------------
  const fmlMessages = [];
  const engine = engineFactory.createEngine(resType, fromVer, toVer, {
    onWarning: text => fmlMessages.push(makeMessage(MESSAGE_TYPE.WARNING, text)),
    onInfo:    text => fmlMessages.push(makeMessage(MESSAGE_TYPE.INFO, text)),
  });
  working = engine.convert({ input: working });
  const fmlStatus = statusFromMessages(fmlMessages);

  // ---- 7. Run postprocessors --------------------------------------------
  const postReports = [];
  const postCtx = { sourceResource, fromVer, toVer };
  for (const post of postprocessors) {
    working = runProcessor(post, working, postCtx, 'postprocessor', postReports, {
      includeCoverage: true,
    });
  }

  // ---- 8. Assemble the flat result object -------------------------------
  const fmlReport = {
    name: '_FML_',
    coverage: fmlCoverage,
    status: fmlStatus,
    messages: fmlMessages,
  };

  const hopCoverage = rollupHopCoverage(
    fmlCoverage,
    postprocessors.map(p => p.coverage),
  );
  const overallCoverage = rollupChainCoverage([hopCoverage]);

  const overallStatus = rollupStatus([
    ...preReports.map(p => p.status),
    fmlStatus,
    ...postReports.map(p => p.status),
  ]);

  const result = {
    resource: working,
    coverage: overallCoverage,
    status: overallStatus,
    fml_base_conv: fmlReport,
  };
  if (postReports.length > 0) result.postprocessors = postReports;
  if (preReports.length > 0) result.preprocessors = preReports;

  return result;
}

/**
 * Invoke a pre-/post-processor and append a report entry.
 *
 * Validates the returned result shape and the warning-message invariant, then
 * returns the next working resource. Kept here (rather than in
 * processorDescriptor.js) because it depends on the runtime pipeline shape;
 * Phase 4 will lift this into a shared internal if the multi-hop path needs it.
 *
 * @param {Object} processor Processor descriptor with { name, execute, coverage? }.
 * @param {Object} inputResource Resource passed to processor.execute.
 * @param {Object} ctx Context object for the processor.
 * @param {string} kind 'preprocessor' | 'postprocessor' (used in error labels).
 * @param {Array<Object>} reports Array to append this processor's report to.
 * @param {Object} [reportOpts]
 * @param {boolean} [reportOpts.includeCoverage=false] Include coverage in the report.
 * @returns {Object} The next working resource.
 * @throws {Error} If the result shape or warning invariant is violated.
 */
function runProcessor(processor, inputResource, ctx, kind, reports, reportOpts = {}) {
  const label = `${kind} "${processor.name}" result`;
  const result = processor.execute(inputResource, ctx);
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error(`${label} must be an object`);
  }
  const { resource: outResource, status, messages } = result;
  if (!outResource || typeof outResource !== 'object' || Array.isArray(outResource)) {
    throw new Error(`${label}.resource must be an object`);
  }
  assertWarningInvariant(status, messages, label);

  const report = { name: processor.name, status, messages: messages || [] };
  if (reportOpts.includeCoverage) {
    report.coverage = processor.coverage ?? COVERAGE.NEUTRAL;
  }
  reports.push(report);
  return outResource;
}

