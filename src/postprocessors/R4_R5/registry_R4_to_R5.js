/**
 * @fileoverview Postprocessor registry for the R4 -> R5 direction.
 *
 * Maps FHIR resource type name -> registry entry for R4 -> R5 conversions.
 * See CONTRIBUTING.md for the registry workflow and entry examples.
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

  // The R4->R5 FML maps every shared ValueSet element. R5-only additions do
  // not require values to be invented, and no resource postprocessor is needed.
  ValueSet: {
    fml: {
      coverage: COVERAGE.COMPLETE,
      description: 'FML fully covers R4->R5 ValueSet conversion; no postprocessor needed.',
    },
    processors: [],
  },
};
