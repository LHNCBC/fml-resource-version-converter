# Runtime data

This directory contains generated, compressed runtime artifacts. Do not edit
the artifact modules or `manifest.json` by hand.

The package uses two artifact families:

- `fml-mappings/` contains the FML text, resource-mapping catalog, and compact
  ConceptMaps required for each supported conversion direction.
- `fhir-tables/` contains the derived FHIR structure tables required by the
  conversion engine for DSTU2, STU3, R4, R4B, and R5.

Each JavaScript artifact is a dependency-free envelope containing identifying
metadata and a Base64-encoded deterministic zlib-wrapped DEFLATE payload.
`manifest.json` is the generated artifact index. Its independent
`components.fmlMappings` and `components.fhirTables` sections each record their
own generator, format, sources, hashes, and artifact entries. Builders replace
their complete owned section; the manifest is not source configuration.

`src/runtime/README.md` describes the envelope formats, the schema versions,
and which validation runs at publication time versus application startup.

## FHIR structure tables

The FHIR table artifacts are derived from StructureDefinition bundles in the
official HL7 FHIR publications. They contain:

- `polyPaths`, used to expand polymorphic fields such as
  `Observation.value[x]` into JSON names such as `valueQuantity`.
- `arrayPaths`, used when the FML text does not fully express whether a target
  JSON field must be an array.
- `elementTypes`, used to select shared type-conversion groups when source and
  target element types differ.
- `contentReferences`, used to find the definitions of elements a
  StructureDefinition describes only once and then reuses, such as the nested
  items of a `Questionnaire`. DSTU2 spells these `nameReference` and later
  versions spell them `contentReference`; both are normalized into this one
  table.
- `resourceTypes`, used to distinguish resources from datatypes when applying
  `create()` rules.

The single authoritative list of publications, URLs, archive paths, versions,
dates, licenses, and ZIP-internal bundle paths is
`data/fhir-spec-downloads/sources.yaml`. The downloader and builder both read
that file.

## Runtime data regeneration/maintenance

This data is generated from source datasets that are not published with the
package, using programs under `tools/` that are not in the published package,
either. See the repository-root `DATA-MAINTENANCE.md` for the build process and
every command, option, and default.
