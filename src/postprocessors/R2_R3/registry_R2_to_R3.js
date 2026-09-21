/**
 * @fileoverview Postprocessor registry for the R2 -> R3 direction.
 *
 * Maps FHIR resource type name -> registry entry for R2 -> R3 conversions.
 * See CONTRIBUTING.md for the registry workflow and entry examples.
 *
 * @module postprocessors/R2_R3/registry_R2_to_R3
 */
import { COVERAGE } from '../../converter/coverage.js';

export const registry = {
  // Reviewed against the FHIR spec and bundled mapping. STU3 adds only the
  // optional securityContext element, so every DSTU2 Binary element maps
  // directly and no postprocessor is needed.
  Binary: {
    fml: {
      coverage: COVERAGE.COMPLETE,
      description: 'FML fully covers R2->R3 Binary conversion; no postprocessor needed.',
    },
    processors: [],
  },
};
