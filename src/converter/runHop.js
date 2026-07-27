/**
 * @fileoverview The per-hop conversion core, shared by both entry points.
 *
 * `runHop` performs one adjacent-version hop for a single resource:
 *   1. Run this hop's preprocessors (from the caller pre lookup), in order.
 *   2. Snapshot the FML input as `sourceResource` (post-preproc).
 *   3. Resolve postprocessors (registry + caller, per policy) and optionally
 *      enforce non-decreasing coverage.
 *   4. Run the FML engine, capturing warnings/info into the `_FML_` report.
 *   5. Run postprocessors, in order.
 *   6. Return the working resource plus a hop report fragment, the hop's
 *      governing coverage, and the hop's rolled-up runtime status.
 *
 * It does NOT clone its input: the caller (single-hop or multi-hop entry point)
 * owns the one-time deep clone, so a multi-hop chain clones once and each hop
 * mutates the shared working copy. Processor selection arrives pre-normalized as
 * two `(type, v1, v2)` lookups (see processorOptions.js), so this core deals
 * with exactly one processor-spec shape.
 *
 * @module converter/runHop
 */
import { converterContext } from './converterContext.js';
import {
  POSTPROCESS_POLICY,
  resolvePostprocessors,
} from './postprocessPolicy.js';
import {
  assertNonDecreasingCoverage,
  COVERAGE,
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
 * Run one adjacent-version hop for a single resource.
 *
 * @param {Object} resource FHIR resource entering this hop; `resourceType` must
 *   be a non-empty string. Mutation-safe: the caller has cloned already.
 * @param {string} fromVer Canonical source version (R2|R3|R4|R4B|R5).
 * @param {string} toVer   Canonical target version (R2|R3|R4|R4B|R5).
 * @param {Object} [opts]
 * @param {Function} [opts.preLookup]  `(type, v1, v2) -> preDescriptor[]|undefined`.
 * @param {Function} [opts.postLookup] `(type, v1, v2) -> { policy, processors }|undefined`.
 * @param {boolean}  [opts.checkCoverage=true] Enforce non-decreasing coverage
 *   along the resolved postprocessor list.
 * @returns {{resource: Object, fragment: Object, hopCoverage: string, status: string}}
 *   The converted resource, the hop report fragment
 *   (`{ fromVer, toVer, preprocessors?, fml_base_conv, postprocessors? }`), the
 *   hop's governing coverage, and its rolled-up runtime status.
 * @throws {Error} On unknown resource type / missing FML mapping, decreasing
 *   coverage, a warning-invariant violation, or any hard error from a processor
 *   or the engine.
 */
export function runHop(resource, fromVer, toVer, opts = {}) {
  const { preLookup, postLookup, checkCoverage = true } = opts;

  // ---- 1. Validate resource + mapping gate ------------------------------
  const resType = resource?.resourceType;
  if (typeof resType !== 'string' || resType.length === 0) {
    throw new Error('runHop: resource.resourceType is required');
  }

  const { engineFactory, registry } = converterContext;
  if (!engineFactory.hasMapping(resType, fromVer, toVer)) {
    throw new Error(`runHop: no direct FML mapping for ${resType} ${fromVer}->${toVer}`);
  }

  let working = resource;

  // ---- 2. Preprocessors for this hop ------------------------------------
  const preReports = [];
  const preList = preLookup?.(resType, fromVer, toVer);
  if (preList) {
    for (const pre of preList) {
      working = runProcessor(pre, working, { fromVer, toVer }, 'preprocessor', preReports);
    }
  }

  // The hop's sourceResource is the FML input (post-preproc). Read-only for
  // postprocessors by contract.
  const sourceResource = working;

  // ---- 3. Resolve postprocessors + coverage check -----------------------
  const registryEntry = registry.lookup(resType, fromVer, toVer);
  const fmlCoverage = registryEntry.fml.coverage;
  const callerPost = postLookup?.(resType, fromVer, toVer);
  const postprocessors = resolvePostprocessors(
    registryEntry.processors,
    callerPost?.processors,
    callerPost?.policy ?? POSTPROCESS_POLICY.APPEND,
  );
  if (checkCoverage) {
    assertNonDecreasingCoverage(fmlCoverage, postprocessors);
  }

  // ---- 4. FML engine, capturing diagnostics -----------------------------
  const fmlMessages = [];
  const engine = engineFactory.createEngine(resType, fromVer, toVer, {
    onWarning: text => fmlMessages.push(makeMessage(MESSAGE_TYPE.WARNING, text)),
    onInfo:    text => fmlMessages.push(makeMessage(MESSAGE_TYPE.INFO, text)),
  });
  working = engine.convert({ input: working });
  const fmlStatus = statusFromMessages(fmlMessages);

  // ---- 5. Postprocessors ------------------------------------------------
  const postReports = [];
  const postCtx = { sourceResource, fromVer, toVer };
  for (const post of postprocessors) {
    working = runProcessor(post, working, postCtx, 'postprocessor', postReports, {
      includeCoverage: true,
    });
  }

  // ---- 6. Assemble the hop fragment -------------------------------------
  const fmlReport = {
    name: '_FML_',
    coverage: fmlCoverage,
    status: fmlStatus,
    messages: fmlMessages,
  };

  const fragment = { fromVer, toVer };
  if (preReports.length > 0) fragment.preprocessors = preReports;
  fragment.fml_base_conv = fmlReport;
  if (postReports.length > 0) fragment.postprocessors = postReports;

  const hopCoverage = rollupHopCoverage(
    fmlCoverage,
    postprocessors.map(p => p.coverage),
  );
  const status = rollupStatus([
    ...preReports.map(p => p.status),
    fmlStatus,
    ...postReports.map(p => p.status),
  ]);

  return { resource: working, fragment, hopCoverage, status };
}

/**
 * Invoke a pre-/post-processor and append a report entry.
 *
 * Validates the returned result shape and the warning-message invariant, then
 * returns the next working resource.
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

