/**
 * @fileoverview Postprocessor registry for the R4 -> R5 direction.
 *
 * Maps FHIR resource type name -> registry entry for R4 -> R5 conversions.
 * See src/postprocessors/README.md and the design documents ("The postprocessor
 * registry") for the entry shape.
 *
 * @module postprocessors/R4_R5/registry_R4_to_R5
 */
import { COVERAGE } from '../../converter/coverage.js';

// Final cumulative coverage per conversion is generated into COVERAGE.md,
// derived from each entry's fml.coverage and its postprocessors' coverage.
export const registry = {
  // Reviewed and determined that the FML mapping fully performs the Questionnaire
  // R4->R5 conversion for valid input, including item type
  // choice/open-choice -> coding with the appropriate answerConstraint.
  Questionnaire: {
    fml: {
      coverage: COVERAGE.COMPLETE,
      description: 'FML fully covers R4->R5 for valid input; no postprocessor needed.',
    },
    processors: [],
  },
};

