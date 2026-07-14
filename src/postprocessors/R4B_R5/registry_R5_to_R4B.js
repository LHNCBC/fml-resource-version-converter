/**
 * @fileoverview Postprocessor registry for the R5 -> R4B direction.
 *
 * Maps FHIR resource type name -> registry entry for R5 -> R4B conversions.
 * See src/postprocessors/README.md and the design documents ("The postprocessor
 * registry") for the entry shape.
 *
 * @module postprocessors/R4B_R5/registry_R5_to_R4B
 */
import { COVERAGE } from '../../converter/coverage.js';
import { conv_R5_to_R4B } from './Questionnaire.js';

export const registry = {
  // Reviewed against the FHIR spec. R4B is identical to R4 for Questionnaire.item
  // (no answerConstraint, same type set), so the FML mis-narrows item.type the
  // same way as R5->R4: a malformed wrapped primitive when answerConstraint is
  // involved, and over-widening to open-choice. The postprocessor recomputes
  // item.type from the R5 source, bringing the necessary (non-IVE) conversion to
  // COMPLETE.
  Questionnaire: {
    fml: {
      coverage: COVERAGE.PARTIAL,
      description:
        'FML mis-narrows item.type (malformed wrapped primitive and over-widened '
        + 'open-choice); corrected by the Questionnaire_R5_to_R4B postprocessor.',
    },
    processors: [conv_R5_to_R4B],
  },
};

