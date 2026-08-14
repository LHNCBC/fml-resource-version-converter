/**
 * @fileoverview Postprocessor registry for the R3 -> R4 direction.
 *
 * Maps FHIR resource type name -> registry entry for R3 -> R4 conversions.
 * See CONTRIBUTING.md for the registry workflow and entry examples.
 *
 * @module postprocessors/R3_R4/registry_R3_to_R4
 */
import { COVERAGE } from '../../converter/coverage.js';
import { conv_R3_to_R4 as convCodeSystem_R3_to_R4 } from './CodeSystem.js';
import { conv_R3_to_R4 as convLibrary_R3_to_R4 } from './Library.js';
import { conv_R3_to_R4 } from './Questionnaire.js';
import { conv_R3_to_R4 as convValueSet_R3_to_R4 } from './ValueSet.js';

// Final cumulative coverage per conversion is generated into COVERAGE.md,
// derived from each entry's fml.coverage and its postprocessors' coverage.
export const registry = {
  // Reviewed against the FHIR spec and bundled mapping. The FML renames the
  // required STU3 content primitive to R4 data and maps every other element.
  // R4 makes data optional, which requires no value to be invented in this
  // widening direction.
  Binary: {
    fml: {
      coverage: COVERAGE.COMPLETE,
      description: 'FML fully covers R3->R4 Binary conversion; no postprocessor needed.',
    },
    processors: [],
  },

  // Reviewed against the FHIR spec and bundled mapping. R4 is an element-wise
  // superset of STU3 for CodeSystem, and the FML maps every STU3 element. R4
  // adds warning-severity invariant csd-0 for `name`; STU3 has no equivalent,
  // so the postprocessor reports a nonconforming name without rewriting this
  // externally significant identifier. Because csd-0 is advisory and no data
  // is lost or approximated, conversion coverage remains COMPLETE even when a
  // particular conversion has warning status.
  CodeSystem: {
    fml: {
      coverage: COVERAGE.COMPLETE,
      description:
        'FML maps every STU3 CodeSystem element to R4. The CodeSystem_R3_to_R4 '
        + 'postprocessor reports names that do not satisfy R4 warning invariant '
        + 'csd-0 without changing them.',
    },
    processors: [convCodeSystem_R3_to_R4],
  },

  // Reviewed against Library and the embedded Contributor,
  // ParameterDefinition, DataRequirement, and RelatedArtifact mappings. The
  // FML loses Contributor structure, emits malformed Reference/canonical
  // companions, leaves required version-specific type codes and the LibraryType
  // code system canonical unchanged, and flattens CodeableConcept values without
  // reporting their non-Coding content. The postprocessor repairs representable
  // content and reports the remainder.
  Library: {
    fml: {
      coverage: COVERAGE.KNOWN_GAPS,
      description:
        'FML leaves R3/R4 Contributor, Reference-to-canonical, required type-code, '
        + 'LibraryType code-system canonical, and DataRequirement code-filter differences '
        + 'unresolved; repaired or reported by the Library_R3_to_R4 postprocessor.',
    },
    processors: [convLibrary_R3_to_R4],
  },

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
