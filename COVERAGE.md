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
| _All other resource types_ | not_reviewed | - | not_reviewed | _Default: FML mapping not yet reviewed; no postprocessors._ |

## R3 -> R2

| Resource | FML coverage | Postprocessor coverage | Overall coverage | Description |
| --- | --- | --- | --- | --- |
| _All other resource types_ | not_reviewed | - | not_reviewed | _Default: FML mapping not yet reviewed; no postprocessors._ |

## R3 -> R4

| Resource | FML coverage | Postprocessor coverage | Overall coverage | Description |
| --- | --- | --- | --- | --- |
| Questionnaire | known_gaps | best_effort | best_effort | **FML:** FML maps enableWhen answerUri straight through (invalid in R4) and leaves a malformed entry for answerAttachment; corrected by the Questionnaire_R3_to_R4 postprocessor.<br>**Questionnaire_R3_to_R4:** Drops Questionnaire enableWhen entries whose STU3 answer type (uri or Attachment) has no R4 equivalent, and sets enableBehavior "any" on items with multiple enableWhen (R4 que-12; matches STU3 implicit OR). Does not handle inter-version extensions. |
| _All other resource types_ | not_reviewed | - | not_reviewed | _Default: FML mapping not yet reviewed; no postprocessors._ |

## R4 -> R3

| Resource | FML coverage | Postprocessor coverage | Overall coverage | Description |
| --- | --- | --- | --- | --- |
| Questionnaire | known_gaps | best_effort | best_effort | **FML:** FML emits a malformed options string, leaves invalid enableWhen for non-representable operators, drops answerOption.initialSelected, leaves an empty option entry for answerOption.valueReference, and keeps the last (not first) of multiple initial values; corrected by the Questionnaire_R4_to_R3 postprocessor. Some R4-only data elements (e.g. derivedFrom, enableBehavior) have no R3 mapping and are dropped.<br>**Questionnaire_R4_to_R3:** Corrects Questionnaire R4->R3 item fields from the R4 source: rebuilds enableWhen (dropping operators with no STU3 equivalent), fixes options to the STU3 Reference shape, and re-derives initial[x] from answerOption.initialSelected. Warns when enableBehavior "all" cannot be represented in STU3. Does not handle inter-version extensions. |
| _All other resource types_ | not_reviewed | - | not_reviewed | _Default: FML mapping not yet reviewed; no postprocessors._ |

## R4 -> R5

| Resource | FML coverage | Postprocessor coverage | Overall coverage | Description |
| --- | --- | --- | --- | --- |
| Questionnaire | complete | - | complete | **FML:** FML fully covers R4->R5 for valid input; no postprocessor needed. |
| _All other resource types_ | not_reviewed | - | not_reviewed | _Default: FML mapping not yet reviewed; no postprocessors._ |

## R5 -> R4

| Resource | FML coverage | Postprocessor coverage | Overall coverage | Description |
| --- | --- | --- | --- | --- |
| Questionnaire | known_gaps | best_effort | best_effort | **FML:** FML mis-narrows item.type (over-produces open-choice) and emits a malformed type object; corrected by the Questionnaire_R5_to_R4 postprocessor.<br>**Questionnaire_R5_to_R4:** Corrects Questionnaire item.type for R5->R4 (coding/answerConstraint -> choice/open-choice) from the R5 source, fixing the FML step's malformed and over-widened narrowing. Also reused verbatim by R5->R4B (R4B is identical to R4 for Questionnaire.item). Does not handle inter-version extensions. |
| _All other resource types_ | not_reviewed | - | not_reviewed | _Default: FML mapping not yet reviewed; no postprocessors._ |

## R4B -> R5

| Resource | FML coverage | Postprocessor coverage | Overall coverage | Description |
| --- | --- | --- | --- | --- |
| Questionnaire | complete | - | complete | **FML:** FML fully covers R4B->R5 for valid input; no postprocessor needed. |
| _All other resource types_ | not_reviewed | - | not_reviewed | _Default: FML mapping not yet reviewed; no postprocessors._ |

## R5 -> R4B

| Resource | FML coverage | Postprocessor coverage | Overall coverage | Description |
| --- | --- | --- | --- | --- |
| Questionnaire | known_gaps | best_effort | best_effort | **FML:** FML mis-narrows item.type (malformed wrapped primitive and over-widened open-choice); corrected by the Questionnaire_R5_to_R4B postprocessor.<br>**Questionnaire_R5_to_R4B:** Corrects Questionnaire item.type for R5->R4B (coding/answerConstraint -> choice/open-choice) from the R5 source, fixing the FML step's malformed and over-widened narrowing. Reuses the R5->R4 transform. Does not handle inter-version extensions. |
| _All other resource types_ | not_reviewed | - | not_reviewed | _Default: FML mapping not yet reviewed; no postprocessors._ |
