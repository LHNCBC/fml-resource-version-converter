/**
 * @fileoverview Converter context: the integration layer's composition root.
 *
 * Builds the shared wiring - the FML engine factory and the postprocessor
 * registry - once, and exports a single package-owned context object. The
 * conversion entry points (single-hop, and the future multi-hop convert())
 * import this module-global context and use ctx.engineFactory / ctx.registry
 * internally, so the wiring never bleeds into the public API.
 *
 * The FML mappings root is hard-coded to the bundled data (the default in
 * createFmlEngineFactory): these are FHIR-standard mapping files shipped with
 * the package, not something callers switch around, so there is no root option
 * on the public API. Advanced/engine-layer callers that genuinely need a custom
 * root can still build their own factory via createFmlEngineFactory.
 *
 * Creating the context is side-effect-free (no I/O at construction; FHIR defs
 * and FML files load lazily and are cached at module scope keyed by root), so
 * building it eagerly at module load is cheap and safe.
 *
 * @module converter/converterContext
 */
import { createFmlEngineFactory } from '../fml_base_conv/create_converter.js';
import { createRegistry } from '../postprocessors/registry.js';

/**
 * Build the converter context: the shared engine factory and registry.
 *
 * Private on purpose - the package exposes exactly one context (the
 * converterContext singleton below), never a means to construct more. Uses the
 * bundled FML mappings root (no root parameter by design). The registry is
 * bound to the same factory, so validity checks and conversions always agree on
 * the mappings.
 *
 * @returns {{engineFactory: Object, registry: {lookup: Function}}} The context.
 */
function createConverterContext() {
  const engineFactory = createFmlEngineFactory();
  const registry = createRegistry(engineFactory);
  return { engineFactory, registry };
}

/**
 * The single, package-owned converter context.
 *
 * This is the singleton: created once at module load and cached by the ES
 * module system, so every importer shares the same instance. The FML mappings
 * are static for the life of the process, so one context is always correct.
 * Import this and use converterContext.engineFactory / converterContext.registry.
 *
 * @type {{engineFactory: Object, registry: {lookup: Function}}}
 */
export const converterContext = createConverterContext();


