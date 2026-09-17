/**
 * @fileoverview Postprocessor registry for the R4 -> R3 direction.
 *
 * Maps FHIR resource type name -> registry entry for R4 -> R3 conversions.
 * See CONTRIBUTING.md for the registry workflow and entry examples.
 *
 * @module postprocessors/R3_R4/registry_R4_to_R3
 */
import { COVERAGE } from '../../converter/coverage.js';
import { conv_R4_to_R3 as convBinary_R4_to_R3 } from './Binary.js';
import { conv_R4_to_R3 as convCodeSystem_R4_to_R3 } from './CodeSystem.js';
import { conv_R4_to_R3 as convLibrary_R4_to_R3 } from './Library.js';
import { conv_R4_to_R3 } from './Questionnaire.js';
import { conv_R4_to_R3 as convValueSet_R4_to_R3 } from './ValueSet.js';

// Final cumulative coverage per conversion is generated into COVERAGE.md,
// derived from each entry's fml.coverage and its postprocessors' coverage.
export const registry = {
  // Reviewed against the FHIR spec and bundled mapping. R4 data is optional,
  // but the corresponding STU3 content primitive is required. When the source
  // has no payload, the FML leaves invalid STU3 output; the postprocessor marks
  // content absent with data-absent-reason rather than inventing data. R4
  // Reference.type on securityContext has no STU3 equivalent, so final
  // coverage is BEST_EFFORT even though the converted Reference remains valid.
  Binary: {
    fml: {
      coverage: COVERAGE.KNOWN_GAPS,
      description:
        'FML maps Binary.data to content but does not supply the required STU3 '
        + 'primitive when optional R4 data is absent; repaired by the '
        + 'Binary_R4_to_R3 postprocessor. R4 Reference.type on securityContext '
        + 'has no STU3 equivalent and is not retained.',
    },
    processors: [convBinary_R4_to_R3],
  },

  // Reviewed against the FHIR spec and bundled mapping. The FML does not
  // implement identifier cardinality narrowing, canonical-to-uri version
  // normalization, or the R4-only supplements/content and decimal-property
  // differences. The postprocessor keeps the first identifier, removes
  // canonical version pins, reports supplements loss, approximates supplement
  // content as fragment, and preserves decimal lexical values as strings.
  // Supplement and numeric semantics cannot be retained in STU3, so final
  // coverage is BEST_EFFORT.
  CodeSystem: {
    fml: {
      coverage: COVERAGE.KNOWN_GAPS,
      description:
        'FML leaves R4-only canonical, supplement, and decimal CodeSystem '
        + 'differences unresolved; corrected or approximated with diagnostics '
        + 'by the CodeSystem_R4_to_R3 postprocessor. The identifier cardinality '
        + 'narrowing R4 -> R3 requires is enforced and reported by the engine. '
        + 'Reference-valued UsageContext entries are removed because STU3 cannot '
        + 'represent them.',
    },
    processors: [convCodeSystem_R4_to_R3],
  },

  // Reviewed against Library and the embedded Contributor,
  // ParameterDefinition, DataRequirement, and RelatedArtifact mappings. The
  // FML emits Contributors without their required name, omits or malforms
  // canonical-to-Reference fields, leaves required version-specific type codes
  // and the LibraryType code system canonical unchanged, and silently drops
  // R4-only content. The postprocessor repairs representable content and reports
  // unavoidable loss.
  Library: {
    fml: {
      coverage: COVERAGE.KNOWN_GAPS,
      description:
        'FML leaves R4/R3 Contributor, canonical-to-Reference, required type-code, '
        + 'LibraryType code-system canonical, and DataRequirement narrowing unresolved and '
        + 'drops R4-only content silently; repaired or reported by the '
        + 'Library_R4_to_R3 postprocessor. Reference-valued UsageContext entries are removed '
        + 'because STU3 cannot represent them.',
    },
    processors: [convLibrary_R4_to_R3],
  },

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
        + 'the Questionnaire_R4_to_R3 postprocessor. R4-only derivedFrom loss is '
        + 'reported, while enableBehavior is diagnosed where its removal can '
        + 'change conditional-display behavior. Reference-valued UsageContext '
        + 'entries are removed because STU3 cannot represent them.',
    },
    processors: [conv_R4_to_R3],
  },

  // Reviewed against the FHIR spec. No R4 ValueSet element was added relative
  // to STU3, but four narrowings pass through the FML unreported: filter.value
  // (string -> code) can carry whitespace that is invalid as an STU3 code,
  // compose.include.valueSet (canonical -> uri) can pin a |version that STU3
  // cannot resolve, expansion.identifier is 0..1 in R4 but 1..1 in STU3, and
  // expansion.parameter valueDateTime has no STU3 type (the mapping comments
  // that rule out). STU3 also adds vsd-5 (a ValueSet needs a compose or an
  // expansion), which a metadata-only R4 source would violate. The
  // postprocessor repairs everything except the dropped dateTime, which it
  // reports. BEST_EFFORT.
  ValueSet: {
    fml: {
      coverage: COVERAGE.KNOWN_GAPS,
      description:
        'FML copies filter.value and compose valueSet verbatim, so R4-valid '
        + 'values can land in STU3 as an invalid code or an unresolvable '
        + 'versioned reference; it does not supply the expansion identifier '
        + 'STU3 requires, leaves a metadata-only ValueSet in breach of vsd-5, '
        + 'and drops expansion parameter dateTime values without a diagnostic; '
        + 'corrected and reported by the ValueSet_R4_to_R3 postprocessor. '
        + 'Reference-valued UsageContext entries are removed because STU3 cannot '
        + 'represent them.',
    },
    processors: [convValueSet_R4_to_R3],
  },
};
