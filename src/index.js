// Public API barrel for the FHIR resource version converter.
//
// Re-exports the integration layer (see src/converter/) as the package entry
// point. The multi-hop convert() is added in a later phase; for now the
// single-hop entry point and the postprocess policy enum are public.
//
// See next-step.txt ("The proposed source directory structure").

export { convertSingleHop } from './converter/singleHopConverter.js';
export { POSTPROCESS_POLICY } from './converter/postprocessPolicy.js';

