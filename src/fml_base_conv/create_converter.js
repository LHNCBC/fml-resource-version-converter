/**
 * @fileoverview All-data compatibility entry point for the low-level FML engine.
 *
 * Runtime mappings, ConceptMaps, FHIR tables, and FHIRPath models come from the
 * committed `runtime/all` module. Raw snapshot roots are maintainer inputs and
 * are no longer accepted by runtime conversion APIs.
 *
 * @module fml_base_conv/create_converter
 */

import runtimeAll from '../runtime/data_modules/all.js';
import { createRuntimeFmlEngineFactory } from './runtime_engine_factory.js';

export { getAdjacentPairs, planHops } from './version_graph.js';

/**
 * Create an all-directions FML engine factory from committed runtime data.
 *
 * Zero-argument construction is retained for the public `./fml-engine`
 * compatibility surface. Selective internal construction uses
 * `createRuntimeFmlEngineFactory(runtimeData)` directly.
 *
 * @param {Object} [options] Empty compatibility options object.
 * @returns {import('./runtime_engine_factory.js').RuntimeFmlEngineFactory}
 *   Frozen all-directions engine factory.
 * @throws {Error} If non-empty options are supplied; `xverInputRoot` was removed.
 */
export function createFmlEngineFactory(options) {
  const isObject = options !== null && typeof options === 'object' && !Array.isArray(options);
  if (options !== undefined && (!isObject || Reflect.ownKeys(options).length > 0)) {
    throw new Error(
      'createFmlEngineFactory: options are no longer supported; xverInputRoot was removed',
    );
  }

  return createRuntimeFmlEngineFactory(runtimeAll);
}
