/**
 * @fileoverview Postprocessor registry for the R4 -> R3 direction.
 *
 * Maps FHIR resource type name -> registry entry for R4 -> R3 conversions.
 * See CONTRIBUTING.md for the registry workflow and entry examples.
 *
 * @module postprocessors/R3_R4/registry_R4_to_R3
 */
import { COVERAGE } from '../../converter/coverage.js';
import { conv_R4_to_R3 } from './Questionnaire.js';

// Final cumulative coverage per conversion is generated into COVERAGE.md,
// derived from each entry's fml.coverage and its postprocessors' coverage.
export const registry = {
  // FML alone has KNOWN_GAPS for R4->R3: it emits a malformed options string
  // (instead of the STU3 Reference), leaves invalid enableWhen entries for
  // operators with no STU3 equivalent, drops answerOption.initialSelected,
  // leaves an empty option entry for answerOption.valueReference, and lets the
  // last value win when reducing R4's 0..* initial to STU3's single initial[x].
  // The postprocessor corrects these from the R4 source where possible,
  // bringing the conversion to BEST_EFFORT. Inter-version-extension include is
  // deferred (see the design documents, "Inter-version extensions").
  Questionnaire: {
    fml: {
      coverage: COVERAGE.KNOWN_GAPS,
      description:
        'FML emits a malformed options string, leaves invalid enableWhen for '
        + 'non-representable operators, drops answerOption.initialSelected, '
        + 'leaves an empty option entry for answerOption.valueReference, and '
        + 'keeps the last (not first) of multiple initial values; corrected by '
        + 'the Questionnaire_R4_to_R3 postprocessor. Some R4-only data elements '
        + '(e.g. derivedFrom, enableBehavior) have no R3 mapping and are dropped.',
    },
    processors: [conv_R4_to_R3],
  },
};

