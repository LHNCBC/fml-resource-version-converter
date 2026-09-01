# fhir-spec-downloads

This dataset contains the source configuration and raw official FHIR
specification ZIP archives used to build `data/runtime/fhir-tables/` directly.

The archive files are Git-ignored. `README.md` and `sources.yaml` are tracked.
The latter is the single authoritative list of publications, URLs, archive
paths, versions, dates, licenses, and ZIP-internal bundle paths.

## Layout

```
data/fhir-spec-downloads/
  sources.yaml
  <archive paths declared by sources.yaml>
```

No extraction is needed; the build script reads the bundles straight out
of the zips. Disk usage: about 125MB once populated.

## How to populate

Download missing archives and verify all existing or downloaded files:

```bash
npm run download:fhir-specs
```

See `../runtime/README.md` and the repository-root `CONTRIBUTING.md` for source
details and the complete regeneration workflow.
