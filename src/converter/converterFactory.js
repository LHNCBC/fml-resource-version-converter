/**
 * @fileoverview Runtime-data-bound converter construction.
 *
 * This public, code-only entry point deliberately does not import the
 * package-owned converter singleton or the all-directions runtime module, so
 * callers can bind only their selected data.
 *
 * @module converter/converterFactory
 */

import { createRuntimeFmlEngineFactory } from '../fml_base_conv/runtime_engine_factory.js';
import { createRegistry } from '../postprocessors/registry.js';
import {
  createChainedConverter,
  createGetRegistryEntry,
  createRunHop,
  createSingleHopConverter,
} from './boundConverters.js';

/**
 * @typedef {Object} BoundConverters
 * @property {{convert: Function}} singleHopConverter Adjacent-hop converter.
 * @property {{convert: Function}} chainedConverter Multi-hop converter.
 * @property {Function} getRegistryEntry Registry reader scoped to the selection.
 */

/**
 * Factory for converters bound to an opaque runtime-data selection.
 * Every returned entry point shares the same validated engine factory and
 * postprocessor registry.
 */
export const converterFactory = Object.freeze({
  /**
   * Create conversion entry points sharing one runtime-data context.
   *
   * @param {Object|Object[]} runtimeDataOrArray Runtime data module or modules.
   * @returns {BoundConverters} Frozen, selection-scoped converter entry points.
   * @throws {Error} If the selection is empty, malformed, incomplete, or conflicting.
   */
  create(runtimeDataOrArray) {
    const engineFactory = createRuntimeFmlEngineFactory(runtimeDataOrArray);
    const registry = createRegistry(engineFactory);
    const converterContext = Object.freeze({ engineFactory, registry });
    const runHop = createRunHop(converterContext);

    return Object.freeze({
      singleHopConverter: createSingleHopConverter(runHop, engineFactory.hasDirection),
      chainedConverter: createChainedConverter(runHop, engineFactory.hasDirection),
      getRegistryEntry: createGetRegistryEntry(converterContext),
    });
  },
});
