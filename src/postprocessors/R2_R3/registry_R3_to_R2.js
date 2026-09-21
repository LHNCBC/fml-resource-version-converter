/**
 * @fileoverview Postprocessor registry for the R3 -> R2 direction.
 *
 * Maps FHIR resource type name -> registry entry for R3 -> R2 conversions.
 * See CONTRIBUTING.md for the registry workflow and entry examples.
 *
 * @module postprocessors/R2_R3/registry_R3_to_R2
 */
import { COVERAGE } from '../../converter/coverage.js';
import { conv_R3_to_R2 as convBinary_R3_to_R2 } from './Binary.js';

export const registry = {
  // Reviewed against the FHIR spec and bundled mapping. STU3 adds the optional
  // securityContext element, which DSTU2 cannot represent. The FML drops it
  // silently; the postprocessor reports the unavoidable loss.
  Binary: {
    fml: {
      coverage: COVERAGE.KNOWN_GAPS,
      description:
        'FML maps shared Binary content but silently drops STU3 securityContext, '
        + 'which DSTU2 cannot represent; reported by the Binary_R3_to_R2 postprocessor.',
    },
    processors: [convBinary_R3_to_R2],
  },
};
