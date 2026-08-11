/**
 * @fileoverview Postprocessor registry for the R4B -> R5 direction.
 *
 * Maps FHIR resource type name -> registry entry for R4B -> R5 conversions.
 * See CONTRIBUTING.md for the registry workflow and entry examples.
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

  // Reviewed against the FHIR spec. R5 is a superset of R4B for ValueSet: no
  // R4B element was removed or restructured in R5, so the FML carries every
  // element over without loss and no value has to be invented. The
  // version-specific meta.profile is rewritten from 4.3 to 5.0 by the mapping.
  // No postprocessor needed.
  ValueSet: {
    fml: {
      coverage: COVERAGE.COMPLETE,
      description: 'FML fully covers R4B->R5 ValueSet conversion; no postprocessor needed.',
    },
    processors: [],
  },
};

