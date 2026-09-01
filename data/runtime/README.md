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
Maintainer generation, alternate-root loading, and package validation verify
the SHA-256 digest and canonical JSON. At application startup, package-owned
artifacts retain envelope, codec, decoded-length, JSON, and payload-schema
validation without repeating those publication checks. `manifest.json` is the
generated artifact index. Its independent `components.fmlMappings` and
`components.fhirTables` sections each record their own generator, format,
sources, hashes, and artifact entries. Builders replace their complete owned
section; the manifest is not source configuration.

## FHIR structure tables

The FHIR table artifacts are derived from StructureDefinition bundles in the
official HL7 FHIR publications. They contain:

- `polyPaths`, used to expand polymorphic fields such as
  `Observation.value[x]` into JSON names such as `valueQuantity`.
- `arrayPaths`, used when the FML text does not fully express whether a target
  JSON field must be an array.
- `elementTypes`, used to select shared type-conversion groups when source and
  target element types differ.
- `resourceTypes`, used to distinguish resources from datatypes when applying
  `create()` rules.

The single authoritative list of publications, URLs, archive paths, versions,
dates, licenses, and ZIP-internal bundle paths is
`data/fhir-spec-downloads/sources.yaml`. The downloader and builder both read
that file; these values are not duplicated in code or this README.

## Regeneration

The source archives are downloaded beneath the mostly Git-ignored
`data/fhir-spec-downloads/` dataset and are neither required at runtime nor
published with the package. The tracked `sources.yaml` remains beside them.

Download missing archives and verify all declared ZIPs:

```bash
npm run download:fhir-specs
```

Build either component into a selected runtime-data root:

```bash
npm run build:runtime-data -- \
  fml-mappings --runtime-data-root <directory>

npm run build:runtime-data -- \
  fhir-tables --runtime-data-root <directory>
```

Or build both directly from their authoritative datasets:

```bash
npm run build:runtime-data:all -- --runtime-data-root <directory>
```

The FHIR builder reads the two declared StructureDefinition bundles directly
from each ZIP in memory. It creates no persistent intermediate files. See
`CONTRIBUTING.md` for migration, alternate-dataset, and validation commands.

Run `npm run check:runtime-data-sources` to rebuild both components in a
temporary directory and prove that the committed manifest and artifact modules
are byte-equivalent to their declared sources without rewriting the selected
runtime-data root. During component work, append `-- fml-mappings` or
`-- fhir-tables` to rebuild and compare only that component. Release validation
uses the default full check.
