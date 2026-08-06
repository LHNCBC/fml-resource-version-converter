# Changelog

This log documents the significant changes for each release.
This project follows [Semantic Versioning](http://semver.org/).

## [0.2.0] - 2026-08-06

### Added

- `chainedConverter.convert(resource, fromVer, toVer, opts?)`: a multi-hop
  conversion entry point that chains adjacent FML hops as needed (for example,
  R3 -> R5 runs as R3 -> R4 -> R5) and returns a per-hop `hops[]` report.
- Keyed pre-/postprocessor options (`preprocs` / `postprocs`) that target a
  specific resource type and hop, alongside the outer-boundary `preproc` /
  `postproc` options.
- The command-line runner (`bin/convert.js`) now handles multi-hop conversions
  and prints a per-hop diagnostics summary.
- `opts.targetResourceType` (and the `--target-resource-type` CLI option) to
  name the intended target type when there is ambiguity, such as
  `ServiceRequest` R4 -> R3. See [CONVERSION-AMBIGUITY.md](CONVERSION-AMBIGUITY.md)
  for the known ambiguous mappings.
- `CONVERSION-AMBIGUITY.md`, documenting the known mapping-selection
  ambiguities. One of them, `ProcedureRequest` R3 -> R2 targeting
  `DiagnosticOrder`, is served by two mapping files and cannot be run; it is
  listed under Limitations in `README.md`.

### Changed

- The FML engine now returns a conversion result envelope.
- The single-hop entry point `convertSingleHop(...)` is now the object method
  `singleHopConverter.convert(...)`; it returns the same flat result shape.
- Caller processor options were renamed and restructured: outer-boundary
  `preproc` / `postproc` and keyed `preprocs` / `postprocs`. The postprocessor
  combination policy now lives inside a postprocessor's configuration entry as
  `{ policy: 'append' | 'replace', psps: [...] }` (the standalone
  `postprocessPolicy` option was removed).
- The public API now checks its arguments up front - the resource shape, the
  version tokens, and the option types - and throws a clear error, instead of
  failing later with a confusing one.

### Fixed

- FML engine: multi-target `then` rules now process the intermediate
  targets (e.g. `tgt.A as t, t.B as tc then Group(s, tc)`) correctly.
- FML parser and engine: target list modes are now recognized:
  - `first`, `last`, and `single` are now handled correctly.
  - `share` and `collate` are not handled currently and diagnostic
    messages will be emitted if used - these modes have not been seen
    in the known mapping files and have no negative impact at this point.
- "log" clause is now fully supported.
- Backtick-delimited identifiers in bare paths are now supported.
- `create('X')` no longer adds a spurious `resourceType` to primitives and
  datatypes (e.g. `create('CodeableConcept')`).
- FML engine: datatype-internal array fields written through a type/`then`
  conversion (e.g. `Encounter.class.coding`, `PractitionerRole.contact.telecom`)
  are now correctly wrapped as arrays.
- Companion fields (the `_name` object that carries the `id` and extensions of a
  primitive value, such as `_status` for `status`) are now carried over
  correctly in a number of cases where they were previously dropped or
  misplaced.
- The converted resource no longer carries a stray `resourceType` on objects
  that are not resources.
- FML parser: fixed the tokenizing of a hyphen followed by a space, which could
  cause some rules to be misread.

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
