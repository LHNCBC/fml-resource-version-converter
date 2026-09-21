/**
 * @fileoverview Public entry point for the low-level FML engine (advanced).
 *
 * Expert surface for callers building their own conversion framework directly
 * on the pure FHIR Mapping Language engine. The zero-argument factory uses the
 * complete committed runtime data and exposes mapping lookup plus engine
 * construction. Version-graph helpers remain data-independent.
 *
 * This layer owns no postprocessor orchestration - that lives in the
 * integration API at the package root entry point. It is a curated facade over
 * the internal engine module; import it via the package's "./fml-engine"
 * subpath.
 *
 * @module fml-engine
 */
export {
  createFmlEngineFactory,
  planHops,
  getAdjacentPairs,
} from './fml_base_conv/create_converter.js';
