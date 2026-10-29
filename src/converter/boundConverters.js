/**
 * @fileoverview Pure constructors for context-bound converter entry points.
 *
 * This module does not import the package converter singleton. A legacy context
 * or a runtime-data context can therefore bind the same orchestration code
 * without pulling the other context into its dependency graph.
 *
 * @module converter/boundConverters
 */

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
import {
  normalizeProcessorOptions,
  resolveSingleHopOptionKeys,
} from './processorOptions.js';
import { planHops } from '../fml_base_conv/version_graph.js';

/**
 * @typedef {Object} ConverterContext
 * @property {{hasMapping: Function, resolveMapping: Function, createEngine: Function}}
 *   engineFactory Mapping-aware single-hop engine factory.
 * @property {{lookup: Function}} registry Postprocessor registry bound to the
 *   same engine factory.
 */

/**
 * @typedef {Object} HopResult
 * @property {Object} resource Resource after FML and postprocessing.
 * @property {Object} fragment Per-hop diagnostic report, including flat
 *   contained-resource reports when the hop converted any.
 * @property {string} hopCoverage Effective coverage across the primary and
 *   contained resource-hop conversions performed by this hop.
 * @property {string} status Rolled-up runtime status.
 */

/**
 * @typedef {Object} SingleHopResult
 * @property {Object} resource Converted resource.
 * @property {string} coverage Rolled-up conversion coverage.
 * @property {string} status Rolled-up runtime status.
 * @property {Object[]} [preprocessors] Preprocessor reports.
 * @property {Object} fml_base_conv FML engine report.
 * @property {Object[]} [postprocessors] Postprocessor reports.
 * @property {Object[]} [contained] Flat contained-resource conversion reports.
 */

/**
 * @typedef {Object} ChainedResult
 * @property {Object} resource Final converted resource.
 * @property {string} coverage Effective coverage across every resource-hop
 *   conversion performed, including contained resources.
 * @property {string} status Highest runtime severity across all hops.
 * @property {Object[]} hops Ordered per-hop diagnostic reports.
 */

/**
 * Execute one already-planned adjacent conversion hop.
 *
 * @callback RunHopFunction
 * @param {Object} resource Resource entering the hop; not cloned by this call.
 * @param {string} fromVer Source version.
 * @param {string} toVer Target version.
 * @param {Object} [options] Normalized processor and mapping options.
 * @returns {HopResult} Converted resource and hop reporting data.
 */

/**
 * Invoke one processor and append its validated report.
 *
 * @param {{name: string, execute: Function, coverage?: string}} processor
 *   Processor descriptor.
 * @param {Object} inputResource Resource passed to the processor.
 * @param {Object} context Processor context.
 * @param {string} kind Diagnostic processor kind.
 * @param {Object[]} reports Destination reports.
 * @param {Object} [reportOptions]
 * @param {boolean} [reportOptions.includeCoverage=false] Include coverage.
 * @returns {Object} Validated processor output resource.
 * @throws {Error} If the processor result or warning status is invalid.
 */
function runProcessor(
  processor,
  inputResource,
  context,
  kind,
  reports,
  { includeCoverage = false } = {},
) {
  const label = `${kind} "${processor.name}" result`;
  const result = processor.execute(inputResource, context);
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error(`${label} must be an object`);
  }
  const { resource, status, messages } = result;
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) {
    throw new Error(`${label}.resource must be an object`);
  }
  if (messages != null && !Array.isArray(messages)) {
    throw new Error(`${label}.messages must be an array`);
  }
  assertWarningInvariant(status, messages, label);

  const report = { name: processor.name, status, messages: messages || [] };
  if (includeCoverage) report.coverage = processor.coverage ?? COVERAGE.NEUTRAL;
  reports.push(report);

  return resource;
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
 * Convert one internal child-hop result to the flat public report shape.
 *
 * The child resource is snapshotted before the parent postprocessors run. A
 * parent processor may subsequently restructure the target's contained array;
 * the hop report remains an execution record of the child conversion itself.
 *
 * @param {HopResult} child Internal child-hop result.
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
 * Create the per-hop conversion function bound to one converter context.
 *
 * @param {ConverterContext} converterContext Shared conversion context.
 * @returns {RunHopFunction} Bound hop runner.
 * @throws {Error} If the context lacks the required engine or registry methods.
 */
export function createRunHop(converterContext) {
  if (!converterContext || typeof converterContext !== 'object') {
    throw new Error('createRunHop: converter context is required');
  }
  const { engineFactory, registry } = converterContext;
  if (!engineFactory || typeof engineFactory.createEngine !== 'function' ||
      typeof engineFactory.hasMapping !== 'function' ||
      typeof engineFactory.resolveMapping !== 'function') {
    throw new Error('createRunHop: context engineFactory is invalid');
  }
  if (!registry || typeof registry.lookup !== 'function') {
    throw new Error('createRunHop: context registry is invalid');
  }

  /**
   * Run the conversion stages for one resource.
   *
   * The primary invocation converts one level of contained resources between
   * its FML and postprocessor stages. Child invocations set `convertContained`
   * false; FHIR prohibits contained resources from containing other resources.
   *
   * @param {Object} resource Resource entering this hop.
   * @param {string} fromVer Source version.
   * @param {string} toVer Target version.
   * @param {Object} opts Normalized execution options.
   * @returns {HopResult} Per-resource hop result.
   * @throws {Error} If the resource, mapping, processors, or engine result is invalid.
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
    const resourceType = resource?.resourceType;
    if (typeof resourceType !== 'string' || resourceType.length === 0) {
      throw new Error('runHop: resource.resourceType is required');
    }
    if (targetResourceType != null &&
        (typeof targetResourceType !== 'string' || targetResourceType.length === 0)) {
      throw new Error('runHop: opts.targetResourceType must be a non-empty string');
    }
    if (!engineFactory.hasMapping(resourceType, fromVer, toVer)) {
      throw new Error(
        `runHop: no direct FML mapping for ${resourceType} ${fromVer}->${toVer}`,
      );
    }
    const mapping = engineFactory.resolveMapping(resourceType, fromVer, toVer, {
      targetResourceType,
    });

    let working = resource;

    // ---- 2. Preprocessors for this hop ------------------------------------
    const preReports = [];
    const preList = preLookup?.(resourceType, fromVer, toVer);
    if (preList) {
      for (const preprocessor of preList) {
        working = runProcessor(
          preprocessor,
          working,
          { fromVer, toVer },
          'preprocessor',
          preReports,
        );
      }
    }

    // The hop's sourceResource is the FML input (post-preproc). Read-only for
    // postprocessors by contract.
    const sourceResource = working;
    const sourceContained = convertContained
      ? validateContained(sourceResource.contained, fromVer, toVer)
      : undefined;

    // ---- 3. Resolve postprocessors + coverage check -----------------------
    const registryEntry = registry.lookup(resourceType, fromVer, toVer);
    const fmlCoverage = registryEntry.fml.coverage;
    const callerPost = postLookup?.(resourceType, fromVer, toVer);
    const postprocessors = resolvePostprocessors(
      registryEntry.processors,
      callerPost?.processors,
      callerPost?.policy ?? POSTPROCESS_POLICY.APPEND,
    );
    if (checkCoverage) assertNonDecreasingCoverage(fmlCoverage, postprocessors);

    // ---- 4. FML engine, capturing diagnostics -----------------------------
    // Performance note: every resource-hop compiles its own engine, so a parent
    // with many contained children of the same resource type and direction
    // recompiles the same mapping repeatedly. Caching compiled mapping
    // templates by (resourceType, fromVer, toVer, targetResourceType) would
    // remove that cost. The diagnostic callbacks below are bound at engine
    // creation and must stay per-hop, so any cache belongs at the
    // factory/template level, not in a reused engine instance.
    // Engine sharing to be implemented in the future.
    const fmlMessages = [];
    const engine = engineFactory.createEngine(resourceType, fromVer, toVer, {
      targetResourceType: mapping.targetResourceType,
      onWarning: text => fmlMessages.push(makeMessage(MESSAGE_TYPE.WARNING, text)),
      onInfo: text => fmlMessages.push(makeMessage(MESSAGE_TYPE.INFO, text)),
    });
    working = engine.convert({ input: working }).resource;
    const fmlStatus = statusFromMessages(fmlMessages);

    // ---- 5. Contained resources -------------------------------------------
    const containedResults = [];
    if (sourceContained !== undefined) {
      const convertedContained = sourceContained.map((child, index) => {
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
          const message = error instanceof Error ? error.message : String(error);
          const detail = message.startsWith('runHop: ')
            ? message.slice('runHop: '.length)
            : message;
          throw new Error(
            `runHop: ${containedLabel(child, index, fromVer, toVer)}: ${detail}`,
            { cause: error },
          );
        }
      });

      if (convertedContained.length > 0) working.contained = convertedContained;
      else delete working.contained;
    }
    const containedReports = containedResults.map(toFlatContainedReport);

    // ---- 6. Postprocessors ------------------------------------------------
    const postReports = [];
    const postContext = { sourceResource, fromVer, toVer };
    for (const postprocessor of postprocessors) {
      working = runProcessor(
        postprocessor,
        working,
        postContext,
        'postprocessor',
        postReports,
        { includeCoverage: true },
      );
    }

    // ---- 7. Assemble the hop fragment -------------------------------------
    const fragment = { fromVer, toVer };
    if (preReports.length > 0) fragment.preprocessors = preReports;
    fragment.fml_base_conv = {
      name: '_FML_',
      coverage: fmlCoverage,
      status: fmlStatus,
      messages: fmlMessages,
    };
    if (containedReports.length > 0) fragment.contained = containedReports;
    if (postReports.length > 0) fragment.postprocessors = postReports;

    const resourceHopCoverage = rollupHopCoverage(
      fmlCoverage,
      postprocessors.map(processor => processor.coverage),
    );

    return {
      resource: working,
      fragment,
      hopCoverage: rollupEffectiveCoverage([
        resourceHopCoverage,
        ...containedResults.map(result => result.hopCoverage),
      ]),
      status: rollupStatus([
        ...preReports.map(report => report.status),
        fmlStatus,
        ...containedResults.map(result => result.status),
        ...postReports.map(report => report.status),
      ]),
    };
  }

  /**
   * Run one adjacent conversion hop for a resource and its contained resources.
   *
   * @param {Object} resource Resource entering the hop.
   * @param {string} fromVer Source version.
   * @param {string} toVer Target version.
   * @param {Object} [opts] Normalized hop options.
   * @param {Function} [opts.preLookup] Preprocessor lookup for this hop.
   * @param {Function} [opts.postLookup] Postprocessor lookup for this hop.
   * @param {Function} [opts.containedPreLookup] Preprocessor lookup for contained resources.
   * @param {Function} [opts.containedPostLookup] Postprocessor lookup for contained resources.
   * @param {boolean} [opts.checkCoverage=true] Enforce non-decreasing coverage.
   * @param {string} [opts.targetResourceType] Selected target resource type.
   * @returns {HopResult} Converted resource and hop report values.
   * @throws {Error} If the resource, mapping, processors, or engine result is invalid.
   */
  function runHop(resource, fromVer, toVer, opts = {}) {
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

  return runHop;
}

/**
 * Create a single-hop converter bound to a runHop implementation.
 *
 * @param {RunHopFunction} runHop Bound hop runner.
 * @param {Function|null} [hasDirection=null] Optional `(fromVer, toVer)` gate
 *   used to reject an unselected runtime-data direction before conversion.
 * @returns {{convert: Function}} Frozen converter exposing `convert()`.
 * @throws {Error} If either supplied dependency has the wrong type.
 */
export function createSingleHopConverter(runHop, hasDirection = null) {
  if (typeof runHop !== 'function') {
    throw new Error('createSingleHopConverter: runHop function is required');
  }
  if (hasDirection !== null && typeof hasDirection !== 'function') {
    throw new Error('createSingleHopConverter: hasDirection must be a function');
  }

  /**
   * Convert one resource across one adjacent version hop.
   *
   * @param {Object} resource Source resource.
   * @param {string} fromVer Source version.
   * @param {string} toVer Target version.
   * @param {Object} [opts] Conversion and processor options.
   * @param {*} [opts.preproc] Preprocessors applied before FML.
   * @param {*} [opts.preprocs] Hop-keyed preprocessor lookup or map.
   * @param {*} [opts.postproc] Postprocessors applied after FML.
   * @param {*} [opts.postprocs] Hop-keyed postprocessor lookup or map.
   * @param {boolean} [opts.checkCoverage=true] Enforce non-decreasing coverage.
   * @param {string} [opts.targetResourceType] Target for an ambiguous mapping.
   *   This option applies only to the primary resource; target types for
   *   ambiguous contained resources cannot currently be selected, so such a
   *   child causes an error.
   * @returns {SingleHopResult} Flat conversion and diagnostic result.
   * @throws {Error} If the version pair, resource, options, or conversion is invalid.
   */
  function convert(resource, fromVer, toVer, opts = {}) {
    const { checkCoverage = true, targetResourceType } = opts;
    const hops = planHops(fromVer, toVer);
    if (hops.length !== 1) {
      throw new Error(
        'singleHopConverter.convert requires an adjacent version pair; ' +
        `use chainedConverter.convert for ${fromVer}->${toVer}`,
      );
    }
    if (hasDirection && !hasDirection(fromVer, toVer)) {
      throw new Error(
        `singleHopConverter.convert: runtime data does not include ${fromVer}->${toVer}`,
      );
    }
    if (targetResourceType != null &&
        (typeof targetResourceType !== 'string' || targetResourceType.length === 0)) {
      throw new Error(
        'singleHopConverter.convert: opts.targetResourceType must be a non-empty string',
      );
    }

    const resolvedOptions = resolveSingleHopOptionKeys(opts, hops[0]);
    const {
      preLookup,
      postLookup,
      containedPreLookup,
      containedPostLookup,
    } = normalizeProcessorOptions(resolvedOptions, {
      hops,
      primaryType: resource?.resourceType,
    });
    const working = structuredClone(resource);
    const hop = runHop(working, fromVer, toVer, {
      preLookup,
      postLookup,
      containedPreLookup,
      containedPostLookup,
      checkCoverage,
      targetResourceType,
    });
    const result = {
      resource: hop.resource,
      coverage: hop.hopCoverage,
      status: hop.status,
    };
    if (hop.fragment.preprocessors) result.preprocessors = hop.fragment.preprocessors;
    result.fml_base_conv = hop.fragment.fml_base_conv;
    if (hop.fragment.contained?.length > 0) result.contained = hop.fragment.contained;
    if (hop.fragment.postprocessors) result.postprocessors = hop.fragment.postprocessors;

    return result;
  }

  return Object.freeze({ convert });
}

/**
 * Create a chained converter bound to a runHop implementation.
 *
 * @param {RunHopFunction} runHop Bound hop runner.
 * @param {Function|null} [hasDirection=null] Optional `(fromVer, toVer)` gate
 *   used to reject incomplete runtime-data selections before conversion.
 * @returns {{convert: Function}} Frozen converter exposing `convert()`.
 * @throws {Error} If either supplied dependency has the wrong type.
 */
export function createChainedConverter(runHop, hasDirection = null) {
  if (typeof runHop !== 'function') {
    throw new Error('createChainedConverter: runHop function is required');
  }
  if (hasDirection !== null && typeof hasDirection !== 'function') {
    throw new Error('createChainedConverter: hasDirection must be a function');
  }

  /**
   * Convert one resource across every planned adjacent hop.
   *
   * @param {Object} resource Source resource.
   * @param {string} fromVer Source version.
   * @param {string} toVer Target version.
   * @param {Object} [opts] Conversion and processor options.
   * @param {*} [opts.preproc] Preprocessors applied at the first boundary.
   * @param {*} [opts.preprocs] Hop-keyed preprocessor lookup or map.
   * @param {*} [opts.postproc] Postprocessors applied at the last boundary.
   * @param {*} [opts.postprocs] Hop-keyed postprocessor lookup or map.
   * @param {boolean} [opts.checkCoverage=true] Enforce coverage within each hop.
   * @returns {ChainedResult} Final resource and ordered hop reports.
   * @throws {Error} If the route, runtime selection, options, or a hop is invalid.
   */
  function convert(resource, fromVer, toVer, opts = {}) {
    const { checkCoverage = true } = opts;
    if (opts.targetResourceType !== undefined) {
      throw new Error(
        'chainedConverter.convert does not support opts.targetResourceType; ' +
        'use singleHopConverter.convert for the ambiguous hop',
      );
    }

    const hops = planHops(fromVer, toVer);
    const missingHop = hasDirection && hops.find(([hopFrom, hopTo]) =>
      !hasDirection(hopFrom, hopTo));
    if (missingHop) {
      throw new Error(
        `chainedConverter.convert: runtime data does not include ${missingHop[0]}->${missingHop[1]}`,
      );
    }
    const {
      preLookup,
      postLookup,
      containedPreLookup,
      containedPostLookup,
    } = normalizeProcessorOptions(opts, {
      hops,
      primaryType: resource?.resourceType,
    });
    let working = structuredClone(resource);
    const hopReports = [];
    const hopCoverages = [];
    const statuses = [];
    for (const [hopFrom, hopTo] of hops) {
      const hop = runHop(working, hopFrom, hopTo, {
        preLookup,
        postLookup,
        containedPreLookup,
        containedPostLookup,
        checkCoverage,
      });
      working = hop.resource;
      hopReports.push(hop.fragment);
      hopCoverages.push(hop.hopCoverage);
      statuses.push(hop.status);
    }

    return {
      resource: working,
      coverage: rollupEffectiveCoverage(hopCoverages),
      status: rollupStatus(statuses),
      hops: hopReports,
    };
  }

  return Object.freeze({ convert });
}

/**
 * Create a registry reader bound to one converter context.
 *
 * @param {ConverterContext} converterContext Shared conversion context.
 * @returns {Function} Bound registry reader.
 * @throws {Error} If the converter context is missing.
 */
export function createGetRegistryEntry(converterContext) {
  if (!converterContext?.engineFactory || !converterContext?.registry) {
    throw new Error('createGetRegistryEntry: converter context is required');
  }

  /**
   * Read a safe registry entry for one convertible tuple.
   *
   * @param {string} resourceType Source resource type.
   * @param {string} fromVer Source version.
   * @param {string} toVer Target version.
   * @returns {Object|null} Mutation-safe registry entry, or null when unsupported.
   */
  function getRegistryEntry(resourceType, fromVer, toVer) {
    const { engineFactory, registry } = converterContext;
    if (!engineFactory.hasMapping(resourceType, fromVer, toVer)) return null;

    return registry.lookup(resourceType, fromVer, toVer);
  }

  return getRegistryEntry;
}
