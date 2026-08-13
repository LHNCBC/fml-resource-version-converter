/**
 * @fileoverview Postprocessor registry for the R4B -> R5 direction.
 *
 * Maps FHIR resource type name -> registry entry for R4B -> R5 conversions.
 * See CONTRIBUTING.md for the registry workflow and entry examples.
 *
 * @module postprocessors/R4B_R5/registry_R4B_to_R5
 */
import { COVERAGE } from '../../converter/coverage.js';
import { conv_R4B_to_R5 as convCodeSystem_R4B_to_R5 } from './CodeSystem.js';

export const registry = {
  // Binary has the same element set and cardinalities in R4B and R5. The FML
  // maps every element directly, including data and primitive companions.
  Binary: {
    fml: {
      coverage: COVERAGE.COMPLETE,
      description: 'FML fully covers R4B->R5 Binary conversion; no postprocessor needed.',
    },
    processors: [],
  },

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

  // Reviewed against the FHIR spec. R4B declares the same 66 CodeSystem element
  // paths as R4 and, like R4, has no invariant tying content = "supplement" to
  // CodeSystem.supplements, while R5 requires it (csd-4). The gap and its
  // handling are therefore identical to R4->R5 - supplements is marked absent
  // with the standard data-absent-reason extension rather than invented - and
  // the R4->R5 transform is reused. The version-specific meta.profile is
  // rewritten from 4.3 to 5.0 by the mapping.
  CodeSystem: {
    fml: {
      coverage: COVERAGE.KNOWN_GAPS,
      description:
        'FML maps every shared CodeSystem element but silently emits R4B supplements '
        + 'that omit CodeSystem.supplements, which R5 invariant csd-4 rejects; repaired '
        + 'by the CodeSystem_R4B_to_R5 postprocessor.',
    },
    processors: [convCodeSystem_R4B_to_R5],
  },
};
