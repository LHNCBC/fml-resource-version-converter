/**
 * @fileoverview Converter context: the integration layer's composition root.
 *
 * This internal context supports the directly testable `runHop` binding. Public
 * converters use `defaultConverters.js`; both paths consume the same committed
 * all-directions runtime data and perform no filesystem access.
 *
 * @module converter/converterContext
 */
import runtimeAll from '../runtime/data_modules/all.js';
import { createRuntimeFmlEngineFactory } from '../fml_base_conv/runtime_engine_factory.js';
import { createRegistry } from '../postprocessors/registry.js';

/**
 * Build the converter context: the shared engine factory and registry.
 *
 * The registry is bound to the same runtime engine factory, so mapping validity
 * checks and conversions always use one selection.
 *
 * @returns {{engineFactory: Object, registry: {lookup: Function}}} The context.
 */
function createConverterContext() {
  const engineFactory = createRuntimeFmlEngineFactory(runtimeAll);
  const registry = createRegistry(engineFactory);

  return Object.freeze({ engineFactory, registry });
}

/**
 * The single, package-owned converter context.
 *
 * Created once at module load and cached by the ES module system.
 *
 * @type {{engineFactory: Object, registry: {lookup: Function}}}
 */
export const converterContext = createConverterContext();
