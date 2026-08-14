/**
 * @fileoverview Postprocessor registry for the R4 -> R5 direction.
 *
 * Maps FHIR resource type name -> registry entry for R4 -> R5 conversions.
 * See CONTRIBUTING.md for the registry workflow and entry examples.
 *
 * @module postprocessors/R4_R5/registry_R4_to_R5
 */
import { COVERAGE } from '../../converter/coverage.js';
import { conv_R4_to_R5 as convCodeSystem_R4_to_R5 } from './CodeSystem.js';
import { conv_R4_to_R5 as convLibrary_R4_to_R5 } from './Library.js';

// Final cumulative coverage per conversion is generated into COVERAGE.md,
// derived from each entry's fml.coverage and its postprocessors' coverage.
export const registry = {
  // Binary has the same element set and cardinalities in R4 and R5. The FML
  // maps every element directly, including data and primitive companions.
  Binary: {
    fml: {
      coverage: COVERAGE.COMPLETE,
      description: 'FML fully covers R4->R5 Binary conversion; no postprocessor needed.',
    },
    processors: [],
  },

  // Reviewed and determined that the FML mapping fully performs the Questionnaire
  // R4->R5 conversion for valid input, including item type
  // choice/open-choice -> coding with the appropriate answerConstraint.
  Questionnaire: {
    fml: {
      coverage: COVERAGE.COMPLETE,
      description: 'FML fully covers R4->R5 for valid input; no postprocessor needed.',
    },
    processors: [],
  },

  // The R4->R5 FML maps every shared ValueSet element. R5-only additions do
  // not require values to be invented, and no resource postprocessor is needed.
  ValueSet: {
    fml: {
      coverage: COVERAGE.COMPLETE,
      description: 'FML fully covers R4->R5 ValueSet conversion; no postprocessor needed.',
    },
    processors: [],
  },

  // Reviewed against the FHIR spec. R5 is an element-wise superset of R4 for
  // CodeSystem (66 of 77 paths shared, none removed or restructured), so the FML
  // carries everything over. One incompatibility is not element-level: R4 allows
  // content = "supplement" without CodeSystem.supplements, which R5 rejects via
  // invariant csd-4, so the FML step alone emits invalid R5. The supplemented
  // code system is not identified anywhere in the source, so the postprocessor
  // marks supplements absent with the standard data-absent-reason extension -
  // FHIR lets an extension stand in place of a primitive value, so the element
  // exists for csd-4 without asserting a canonical the source never carried.
  // That keeps the output valid and truthful, so the conversion is COMPLETE;
  // the accompanying warning tells the caller to substitute the real canonical.
  CodeSystem: {
    fml: {
      coverage: COVERAGE.KNOWN_GAPS,
      description:
        'FML maps every shared CodeSystem element but silently emits R4 supplements '
        + 'that omit CodeSystem.supplements, which R5 invariant csd-4 rejects; repaired '
        + 'by the CodeSystem_R4_to_R5 postprocessor.',
    },
    processors: [convCodeSystem_R4_to_R5],
  },

  // Reviewed against Library plus the Attachment, DataRequirement, and
  // RelatedArtifact structures it embeds. The FML silently drops
  // RelatedArtifact.url: R5 retains the independent canonical resource field
  // but has no equivalent for the general artifact-access URL, and redirecting
  // it there would conflate two fields an R4 entry may carry at once. Its
  // generic type ConceptMap also does not cover renamed or removed resource
  // names used by ParameterDefinition.type and DataRequirement.type. R5 also
  // tightens warning invariants cnl-0 and cnl-1 for canonical resource identity.
  // The postprocessor applies exact resource renames and reviewed datatype
  // approximations, removes entries that cannot conform, and reports the
  // remaining losses and incompatibilities.
  Library: {
    fml: {
      coverage: COVERAGE.KNOWN_GAPS,
      description:
        'FML silently drops RelatedArtifact.url, leaves version-specific '
        + 'ParameterDefinition.type and DataRequirement.type FHIR type codes unchanged, and '
        + 'does not report R4 identity values that trip R5 warning invariants cnl-0 or cnl-1.',
    },
    processors: [convLibrary_R4_to_R5],
  },
};
