# Changelog

This log documents the significant changes for each release.
This project follows [Semantic Versioning](http://semver.org/).

## [Unreleased]

### Added

- Completed the onboarding (review/postprocessors) for:
  - Binary: R2 <-> R3, R3 <-> R4, R4 <-> R5, and R4B <-> R5.
  - CodeSystem: R3 <-> R4, R4 <-> R5, and R4B <-> R5.
  - Library: R3 <-> R4, R4 <-> R5, and R4B <-> R5.
  - ValueSet: R3 <-> R4, R4 <-> R5, and R4B <-> R5.
- Added a few reusable functions, e.g., `removePrimitiveArrayEntries()`.
- Added the browser-safe helper `randomUuid()` in `postprocessors/util/uuid.js`,
  so postprocessors can generate a `urn:uuid:` identifier without Node built-ins.
- `CONTRIBUTING.md` guidance on handling a target version that adds a constraint
  the source does not have.

### Fixed

- Imported FML base groups now take precedence over the engine's compatibility
  copiers during group inheritance for faithful FML mapping execution. The
  R3/R4 Extension mappings now preserve the shared `valueMeta` choice in
  ordinary extensions.
- Target base-profile insertion now handles extension-only `meta.profile`
  occurrences while keeping the parallel `profile` and `_profile` arrays
  correctly aligned.
- A `meta.profile` entry naming a base profile of a FHIR version other than the
  hop's source or target is dropped, as before, but any `id` or extensions that
  entry carried in `meta._profile` were dropped with it silently. That content
  loss is now reported as a warning.
- R4 -> R3 Questionnaire conversions now remove Reference-valued UsageContext
  entries that STU3 cannot represent, preserving valid output and warning
  about the lost applicability context.
- R4 -> R5 Questionnaire conversion now repairs the two-`enableWhen` que-12
  invariant gap without guessing `enableBehavior` semantics.
- Questionnaire downgrades now warn when R5-only `versionAlgorithm[x]`,
  `copyrightLabel`, or nested `item.disabledDisplay` content is dropped on the
  way to R4/R4B, and when R4 `derivedFrom` content is dropped on the way to R3.
- FML engine schema metadata now resolves through StructureDefinition
  `contentReference` paths, preserving typed polymorphic names, primitive
  companions, scalar types, and cardinality below recursive backbone elements
  such as nested `Questionnaire.item` nodes. DSTU2 predates
  `contentReference` and expresses the same relationship as `nameReference`;
  both spellings are now derived into the same runtime table, so DSTU2
  resolves recursive elements such as nested `Questionnaire.group` nodes too.
- The FML engine now honors a single-valued (`max = 1`) target element when a
  repeating source element maps onto it. Previously the converted resource
  could carry a JSON array in a field the target version defines as a single
  value, for example `Questionnaire.group` when converting R3 -> R2. The first
  value is kept and any dropped values are reported.
- An FML rule whose repeating source feeds several independent targets, such as
  `src.items where (...) -> tgt.first, tgt.second`, now fills every target
  instead of only the first. Each target gets its own values, primitive
  companions, default-group selection, polymorphic name, and cardinality
  enforcement, while the source `where`, `check`, and `log` clauses are still
  evaluated once per source item.

## [0.3.0] - 2026-09-08

### Added

- Added the `./converter-factory` entry point, directional runtime
  data entry points under `./runtime/`, and the complete `./runtime/all`
  entry point for synchronous Node and browser use.
- Added deterministic compressed runtime artifacts, provenance validation,
  alternate-root maintainer tooling, and package-content validation.
- Added strictly validated `sources.yaml` datasets, independent in-place FML and
  FHIR component build commands that default to `data/runtime`, symmetric
  component and complete-root copy tooling, and explicit runtime-root and
  component-selectable freshness checks.
- Added `DATA-MAINTENANCE.md`, moving data maintenance instructions out of
  `CONTRIBUTING.md`.

### Changed

- The default converters and low-level FML engine now use committed in-memory
  runtime artifacts instead of reading raw data files. The default package
  entry still loads all supported runtime data modules.
- Importing the default package entry now decodes all runtime data up front, so
  it costs more time and memory than in 0.2.x, while the first and subsequent
  conversions are faster. Applications that need only some version directions,
  especially browser applications, should import `./converter-factory` with the
  directional `./runtime/*` entry points instead.
- Mapping descriptors returned by the low-level engine now expose the portable
  root-relative `virtualFile` field instead of the filesystem-only `filePath`,
  for use in diagnostic messages.
- Missing standalone ConceptMaps now fail runtime artifact generation. Strict
  conversion still rejects missing or unmappable translations, but no longer
  performs a separate filesystem-resolution check during engine construction.
- The npm package now excludes the raw fhir-cross-version snapshot, FHIR
  specification inputs, and generated definition intermediates.
- The runtime manifest now keeps FML mapping and FHIR table sources and
  artifacts in separate, independently managed sections. FHIR tables are
  derived directly from the declared specification ZIP entries without a
  persistent intermediate.

### Removed

- Removed the `xverInputRoot` runtime option. Repository maintainers can load
  alternate mapping roots with the internal Node-only loader, then bind the
  loaded runtime data with the public `converterFactory` entry point.
- Removed unsupported raw package data paths from the published package.
- Removed the retired `data/fhir-defs/` build path and the separate
  cross-version `source.json` and `SOURCE.md` metadata files.

## [0.2.2] - 2026-08-20

### Changed

- Documentation: reviewed and cleaned up `README.md` and related docs for
  clarity and consistency.
- Examples: `examples/conversions.js` is now self-contained - it uses inline
  resources instead of test fixtures, imports the package by its published name,
  prints an input/output diff of what the conversion changed, and shows how to
  read the result objects.
- Added more npm package keywords to improve discoverability.

## [0.2.1] - 2026-08-19
### Added
- Added SECURITY.md

## [0.2.0] - 2026-08-13

### Added

- `chainedConverter.convert(resource, fromVer, toVer, opts?)`: a multi-hop
  conversion entry point that chains adjacent FML hops as needed (for example,
  R3 -> R5 runs as R3 -> R4 -> R5) and returns a per-hop `hops[]` report.
- Keyed pre-/postprocessor options (`preprocs` / `postprocs`) that target a
  specific resource type and hop, alongside the outer-boundary `preproc` /
  `postproc` options.
- The command-line runner (`bin/convert.js`) now handles multi-hop conversions
  and prints a per-hop diagnostics summary.
- `opts.targetResourceType` on `singleHopConverter.convert()` (and the
  `--target-resource-type` CLI option for single-hop conversion) to select an
  ambiguous target, such as `ServiceRequest` R4 -> R3. See
  [CONVERSION-AMBIGUITY.md](CONVERSION-AMBIGUITY.md) for known ambiguities.
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
- `singleHopConverter.convert()` now rejects a non-adjacent version pair up
  front, pointing to `chainedConverter.convert()`, instead of failing later with
  a less obvious error.
- `chainedConverter.convert()` now rejects `opts.targetResourceType` instead of
  silently ignoring it. Target selection currently only applies to one hop.

### Fixed

- A single (unkeyed) `postproc` was silently skipped on the last hop when an
  earlier hop renamed the resource type (for example `Sequence` R3 ->
  `MolecularSequence` R4); it now runs as documented.
- A keyed `preprocs` / `postprocs` entry whose resource type does not enter its
  hop (typically a misspelled type such as `Questionaire:R4->R5`) was silently
  ignored; it is now rejected with an error before that hop runs, naming the
  resource type entering the hop.
- FML engine: multi-target `then` rules now process the intermediate
  targets (e.g. `tgt.A as t, t.B as tc then Group(s, tc)`) correctly.
- FML parser: target list modes (`first`, `last`, `single`, `share`, and
  `collate`) are now recognized. Their semantics are not yet faithfully
  supported by the engine; it preserves produced values using a provisional
  append fallback and emits a diagnostic when a target list mode is used. The
  only known bundled case is HealthcareService R3 -> R2, where each specialty
  may become a separate `serviceType` without its required `type`, producing
  invalid DSTU2 output.
- "log" clause is now fully supported.
- Source-only array `then` rules now emit their per-item `check` warnings and
  `log` diagnostics consistently with other rule forms.
- Source type hints on fixed fields no longer make the engine look for a
  nonexistent polymorphic JSON name (for example, `Attachment.size :
  unsignedInt` now reads `size`, not `sizeUnsignedInt`).
- Target `integer64` and `unsignedInt` primitives are now converted to their
  required FHIR JSON representations and range-checked without clamping.
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
