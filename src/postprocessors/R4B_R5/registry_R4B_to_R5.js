/**
 * @fileoverview Postprocessor registry for the R4B -> R5 direction.
 *
 * Maps FHIR resource type name -> registry entry for R4B -> R5 conversions.
 * See src/postprocessors/README.md and the design documents ("The postprocessor
 * registry") for the entry shape.
 *
 * @module postprocessors/R4B_R5/registry_R4B_to_R5
 */
import { COVERAGE } from '../../converter/coverage.js';

export const registry = {
  // Reviewed against the FHIR spec. The FML maps R4B choice/open-choice ->
  // R5 coding + answerConstraint (the same as R4->R5), which is correct and
  // complete for valid input. No postprocessor needed. (Engine warnings about
  // #-prefixed contained ConceptMaps come from shared base maps, not the
  // Questionnaire mapping, and are unrelated to coverage.)
  Questionnaire: {
    fml: {
      coverage: COVERAGE.COMPLETE,
      description: 'FML fully covers R4B->R5 for valid input; no postprocessor needed.',
    },
    processors: [],
  },
};

