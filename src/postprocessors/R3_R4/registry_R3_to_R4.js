/**
 * @fileoverview Postprocessor registry for the R3 -> R4 direction.
 *
 * Maps FHIR resource type name -> registry entry for R3 -> R4 conversions.
 * See CONTRIBUTING.md for the registry workflow and entry examples.
 *
 * @module postprocessors/R3_R4/registry_R3_to_R4
 */
import { COVERAGE } from '../../converter/coverage.js';
import { conv_R3_to_R4 } from './Questionnaire.js';
import { conv_R3_to_R4 as convValueSet_R3_to_R4 } from './ValueSet.js';

// Final cumulative coverage per conversion is generated into COVERAGE.md,
// derived from each entry's fml.coverage and its postprocessors' coverage.
export const registry = {
  // Reviewed against the FHIR spec. FML has KNOWN_GAPS for enableWhen answer types
  // that STU3 has and R4 removed (uri, Attachment): answerUri passes straight
  // through (invalid in R4) and answerAttachment yields a malformed entry. The
  // postprocessor drops these, bringing the conversion to BEST_EFFORT.
  Questionnaire: {
    fml: {
      coverage: COVERAGE.KNOWN_GAPS,
      description:
        'FML maps enableWhen answerUri straight through (invalid in R4) and '
        + 'leaves a malformed entry for answerAttachment; corrected by the '
        + 'Questionnaire_R3_to_R4 postprocessor.',
    },
    processors: [conv_R3_to_R4],
  },

  // Reviewed against the FHIR spec and the bundled mapping. STU3 and R4 share
  // every ValueSet element except STU3's `extensible`. The FML does not discard
  // it outright - it parks it in the inter-version extension
  // .../3.0/StructureDefinition/extension-ValueSet.extensible - but general R4
  // tools are not required to understand inter-version extensions, so a value
  // surviving only there counts as lost. The FML reports nothing about it, so
  // the postprocessor warns, bringing the conversion to BEST_EFFORT.
  ValueSet: {
    fml: {
      coverage: COVERAGE.KNOWN_GAPS,
      description:
        'FML maps all shared ValueSet content correctly but relegates STU3 '
        + 'extensible to an inter-version extension without a diagnostic, which '
        + 'general R4 tools need not understand; reported by the '
        + 'ValueSet_R3_to_R4 postprocessor.',
    },
    processors: [convValueSet_R3_to_R4],
  },
};

