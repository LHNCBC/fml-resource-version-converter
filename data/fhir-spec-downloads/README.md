# fhir-spec-downloads

Raw FHIR specification zip archives downloaded from the official HL7 FHIR website.
These files are used to build the per-version runtime tables in `data/fhir-defs/`.

This directory's **contents are gitignored** (see `.gitignore`); only this
`README.md` is checked in so the directory's purpose is discoverable.

## Layout

```
data/fhir-spec-downloads/
  DSTU2/fhir-spec.zip            # 100MB (no definitions.json.zip published)
  STU3/definitions.json.zip
  R4/definitions.json.zip
  R4B/definitions.json.zip
  R5/definitions.json.zip
```

No extraction is needed; the build script reads the bundles straight out
of the zips. Disk usage: about 125MB once populated.

## How to populate

The build script can download the files automatically, e.g.,

```bash
npm run build:fhir-defs -- --download-missing
```

See ../fhir-defs/SOURCE.md for details.

To manually download the files, if needed:

```sh
cd data/fhir-spec-downloads
for V in STU3 R4 R4B R5; do
  mkdir -p "$V"
  curl -sSfL -o "$V/definitions.json.zip" \
    "https://hl7.org/fhir/$V/definitions.json.zip"
done
# DSTU2 does not publish a definitions.json.zip; pull the full spec zip.
mkdir -p DSTU2
curl -sSfL -o DSTU2/fhir-spec.zip https://hl7.org/fhir/DSTU2/fhir-spec.zip
```
