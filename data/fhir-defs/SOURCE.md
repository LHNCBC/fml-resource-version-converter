# fhir-defs

Per-version runtime tables are generated from official HL7 FHIR specification
publications. Do not edit these files.

The source FHIR spec zips are downloaded into `data/fhir-spec-downloads/`
from the official HL7 website but are not needed at runtime and are not
shipped with the package.
See `data/fhir-spec-downloads/README.md` for more details.

## Layout

```text
data/fhir-defs/
  SOURCE.md
  DSTU2.json
  STU3.json
  R4.json
  R4B.json
  R5.json
```

The FHIR version for each file is in the filename and also in its `fhirVersion`
field.

| File         | FHIR version  |
| ------------ | ------------- |
| `DSTU2.json` | DSTU2 (1.0.2) |
| `STU3.json`  | STU3 (3.0.2)  |
| `R4.json`    | R4 (4.0.1)    |
| `R4B.json`   | R4B (4.3.0)   |
| `R5.json`    | R5 (5.0.0)    |

## File format

Each generated file contains three sibling tables produced by one pass over the
FHIR StructureDefinition bundles.

```json
{
  "fhirVersion": "R4",
  "generated": "YYYY-MM-DD",
  "sourceArchive": "definitions.json.zip",
  "sourceBundles": ["profiles-resources.json", "profiles-types.json"],
  "pathCounts": {
    "poly": 186,
    "array": 3153,
    "elementTypes": 3300
  },
  "polyPaths": {
    "Observation.value": ["CodeableConcept", "Quantity", "..."]
  },
  "arrayPaths": [
    "Bundle.entry",
    "Patient.name",
    "..."
  ],
  "elementTypes": {
    "Patient.gender": "code",
    "Questionnaire.item.answerValueSet": "canonical"
  }
}
```

## Why these tables exist

FHIR polymorphic fields, such as `Observation.value[x]`, are serialized in JSON
as typed variants, such as `valueQuantity` or `valueString`. The official
cross-version FML mappings sometimes refer to the bare polymorphic name without
enumerating each typed variant. The FML engine consults `polyPaths` to expand
those references and to decide whether to apply a typed suffix on the target
side.

The FML text also does not fully describe FHIR JSON cardinality. The engine
consults `arrayPaths` to decide when a target write must be wrapped in an array.

The `elementTypes` table records scalar element types. The engine uses it when a
source and target element have different FHIR types and a shared type-conversion
group may need to run.

## Provenance

The tables are derived from the StructureDefinition bundles published by HL7 for
each FHIR version.

| Version | Source archive                                              | Bundles used                                                  |
| ------- | ----------------------------------------------------------- | ------------------------------------------------------------- |
| DSTU2   | https://hl7.org/fhir/DSTU2/fhir-spec.zip (`site/`)          | `profiles-resources.json`, `profiles-types.json`              |
| STU3    | https://hl7.org/fhir/STU3/definitions.json.zip              | `profiles-resources.json`, `profiles-types.json`              |
| R4      | https://hl7.org/fhir/R4/definitions.json.zip                | `profiles-resources.json`, `profiles-types.json`              |
| R4B     | https://hl7.org/fhir/R4B/definitions.json.zip               | `definitions.json/profiles-resources.json`, `.../profiles-types.json` |
| R5      | https://hl7.org/fhir/R5/definitions.json.zip                | `profiles-resources.json`, `profiles-types.json`              |

DSTU2 does not publish a `definitions.json.zip`; the JSON bundles are
extracted from the full `fhir-spec.zip` under the `site/` directory.

## Regenerating

Use the npm wrapper:

```bash
npm run build:fhir-defs
```

The wrapper checks for the expected raw spec zip archives under
`data/fhir-spec-downloads/`. By default it does not use the network. If an
archive is missing, it reports the missing file and exits with instructions.

To download missing raw archives and then regenerate the generated tables, use
the same command with `--download-missing`:

```bash
npm run build:fhir-defs -- --download-missing
```

A single run produces `data/fhir-defs/<VER>.json` for each known version.
The underlying extractor is `tools/build_fhir_tables.js`.

Raw spec zip archives live under `data/fhir-spec-downloads/` and are gitignored.
The extractor reads the StructureDefinition bundles directly out of each zip; no
manual extraction is needed.

