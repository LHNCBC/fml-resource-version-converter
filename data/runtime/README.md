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
authoritative artifact index and records artifact identities, hashes, counts,
compression parameters, source URLs, source versions or commits, archive
hashes, publication dates, and licenses.

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

| Table | Publication | Source archive | StructureDefinition bundles |
| --- | --- | --- | --- |
| DSTU2 | 1.0.2 | `https://hl7.org/fhir/DSTU2/fhir-spec.zip` | `site/profiles-resources.json`, `site/profiles-types.json` |
| STU3 | 3.0.2 | `https://hl7.org/fhir/STU3/definitions.json.zip` | `profiles-resources.json`, `profiles-types.json` |
| R4 | 4.0.1 | `https://hl7.org/fhir/R4/definitions.json.zip` | `profiles-resources.json`, `profiles-types.json` |
| R4B | 4.3.0 | `https://hl7.org/fhir/R4B/definitions.json.zip` | `definitions.json/profiles-resources.json`, `definitions.json/profiles-types.json` |
| R5 | 5.0.0 | `https://hl7.org/fhir/R5/definitions.json.zip` | `profiles-resources.json`, `profiles-types.json` |

DSTU2 does not publish `definitions.json.zip`; its JSON bundles come from the
full specification archive under `site/`. R4B nests the bundles below a
`definitions.json/` directory. The parser accepts the archive path variants
used by the official publications.

## Regeneration

The source archives are downloaded to the Git-ignored
`data/fhir-spec-downloads/` directory and are neither required at runtime nor
published with the package. Regenerate the ignored intermediate tables and
then the committed runtime artifacts from the project root:

```bash
npm run build:fhir-defs
npm run build:runtime-data -- --output <directory>
```

Use `npm run build:fhir-defs -- --download-missing` to fetch absent official
archives. Runtime generation requires a caller-selected output directory and
does not rewrite this committed directory implicitly. See `CONTRIBUTING.md`
for the complete maintainer workflow.

Run `npm run check:runtime-data-sources` to derive tables from all five official
archives in temporary directories and prove that the committed manifest and
artifact modules are byte-equivalent to their current sources without rewriting
the repository.
