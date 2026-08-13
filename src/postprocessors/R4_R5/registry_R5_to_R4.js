/**
 * @fileoverview Postprocessor registry for the R5 -> R4 direction.
 *
 * Maps FHIR resource type name -> registry entry for R5 -> R4 conversions.
 * See CONTRIBUTING.md for the registry workflow and entry examples.
 *
 * @module postprocessors/R4_R5/registry_R5_to_R4
 */
import { COVERAGE } from '../../converter/coverage.js';
import { conv_R5_to_R4 } from './Questionnaire.js';
import { conv_R5_to_R4 as convValueSet_R5_to_R4 } from './ValueSet.js';
import { conv_R5_to_R4 as convCodeSystem_R5_to_R4 } from './CodeSystem.js';

// Final cumulative coverage per conversion is generated into COVERAGE.md,
// derived from each entry's fml.coverage and its postprocessors' coverage.
export const registry = {
  // Binary has the same element set and cardinalities in R5 and R4. The FML
  // maps every element directly, including data and primitive companions.
  Binary: {
    fml: {
      coverage: COVERAGE.COMPLETE,
      description: 'FML fully covers R5->R4 Binary conversion; no postprocessor needed.',
    },
    processors: [],
  },

  // FML alone has KNOWN_GAPS for R5->R4: it mis-narrows Questionnaire item.type
  // (over-produces open-choice) and emits a malformed type: { value: "..." }
  // whenever answerConstraint was involved. The postprocessor recomputes the
  // R4 item.type from the R5 source, bringing the conversion to BEST_EFFORT.
  // Inter-version-extension include is deferred (see the design documents,
  // "Inter-version extensions").
  Questionnaire: {
    fml: {
      coverage: COVERAGE.KNOWN_GAPS,
      description:
        'FML mis-narrows item.type (over-produces open-choice) and emits a '
        + 'malformed type object; corrected by the Questionnaire_R5_to_R4 postprocessor.',
    },
    processors: [conv_R5_to_R4],
  },

  // The FML maps all shared ValueSet elements, but silently drops R5-only
  // content. It also preserves R5-only filter operators that have no R4
  // equivalent. The postprocessor approximates those operators as
  // descendent-of and emits a warning.
  ValueSet: {
    fml: {
      coverage: COVERAGE.KNOWN_GAPS,
      description:
        'FML maps shared ValueSet content but drops R5-only elements and retains '
        + 'R5-only filter operators that do not conform to the R4 binding.',
    },
    processors: [convValueSet_R5_to_R4],
  },

  // Reviewed against the FHIR spec. The FML maps every element R4 and R5 share
  // and drops the 11 R5-only metadata elements plus
  // concept.designation.additionalUse silently. It also preserves the R5-only
  // filter operators child-of and descendent-leaf, because csd.fi.operator-5to4
  // marks them noMap and the engine passes unmapped codes through unchanged;
  // neither is in the R4 FilterOperator binding. The postprocessor reports the
  // dropped content and removes those operator codes - CodeSystem.filter.operator
  // is 1..* and declares supported filter capability, so removal leaves a
  // truthful declaration where substituting a near operator would claim support
  // the terminology does not have.
  CodeSystem: {
    fml: {
      coverage: COVERAGE.KNOWN_GAPS,
      description:
        'FML maps shared CodeSystem content but drops R5-only elements and retains '
        + 'R5-only filter operators that do not conform to the R4 binding.',
    },
    processors: [convCodeSystem_R5_to_R4],
  },
};
