/**
 * @fileoverview Postprocessor registry for the R3 -> R4 direction.
 *
 * Maps FHIR resource type name -> registry entry for R3 -> R4 conversions.
 * See src/postprocessors/README.md and the design documents ("The postprocessor
 * registry") for the entry shape.
 *
 * @module postprocessors/R3_R4/registry_R3_to_R4
 */
import { COVERAGE } from '../../converter/coverage.js';
import { conv_R3_to_R4 } from './Questionnaire.js';

// Final cumulative coverage per conversion is generated into COVERAGE.md,
// derived from each entry's fml.coverage and its postprocessors' coverage.
export const registry = {
  // Reviewed against the FHIR spec. FML is PARTIAL for enableWhen answer types
  // that STU3 has and R4 removed (uri, Attachment): answerUri passes straight
  // through (invalid in R4) and answerAttachment yields a malformed entry. The
  // postprocessor drops these, bringing the necessary (non-IVE) conversion to
  // COMPLETE.
  Questionnaire: {
    fml: {
      coverage: COVERAGE.PARTIAL,
      description:
        'FML maps enableWhen answerUri straight through (invalid in R4) and '
        + 'leaves a malformed entry for answerAttachment; corrected by the '
        + 'Questionnaire_R3_to_R4 postprocessor.',
    },
    processors: [conv_R3_to_R4],
  },
};

