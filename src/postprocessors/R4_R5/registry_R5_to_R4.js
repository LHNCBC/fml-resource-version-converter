/**
 * @fileoverview Postprocessor registry for the R5 -> R4 direction.
 *
 * Maps FHIR resource type name -> registry entry for R5 -> R4 conversions.
 * See src/postprocessors/README.md and the design documents ("The postprocessor
 * registry") for the entry shape.
 *
 * @module postprocessors/R4_R5/registry_R5_to_R4
 */
import { COVERAGE } from '../../converter/coverage.js';
import { conv_R5_to_R4 } from './Questionnaire.js';

// Final cumulative coverage per conversion is generated into COVERAGE.md,
// derived from each entry's fml.coverage and its postprocessors' coverage.
export const registry = {
  // FML alone is PARTIAL for R5->R4: it mis-narrows Questionnaire item.type
  // (over-produces open-choice) and emits a malformed type: { value: "..." }
  // whenever answerConstraint was involved. The postprocessor recomputes the
  // R4 item.type from the R5 source, bringing the necessary (non-IVE)
  // conversion to COMPLETE. Inter-version-extension include is deferred (see
  // the design documents, "Inter-version extensions").
  Questionnaire: {
    fml: {
      coverage: COVERAGE.PARTIAL,
      description:
        'FML mis-narrows item.type (over-produces open-choice) and emits a '
        + 'malformed type object; corrected by the Questionnaire_R5_to_R4 postprocessor.',
    },
    processors: [conv_R5_to_R4],
  },
};

