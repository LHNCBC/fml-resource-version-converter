# Changelog

This log documents the significant changes for each release.
This project follows [Semantic Versioning](http://semver.org/).

## [0.1.0] - 2026-07-20

Initial release of the FML-based FHIR resource version converter.

This project evolved from
[questionnaire-version-converter](https://github.com/LHNCBC/questionnaire-version-converter)
(now deprecated), which was a hand-rolled converter for FHIR Questionnaire
resources.

This new project is a general FHIR resource version converter that is designed
to work for all FHIR resource types. It is based on the FML (FHIR Mapping Language)
mapping files from HL7 and its extensible architecture allows postprocessors to be
added incrementally and cleanly to handle cases where the FML mapping is incomplete.

### Highlights

- FML (FHIR Mapping Language) conversion engine that executes the HL7 fhir-cross-version
  mapping files to convert a FHIR resource of any covered type across one adjacent version
  hop. Available via the `./fml-engine` entry point for advanced use.
- A public API for converting a FHIR resource between adjacent FHIR versions, returning the
  converted resource together with a coverage level, a runtime status, and diagnostic
  messages.
- Postprocessor framework for plugging in postprocessors that correct or complete a
  conversion where the FML mapping is incomplete: a processor contract, a package registry,
  and coverage / diagnostics primitives. Callers may also supply their own pre- and postprocessors.
- Questionnaire postprocessors for conversions: R3 <-> R4, R4 <-> R5, and R4B <-> R5.
- A postprocessor registry that records, for each resource type and version pair, the FML
  mapping's coverage and the applicable postprocessors, giving a clear and reviewable
  picture of each conversion's coverage status.
- A generated conversion coverage report (`COVERAGE.md`), produced from the registry via
  `npm run build`.
- A simple command-line runner (`bin/convert.js`) for single-hop conversions.
