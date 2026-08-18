/**
 * @fileoverview The per-hop conversion core, shared by both entry points.
 *
 * `runHop` performs one adjacent-version hop for a resource and its contained
 * resources:
 *   1. Run this hop's preprocessors (from the caller pre lookup), in order.
 *   2. Snapshot the FML input as `sourceResource` (post-preproc).
 *   3. Resolve postprocessors (registry + caller, per policy) and optionally
 *      enforce non-decreasing coverage.
 *   4. Run the FML engine, capturing warnings/info into the `_FML_` report.
 *   5. Convert each contained resource through the same stages for this hop and
 *      replace the copies made by the parent FML mapping.
 *   6. Run the parent's postprocessors, in order.
 *   7. Return the working resource plus a hop report fragment (including flat
 *      child reports), effective coverage across all resource-hops performed,
 *      and rolled-up status.
 *
 * It does not clone the primary input: the public entry point owns that clone,
 * so a multi-hop chain mutates one primary working copy. Each child is cloned
 * before its preprocessors run so the parent's `sourceResource` snapshot keeps
 * the source-version child unchanged. Processor selection arrives
 * pre-normalized as primary and contained `(type, v1, v2)` lookups (see
 * processorOptions.js), so this core deals with one processor-spec shape.
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
  rollupEffectiveCoverage,
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
 * Run one adjacent-version hop for a resource and its contained resources.
 *
 * @param {Object} resource FHIR resource entering this hop; `resourceType` must
 *   be a non-empty string. Mutation-safe: the caller has cloned already.
 * @param {string} fromVer Canonical source version (R2|R3|R4|R4B|R5).
 * @param {string} toVer   Canonical target version (R2|R3|R4|R4B|R5).
 * @param {Object} [opts]
 * @param {Function} [opts.preLookup]  `(type, v1, v2) -> preDescriptor[]|undefined`.
 * @param {Function} [opts.postLookup] `(type, v1, v2) -> { policy, processors }|undefined`.
 * @param {Function} [opts.containedPreLookup] Preprocessor lookup for contained resources.
 * @param {Function} [opts.containedPostLookup] Postprocessor lookup for contained resources.
 * @param {boolean}  [opts.checkCoverage=true] Enforce non-decreasing coverage
 *   along the resolved postprocessor list.
 * @param {string} [opts.targetResourceType] Intended target FHIR resource type.
 *   Required when the source maps to more than one target on this hop.
 * @returns {{resource: Object, fragment: Object, hopCoverage: string, status: string}}
 *   The converted resource, the hop report fragment
 *   (`{ fromVer, toVer, preprocessors?, fml_base_conv, contained?,
 *   postprocessors? }`), effective coverage across the resource-hop
 *   conversions performed, and their rolled-up runtime status.
 * @throws {Error} On unknown resource type / missing FML mapping, decreasing
 *   coverage, a warning-invariant violation, or any hard error from a processor
 *   or the engine.
 */
export function runHop(resource, fromVer, toVer, opts = {}) {
  const {
    preLookup,
    postLookup,
    containedPreLookup,
    containedPostLookup,
    checkCoverage = true,
    targetResourceType,
  } = opts;

  return runResourceHop(resource, fromVer, toVer, {
    preLookup,
    postLookup,
    containedPreLookup,
    containedPostLookup,
    checkCoverage,
    targetResourceType,
    convertContained: true,
  });
}

/**
 * Run the conversion stages for one resource.
 *
 * The primary invocation converts one level of contained resources between its
 * FML and postprocessor stages. Child invocations set `convertContained` false;
 * FHIR prohibits contained resources from containing other resources.
 *
 * @param {Object} resource Resource entering this hop.
 * @param {string} fromVer Source version.
 * @param {string} toVer Target version.
 * @param {Object} opts Normalized execution options.
 * @returns {{resource: Object, fragment: Object, hopCoverage: string, status: string}}
 *   Per-resource hop result.
 */
function runResourceHop(resource, fromVer, toVer, opts) {
  const {
    preLookup,
    postLookup,
    containedPreLookup,
    containedPostLookup,
    checkCoverage,
    targetResourceType,
    convertContained,
  } = opts;

  // ---- 1. Validate resource + mapping gate ------------------------------
  const resType = resource?.resourceType;
  if (typeof resType !== 'string' || resType.length === 0) {
    throw new Error('runHop: resource.resourceType is required');
  }
  if (targetResourceType != null &&
      (typeof targetResourceType !== 'string' || targetResourceType.length === 0)) {
    throw new Error('runHop: opts.targetResourceType must be a non-empty string');
  }

  const { engineFactory, registry } = converterContext;
  if (!engineFactory.hasMapping(resType, fromVer, toVer)) {
    throw new Error(`runHop: no direct FML mapping for ${resType} ${fromVer}->${toVer}`);
  }
  const mapping = engineFactory.resolveMapping(resType, fromVer, toVer, {
    targetResourceType,
  });

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
  const sourceContained = convertContained
    ? validateContained(sourceResource.contained, fromVer, toVer)
    : undefined;

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
    targetResourceType: mapping.targetResourceType,
    onWarning: text => fmlMessages.push(makeMessage(MESSAGE_TYPE.WARNING, text)),
    onInfo:    text => fmlMessages.push(makeMessage(MESSAGE_TYPE.INFO, text)),
  });
  const engineResult = engine.convert({ input: working });
  working = engineResult.resource;
  const fmlStatus = statusFromMessages(fmlMessages);

  // ---- 5. Contained resources -------------------------------------------
  const containedResults = [];
  if (sourceContained !== undefined) {
    const converted = sourceContained.map((child, index) => {
      try {
        const childResult = runResourceHop(
          structuredClone(child),
          fromVer,
          toVer,
          {
            preLookup: containedPreLookup,
            postLookup: containedPostLookup,
            checkCoverage,
            targetResourceType: undefined,
            convertContained: false,
          },
        );
        containedResults.push(childResult);
        return childResult.resource;
      } catch (error) {
        throw new Error(
          `runHop: ${containedLabel(child, index, fromVer, toVer)}: ${error.message}`,
          { cause: error },
        );
      }
    });
    working.contained = converted;
  }
  const containedReports = containedResults.map(toFlatContainedReport);

  // ---- 6. Postprocessors ------------------------------------------------
  const postReports = [];
  const postCtx = { sourceResource, fromVer, toVer };
  for (const post of postprocessors) {
    working = runProcessor(post, working, postCtx, 'postprocessor', postReports, {
      includeCoverage: true,
    });
  }

  // ---- 7. Assemble the hop fragment -------------------------------------
  const fmlReport = {
    name: '_FML_',
    coverage: fmlCoverage,
    status: fmlStatus,
    messages: fmlMessages,
  };

  const fragment = { fromVer, toVer };
  if (preReports.length > 0) fragment.preprocessors = preReports;
  fragment.fml_base_conv = fmlReport;
  if (containedReports.length > 0) fragment.contained = containedReports;
  if (postReports.length > 0) fragment.postprocessors = postReports;

  const resourceHopCoverage = rollupHopCoverage(
    fmlCoverage,
    postprocessors.map(p => p.coverage),
  );
  const hopCoverage = rollupEffectiveCoverage([
    resourceHopCoverage,
    ...containedResults.map(result => result.hopCoverage),
  ]);
  const status = rollupStatus([
    ...preReports.map(p => p.status),
    fmlStatus,
    ...containedResults.map(result => result.status),
    ...postReports.map(p => p.status),
  ]);

  return { resource: working, fragment, hopCoverage, status };
}

/**
 * Convert one internal child-hop result to the flat public report shape.
 *
 * The child resource is snapshotted before the parent postprocessors run. A
 * parent processor may subsequently restructure the target's contained array;
 * the hop report remains an execution record of the child conversion itself.
 *
 * @param {Object} child Internal child-hop result.
 * @returns {Object} Flat contained-resource report.
 */
function toFlatContainedReport(child) {
  const report = {
    resource: structuredClone(child.resource),
    coverage: child.hopCoverage,
    status: child.status,
  };
  if (child.fragment.preprocessors) report.preprocessors = child.fragment.preprocessors;
  report.fml_base_conv = child.fragment.fml_base_conv;
  if (child.fragment.postprocessors) report.postprocessors = child.fragment.postprocessors;
  return report;
}

/**
 * Validate the structural rules needed for contained-resource orchestration.
 *
 * This is deliberately not general FHIR validation. It checks only that the
 * field can be traversed safely and rejects nested contained input because
 * child conversion is intentionally not recursive.
 *
 * @param {*} contained Value of the parent resource's contained field.
 * @param {string} fromVer Source version for diagnostics.
 * @param {string} toVer Target version for diagnostics.
 * @returns {Array<Object>|undefined} The validated array, or undefined.
 * @throws {Error} If the field or an entry is malformed, or an entry contains
 *   another contained resource.
 */
function validateContained(contained, fromVer, toVer) {
  if (contained === undefined) return undefined;
  if (!Array.isArray(contained)) {
    throw new Error(`runHop: resource.contained must be an array for ${fromVer}->${toVer}`);
  }

  for (const [index, child] of contained.entries()) {
    if (!child || typeof child !== 'object' || Array.isArray(child)) {
      throw new Error(
        `runHop: contained[${index}] ${fromVer}->${toVer} must be a resource object`,
      );
    }
    if (typeof child.resourceType !== 'string' || child.resourceType.length === 0) {
      throw new Error(
        `runHop: contained[${index}] ${fromVer}->${toVer} resourceType is required`,
      );
    }
    if (child.contained !== undefined && !Array.isArray(child.contained)) {
      throw new Error(
        `runHop: ${containedLabel(child, index, fromVer, toVer)}: contained must be an array`,
      );
    }
    if (child.contained?.length > 0) {
      throw new Error(
        `runHop: ${containedLabel(child, index, fromVer, toVer)} cannot contain resources `
        + '(FHIR invariant dom-2)',
      );
    }
  }

  return contained;
}

/**
 * Build a stable diagnostic label for a contained resource.
 *
 * @param {Object} child Contained resource.
 * @param {number} index Array index.
 * @param {string} fromVer Source version.
 * @param {string} toVer Target version.
 * @returns {string} Label with position, type/id, and hop.
 */
function containedLabel(child, index, fromVer, toVer) {
  const id = typeof child.id === 'string' && child.id.length > 0 ? `#${child.id}` : '';
  return `contained[${index}] (${child.resourceType}${id}) ${fromVer}->${toVer}`;
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
  if (messages != null && !Array.isArray(messages)) {
    throw new Error(`${label}.messages must be an array`);
  }
  assertWarningInvariant(status, messages, label);

  const report = { name: processor.name, status, messages: messages || [] };
  if (reportOpts.includeCoverage) {
    report.coverage = processor.coverage ?? COVERAGE.NEUTRAL;
  }
  reports.push(report);
  return outResource;
}
