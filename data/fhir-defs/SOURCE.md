# fhir-defs

Per-version data extracted from official HL7 FHIR specification publications.
Each generated file under this directory is regenerable; do not edit by hand.

## Layout

```
data/fhir-defs/
  SOURCE.md             (this file)
  poly-paths/           Polymorphic field paths, one file per FHIR version.
    DSTU2.json
    STU3.json
    R4.json
    R4B.json
    R5.json
  (future kinds of derived data may live in sibling subdirectories)
```

## poly-paths/

| File         | FHIR version    |
| ------------ | --------------- |
| `DSTU2.json` | DSTU2 (1.0.2)   |
| `STU3.json`  | STU3 (3.0.2)    |
| `R4.json`    | R4 (4.0.1)      |
| `R4B.json`   | R4B (4.3.0)     |
| `R5.json`    | R5 (5.0.0)      |

### File format

```json
{
  "fhirVersion":   "R4",
  "generated":     "YYYY-MM-DD",
  "sourceArchive": "definitions.json.zip",
  "sourceBundles": ["profiles-resources.json", "profiles-types.json"],
  "pathCount":     186,
  "polyPaths": {
    "Observation.value": ["CodeableConcept", "Quantity", "..."],
    "Questionnaire.item.initial.value": ["Attachment", "Coding", "..."]
  }
}
```

Each `polyPaths` key is a dotted path from the resource root with the `[x]`
suffix stripped. Each value is the sorted, de-duplicated list of FHIR type
codes that may appear in the field's typed variant
(e.g. `valueQuantity`, `initialString`).

### Why these tables exist

FHIR polymorphic fields (e.g. `Observation.value[x]`) are serialized in
JSON as typed variants (`valueQuantity`, `valueString`, ...). The
official cross-version FML mappings published by HL7 sometimes refer to
the bare polymorphic name (e.g. `src.initial as s`) without enumerating
each variant. The FML execution engine in this project consults these
tables at runtime to expand a bare polymorphic reference to the set of
typed JSON fields that may actually carry the value.

## Provenance

The polymorphic-path tables are derived from the StructureDefinition
Bundles published by HL7 for each FHIR version.

| Version | Source archive                                              | Bundles used                                                  |
| ------- | ----------------------------------------------------------- | ------------------------------------------------------------- |
| DSTU2   | https://hl7.org/fhir/DSTU2/fhir-spec.zip (`site/`)          | `profiles-resources.json`, `profiles-types.json`              |
| STU3    | https://hl7.org/fhir/STU3/definitions.json.zip              | `profiles-resources.json`, `profiles-types.json`              |
| R4      | https://hl7.org/fhir/R4/definitions.json.zip                | `profiles-resources.json`, `profiles-types.json`              |
| R4B     | https://hl7.org/fhir/R4B/definitions.json.zip               | `definitions.json/profiles-resources.json`, `.../profiles-types.json` |
| R5      | https://hl7.org/fhir/R5/definitions.json.zip                | `profiles-resources.json`, `profiles-types.json`              |

DSTU2 does not publish a `definitions.json.zip`; the JSON bundles are
extracted from the full `fhir-spec.zip` under the `site/` directory.

## Regenerating poly-paths/

Use `tools/build_poly_table.mjs`. See its file header for full usage.
Raw spec zip archives live under `data/fhir-spec-downloads/` (gitignored;
see that directory's `README.md` for how to populate it). The script
reads the StructureDefinition bundles directly out of each zip; no manual
extraction is needed.

```sh
# Assumes data/fhir-spec-downloads/ is already populated.
for V in DSTU2 STU3 R4 R4B R5; do
  ZIP=$([ "$V" = "DSTU2" ] && echo fhir-spec.zip || echo definitions.json.zip)
  node tools/build_poly_table.mjs "$V" "data/fhir-defs/poly-paths/$V.json" \
    "data/fhir-spec-downloads/$V/$ZIP"
done
```


