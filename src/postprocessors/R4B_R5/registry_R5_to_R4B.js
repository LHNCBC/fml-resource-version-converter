/**
 * @fileoverview Postprocessor registry for the R5 -> R4B direction.
 *
 * Maps FHIR resource type name -> registry entry for R5 -> R4B conversions.
 * See CONTRIBUTING.md for the registry workflow and entry examples.
 *
 * @module postprocessors/R4B_R5/registry_R5_to_R4B
 */
import { COVERAGE } from '../../converter/coverage.js';
import { conv_R5_to_R4B } from './Questionnaire.js';
import { conv_R5_to_R4B as convValueSet_R5_to_R4B } from './ValueSet.js';
import { conv_R5_to_R4B as convCodeSystem_R5_to_R4B } from './CodeSystem.js';
import { conv_R5_to_R4B as convLibrary_R5_to_R4B } from './Library.js';

export const registry = {
  // Binary has the same element set and cardinalities in R5 and R4B. The FML
  // maps every element directly, including data and primitive companions.
  Binary: {
    fml: {
      coverage: COVERAGE.COMPLETE,
      description: 'FML fully covers R5->R4B Binary conversion; no postprocessor needed.',
    },
    processors: [],
  },

  // Reviewed against the FHIR spec. R4B is identical to R4 for Questionnaire.item
  // (no answerConstraint, same type set), so the FML mis-narrows item.type the
  // same way as R5->R4: a malformed wrapped primitive when answerConstraint is
  // involved, and over-widening to open-choice. The postprocessor recomputes
  // item.type from the R5 source, bringing the conversion to BEST_EFFORT.
  Questionnaire: {
    fml: {
      coverage: COVERAGE.KNOWN_GAPS,
      description:
        'FML mis-narrows item.type (malformed wrapped primitive and over-widened '
        + 'open-choice); corrected by the Questionnaire_R5_to_R4B postprocessor.',
    },
    processors: [conv_R5_to_R4B],
  },

  // Reviewed against the FHIR spec. R4B and R4 have the same ValueSet element
  // set, and filter.op binds to the same nine FilterOperator codes, so the FML
  // has the same gaps as R5->R4: it maps every shared element and drops
  // R5-only content silently, but preserves the R5-only filter operators
  // child-of and descendent-leaf, which are not valid in R4B. The postprocessor
  // approximates those as descendent-of and reports the dropped content,
  // bringing the conversion to BEST_EFFORT.
  ValueSet: {
    fml: {
      coverage: COVERAGE.KNOWN_GAPS,
      description:
        'FML maps shared ValueSet content but drops R5-only elements and retains '
        + 'R5-only filter operators that do not conform to the R4B binding.',
    },
    processors: [convValueSet_R5_to_R4B],
  },

  // Reviewed against the FHIR spec. R4B and R4 declare the same CodeSystem
  // element set, and filter.operator binds to the same nine FilterOperator
  // codes, so the FML has the same gaps as R5->R4: it drops the R5-only
  // metadata elements and concept.designation.additionalUse silently, and
  // preserves the R5-only operators child-of and descendent-leaf, which are not
  // valid in R4B. The postprocessor reports the dropped content and removes
  // those operator codes, bringing the conversion to BEST_EFFORT.
  CodeSystem: {
    fml: {
      coverage: COVERAGE.KNOWN_GAPS,
      description:
        'FML maps shared CodeSystem content but drops R5-only elements and retains '
        + 'R5-only filter operators that do not conform to the R4B binding.',
    },
    processors: [convCodeSystem_R5_to_R4B],
  },

  // R4B and R4 have the same relevant structures, so R5->R4B has the same
  // unavoidable losses as R5->R4: R5-only Library fields and nested Attachment,
  // DataRequirement, and RelatedArtifact content, plus required-binding codes
  // that R4B does not define. The R5->R4 transform is reused to apply exact
  // resource renames, remove unrepresentable entries, and report every loss.
  Library: {
    fml: {
      coverage: COVERAGE.KNOWN_GAPS,
      description:
        'FML silently drops R5-only Library and nested datatype content and preserves '
        + 'version-specific DataRequirement.type and RelatedArtifact.type codes that do not '
        + 'conform to R4B required bindings.',
    },
    processors: [convLibrary_R5_to_R4B],
  },
};
