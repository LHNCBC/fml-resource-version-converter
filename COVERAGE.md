# Conversion Coverage

This document reports the package's conversion coverage for each FHIR resource type across the supported adjacent FHIR version pairs.

A conversion runs in up to three steps:

- **Preprocessing** (optional) - caller-supplied preprocessors may adjust the source resource before the FML mapping runs. The package supplies none, and preprocessors carry no coverage level, so they are not reported below.
- **FML mapping** - the FHIR Mapping Language (FML) mapping file is executed, handling most (sometimes all) data elements.
- **Postprocessing** (optional) - where the FML mapping falls short, one or more postprocessors may be used to refine the result and complete the conversion. At this point, the package only supplies postprocessors in very limited cases.

For each resource type, the tables report the coverage of the FML step, of the postprocessors (when any apply), and of the two combined as the overall coverage.

> _Generated file - do not edit by hand. Maintainers regenerate it with `npm run build:coverage` (see `tools/build-coverage.js` in the source repository)._

## Coverage levels

This report uses **not_reviewed**, **known_gaps**, **best_effort**, and **complete**. See [Coverage levels](README.md#coverage-levels) in `README.md` for definitions.

## Contents

- [R2 -> R3](#r2---r3)
- [R3 -> R2](#r3---r2)
- [R3 -> R4](#r3---r4)
- [R4 -> R3](#r4---r3)
- [R4 -> R5](#r4---r5)
- [R5 -> R4](#r5---r4)
- [R4B -> R5](#r4b---r5)
- [R5 -> R4B](#r5---r4b)

## R2 -> R3

| Resource | FML coverage | Postprocessor coverage | Overall coverage | Description |
| --- | --- | --- | --- | --- |
| Binary | complete | - | complete | **FML:** FML fully covers R2->R3 Binary conversion; no postprocessor needed. |
| _All other resource types_ | not_reviewed | - | not_reviewed | _Default: FML mapping not yet reviewed; no postprocessors._ |

## R3 -> R2

| Resource | FML coverage | Postprocessor coverage | Overall coverage | Description |
| --- | --- | --- | --- | --- |
| Binary | known_gaps | best_effort | best_effort | **FML:** FML maps shared Binary content but silently drops STU3 securityContext, which DSTU2 cannot represent; reported by the Binary_R3_to_R2 postprocessor.<br>**Binary_R3_to_R2:** Reports Binary.securityContext dropped because DSTU2 has no equivalent. Does not handle inter-version extensions. |
| _All other resource types_ | not_reviewed | - | not_reviewed | _Default: FML mapping not yet reviewed; no postprocessors._ |

## R3 -> R4

| Resource | FML coverage | Postprocessor coverage | Overall coverage | Description |
| --- | --- | --- | --- | --- |
| Binary | complete | - | complete | **FML:** FML fully covers R3->R4 Binary conversion; no postprocessor needed. |
| CodeSystem | complete | complete | complete | **FML:** FML maps every STU3 CodeSystem element to R4. The CodeSystem_R3_to_R4 postprocessor reports names that do not satisfy R4 warning invariant csd-0 without changing them.<br>**CodeSystem_R3_to_R4:** Reports STU3 names that do not satisfy R4 warning invariant csd-0 without rewriting the resource identifier. Does not handle inter-version extensions. |
| Library | known_gaps | best_effort | best_effort | **FML:** FML leaves R3/R4 Contributor, Reference-to-canonical, required type-code, LibraryType code-system canonical, and DataRequirement code-filter differences unresolved; repaired or reported by the Library_R3_to_R4 postprocessor.<br>**Library_R3_to_R4:** Rebuilds contributor buckets, repairs Reference-to-canonical fields, normalizes required ParameterDefinition and DataRequirement FHIR types and the LibraryType code system canonical, reports CodeableConcept detail lost from code filters and invalid contributors that cannot be bucketed, and reports R4 warning invariant lib-0. Does not handle inter-version extensions. |
| Questionnaire | known_gaps | best_effort | best_effort | **FML:** FML maps enableWhen answerUri straight through (invalid in R4) and leaves a malformed entry for answerAttachment; corrected by the Questionnaire_R3_to_R4 postprocessor.<br>**Questionnaire_R3_to_R4:** Drops Questionnaire enableWhen entries whose STU3 answer type (uri or Attachment) has no R4 equivalent, and sets enableBehavior "any" on items with multiple enableWhen (R4 que-12; matches STU3 implicit OR). Does not handle inter-version extensions. |
| ValueSet | known_gaps | best_effort | best_effort | **FML:** FML maps all shared ValueSet content correctly but relegates STU3 extensible to an inter-version extension without a diagnostic, which general R4 tools need not understand; reported by the ValueSet_R3_to_R4 postprocessor.<br>**ValueSet_R3_to_R4:** Reports STU3 ValueSet.extensible, which R4 can hold only as an inter-version extension and which general R4 tools are therefore not required to understand, and reports a name that does not satisfy R4's warning-severity vsd-0 invariant. Makes no changes. |
| _All other resource types_ | not_reviewed | - | not_reviewed | _Default: FML mapping not yet reviewed; no postprocessors._ |

## R4 -> R3

| Resource | FML coverage | Postprocessor coverage | Overall coverage | Description |
| --- | --- | --- | --- | --- |
| Binary | known_gaps | best_effort | best_effort | **FML:** FML maps Binary.data to content but does not supply the required STU3 primitive when optional R4 data is absent; repaired by the Binary_R4_to_R3 postprocessor. R4 Reference.type on securityContext has no STU3 equivalent and is not retained.<br>**Binary_R4_to_R3:** Marks required Binary.content absent with the standard data-absent-reason extension when the optional R4 data element is absent, rather than inventing payload data. R4 Reference.type on securityContext has no STU3 equivalent and is not retained. Does not handle inter-version extensions. |
| CodeSystem | known_gaps | best_effort | best_effort | **FML:** FML leaves R4-only canonical, supplement, and decimal CodeSystem differences unresolved; corrected or approximated with diagnostics by the CodeSystem_R4_to_R3 postprocessor. The identifier cardinality narrowing R4 -> R3 requires is enforced and reported by the engine. Reference-valued UsageContext entries are removed because STU3 cannot represent them.<br>**CodeSystem_R4_to_R3:** Removes canonical version pins, reports dropped supplements, approximates supplement content as fragment, and preserves decimal property values as strings with warnings. Removes Reference-valued UsageContext entries that STU3 cannot represent. Also narrows identifier cardinality defensively; the FML engine normally enforces and reports that narrowing already. Does not handle inter-version extensions. |
| Library | known_gaps | best_effort | best_effort | **FML:** FML leaves R4/R3 Contributor, canonical-to-Reference, required type-code, LibraryType code-system canonical, and DataRequirement narrowing unresolved and drops R4-only content silently; repaired or reported by the Library_R4_to_R3 postprocessor. Reference-valued UsageContext entries are removed because STU3 cannot represent them.<br>**Library_R4_to_R3:** Rebuilds valid R3 contributors, repairs canonical-to-Reference fields and DataRequirement narrowing, normalizes required ParameterDefinition and DataRequirement FHIR types and the LibraryType code system canonical, removes Reference-valued UsageContext entries, and reports R4-only content. Does not handle inter-version extensions. |
| Questionnaire | known_gaps | best_effort | best_effort | **FML:** FML emits a malformed options string, leaves invalid enableWhen for non-representable operators, drops answerOption.initialSelected, leaves an empty option entry for answerOption.valueReference, and keeps the last (not first) of multiple initial values; corrected by the Questionnaire_R4_to_R3 postprocessor. R4-only derivedFrom loss is reported, while enableBehavior is diagnosed where its removal can change conditional-display behavior. Reference-valued UsageContext entries are removed because STU3 cannot represent them.<br>**Questionnaire_R4_to_R3:** Corrects Questionnaire R4->R3 item fields from the R4 source: rebuilds enableWhen (dropping operators with no STU3 equivalent), fixes options to the STU3 Reference shape, and re-derives initial[x] from answerOption.initialSelected. Removes Reference-valued UsageContext entries. Warns when enableBehavior "all" cannot be represented in STU3 and when derivedFrom content is dropped. Does not handle inter-version extensions. |
| ValueSet | known_gaps | best_effort | best_effort | **FML:** FML copies filter.value and compose valueSet verbatim, so R4-valid values can land in STU3 as an invalid code or an unresolvable versioned reference; it does not supply the expansion identifier STU3 requires, leaves a metadata-only ValueSet in breach of vsd-5, and drops expansion parameter dateTime values without a diagnostic; corrected and reported by the ValueSet_R4_to_R3 postprocessor. Reference-valued UsageContext entries are removed because STU3 cannot represent them.<br>**ValueSet_R4_to_R3:** Normalizes compose filter values into valid STU3 codes (removing a filter whose value cannot be one), strips canonical version suffixes from compose valueSet references, generates the expansion identifier STU3 requires, generates an empty expansion when the source satisfies neither half of vsd-5, and reports expansion parameter dateTime values that STU3 cannot represent. Removes Reference-valued UsageContext entries. Does not handle inter-version extensions. |
| _All other resource types_ | not_reviewed | - | not_reviewed | _Default: FML mapping not yet reviewed; no postprocessors._ |

## R4 -> R5

| Resource | FML coverage | Postprocessor coverage | Overall coverage | Description |
| --- | --- | --- | --- | --- |
| Binary | complete | - | complete | **FML:** FML fully covers R4->R5 Binary conversion; no postprocessor needed. |
| CodeSystem | known_gaps | complete | complete | **FML:** FML maps every shared CodeSystem element but silently emits R4 supplements that omit CodeSystem.supplements, which R5 invariant csd-4 rejects; repaired by the CodeSystem_R4_to_R5 postprocessor.<br>**CodeSystem_R4_to_R5:** Marks CodeSystem.supplements absent with the standard data-absent-reason extension when an R4 code system supplement omits it, which R5 invariant csd-4 requires. The supplemented canonical cannot be derived from the source, so it is reported as unknown rather than invented. Does not handle inter-version extensions. |
| Library | known_gaps | best_effort | best_effort | **FML:** FML silently drops RelatedArtifact.url, leaves version-specific ParameterDefinition.type and DataRequirement.type FHIR type codes unchanged, and does not report R4 identity values that trip R5 warning invariants cnl-0 or cnl-1.<br>**Library_R4_to_R5:** Reports RelatedArtifact.url content dropped because R5 has no equivalent, normalizes ParameterDefinition and DataRequirement FHIR type changes and removes entries with unrepresentable types, and reports R4 names or URLs that do not satisfy R5 warning invariants cnl-0 and cnl-1. Does not handle inter-version extensions. |
| Questionnaire | known_gaps | complete | complete | **FML:** FML maps shared Questionnaire content but can emit exactly two enableWhen entries without the enableBehavior required by R5 que-12.<br>**Questionnaire_R4_to_R5:** Repairs R5 que-12 when an R4 Questionnaire has multiple enableWhen entries but no enableBehavior, using data-absent-reason rather than inventing all/any. |
| ValueSet | complete | - | complete | **FML:** FML fully covers R4->R5 ValueSet conversion; no postprocessor needed. |
| _All other resource types_ | not_reviewed | - | not_reviewed | _Default: FML mapping not yet reviewed; no postprocessors._ |

## R5 -> R4

| Resource | FML coverage | Postprocessor coverage | Overall coverage | Description |
| --- | --- | --- | --- | --- |
| Binary | complete | - | complete | **FML:** FML fully covers R5->R4 Binary conversion; no postprocessor needed. |
| CodeSystem | known_gaps | best_effort | best_effort | **FML:** FML maps shared CodeSystem content but drops R5-only elements and retains R5-only filter operators that do not conform to the R4 binding.<br>**CodeSystem_R5_to_R4:** Reports R5-only CodeSystem content dropped during R5->R4 conversion and removes R5-only filter operator codes with warnings, dropping a filter left without any operator. Does not handle inter-version extensions. |
| Library | known_gaps | best_effort | best_effort | **FML:** FML silently drops R5-only Library and nested datatype content and preserves version-specific ParameterDefinition.type, DataRequirement.type, and RelatedArtifact.type codes that do not conform to R4 required bindings.<br>**Library_R5_to_R4:** Reports R5-only Library content and nested Attachment, DataRequirement, and RelatedArtifact content, normalizes ParameterDefinition and DataRequirement FHIR type changes and removes entries with unrepresentable types, and drops related artifacts whose required R5 relationship type has no R4 code. Does not handle inter-version extensions. |
| Questionnaire | known_gaps | best_effort | best_effort | **FML:** FML mis-narrows item.type (over-produces open-choice) and emits a malformed type object, and silently drops R5-only Questionnaire content; corrected and reported by the Questionnaire_R5_to_R4 postprocessor.<br>**Questionnaire_R5_to_R4:** Corrects Questionnaire item.type for R5->R4 (coding/answerConstraint -> choice/open-choice) from the R5 source, fixing the FML step's malformed and over-widened narrowing. Reports dropped R5-only versionAlgorithm[x], copyrightLabel, and nested item.disabledDisplay content. Also reused verbatim by R5->R4B. Does not handle inter-version extensions. |
| ValueSet | known_gaps | best_effort | best_effort | **FML:** FML maps shared ValueSet content but drops R5-only elements and retains R5-only filter operators that do not conform to the R4 binding.<br>**ValueSet_R5_to_R4:** Reports R5-only ValueSet content dropped during R5->R4 conversion and approximates R5-only filter operators as descendent-of with warnings. Does not handle inter-version extensions. |
| _All other resource types_ | not_reviewed | - | not_reviewed | _Default: FML mapping not yet reviewed; no postprocessors._ |

## R4B -> R5

| Resource | FML coverage | Postprocessor coverage | Overall coverage | Description |
| --- | --- | --- | --- | --- |
| Binary | complete | - | complete | **FML:** FML fully covers R4B->R5 Binary conversion; no postprocessor needed. |
| CodeSystem | known_gaps | complete | complete | **FML:** FML maps every shared CodeSystem element but silently emits R4B supplements that omit CodeSystem.supplements, which R5 invariant csd-4 rejects; repaired by the CodeSystem_R4B_to_R5 postprocessor.<br>**CodeSystem_R4B_to_R5:** Marks CodeSystem.supplements absent with the standard data-absent-reason extension when an R4B code system supplement omits it, which R5 invariant csd-4 requires. The supplemented canonical cannot be derived from the source, so it is reported as unknown rather than invented. Reuses the R4->R5 transform. Does not handle inter-version extensions. |
| Library | known_gaps | best_effort | best_effort | **FML:** FML silently drops RelatedArtifact.url, leaves version-specific ParameterDefinition.type and DataRequirement.type FHIR type codes unchanged, and does not report R4B identity values that trip R5 warning invariants cnl-0 or cnl-1.<br>**Library_R4B_to_R5:** Reports RelatedArtifact.url content dropped because R5 has no equivalent and reports R4B names or URLs that do not satisfy R5 warning invariants cnl-0 and cnl-1, and normalizes or removes ParameterDefinition and DataRequirement FHIR types that changed across the hop. Reuses the R4->R5 transform. Does not handle inter-version extensions. |
| Questionnaire | complete | - | complete | **FML:** FML fully covers R4B->R5 for valid input; no postprocessor needed. |
| ValueSet | complete | - | complete | **FML:** FML fully covers R4B->R5 ValueSet conversion; no postprocessor needed. |
| _All other resource types_ | not_reviewed | - | not_reviewed | _Default: FML mapping not yet reviewed; no postprocessors._ |

## R5 -> R4B

| Resource | FML coverage | Postprocessor coverage | Overall coverage | Description |
| --- | --- | --- | --- | --- |
| Binary | complete | - | complete | **FML:** FML fully covers R5->R4B Binary conversion; no postprocessor needed. |
| CodeSystem | known_gaps | best_effort | best_effort | **FML:** FML maps shared CodeSystem content but drops R5-only elements and retains R5-only filter operators that do not conform to the R4B binding.<br>**CodeSystem_R5_to_R4B:** Reports R5-only CodeSystem content dropped during R5->R4B conversion and removes R5-only filter operator codes with warnings, dropping a filter left without any operator. Reuses the R5->R4 transform. Does not handle inter-version extensions. |
| Library | known_gaps | best_effort | best_effort | **FML:** FML silently drops R5-only Library and nested datatype content and preserves version-specific ParameterDefinition.type, DataRequirement.type, and RelatedArtifact.type codes that do not conform to R4B required bindings.<br>**Library_R5_to_R4B:** Reports R5-only Library content and nested Attachment, DataRequirement, and RelatedArtifact content, normalizes or removes version-specific ParameterDefinition and DataRequirement FHIR types, and drops related artifacts whose R5-only relationship type is invalid in R4B. Reuses the R5->R4 transform. Does not handle inter-version extensions. |
| Questionnaire | known_gaps | best_effort | best_effort | **FML:** FML mis-narrows item.type (malformed wrapped primitive and over-widened open-choice) and silently drops R5-only Questionnaire content; corrected and reported by the Questionnaire_R5_to_R4B postprocessor.<br>**Questionnaire_R5_to_R4B:** Corrects Questionnaire item.type for R5->R4B (coding/answerConstraint -> choice/open-choice) from the R5 source, fixing the FML step's malformed and over-widened narrowing, and reports dropped R5-only content. Reuses the R5->R4 transform. Does not handle inter-version extensions. |
| ValueSet | known_gaps | best_effort | best_effort | **FML:** FML maps shared ValueSet content but drops R5-only elements and retains R5-only filter operators that do not conform to the R4B binding.<br>**ValueSet_R5_to_R4B:** Reports R5-only ValueSet content dropped during R5->R4B conversion and approximates R5-only filter operators as descendent-of with warnings. Reuses the R5->R4 transform. Does not handle inter-version extensions. |
| _All other resource types_ | not_reviewed | - | not_reviewed | _Default: FML mapping not yet reviewed; no postprocessors._ |
