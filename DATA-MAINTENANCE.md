# Data Maintenance

This guide covers the source datasets and generated runtime data maintained in
the repository. The npm package ships the generated artifacts under
`data/runtime/`; source datasets and maintenance tools require a source checkout.

## Quick workflow

### 1. Update the source data

- FML mappings: update `data/fhir-cross-version/sources.yaml` and its `input/`
  snapshot (manually at this point).
  - Updating specific files in the snapshot is discouraged unless justified.
    See the section on **Source Update Procedures** for more details.
- FHIR tables: update `data/fhir-spec-downloads/sources.yaml`, then download and
  verify the declared archives:
  - FHIR spec archives should not be edited.

    ```bash
    npm run download:fhir-specs
    ```

### 2. Optionally copy the current runtime root

Before rebuilding, copy the complete root to a new location if a restore point
is useful:

```bash
npm run copy:runtime-data -- \
  --all \
  --from-runtime-data-root data/runtime \
  --to-runtime-data-root /path/to/runtime-backup
```

The destination must not already exist. `--all` is explicit here but may be
omitted because a complete-root copy is the default.

### 3. Rebuild the affected runtime data

Choose one component, or rebuild both:

```bash
npm run build:runtime-data -- fml-mappings
npm run build:runtime-data -- fhir-tables
npm run build:runtime-data -- all
```

Builds update `data/runtime` in place unless a runtime root is specified.

### 4. Review and validate

```bash
git diff
npm run check:runtime-data-integrity -- --complete
```

For an FML snapshot update, also run:

```bash
node tools/check-data.js
```

Review affected conversions and update postprocessors or
`CONVERSION-AMBIGUITY.md` when needed.

### 5. Run the release checks

```bash
npm run build:coverage
npm test
npm run check:runtime-data-freshness
npm run check:package
npm run test:installed-package
```

Install the browser once before the installed-package test, if needed:

```bash
npm run install:test-browser
```

## Source update procedures

### FML and ConceptMap snapshot

`data/fhir-cross-version/` is a checked-in snapshot of HL7's
`fhir-cross-version` project. The runtime generator distills its FML and
ConceptMap inputs into `data/runtime/fml-mappings/`.

Use the canonical HL7 repository whenever practical. Adopting a fork requires
explicit maintainer approval. The source and fork policy in
`data/fhir-cross-version/sources.yaml` is authoritative.

To update the snapshot:

1. Update `sources.yaml`, including its URL, commit, snapshot date, license,
   `modifiedFromUpstream` status, and applicable modification notes.
2. Replace the files under `data/fhir-cross-version/input/` with the new
   snapshot.
3. Rebuild `fml-mappings` and validate the complete runtime root.
4. Run the FML parser and conversion tests and review affected version pairs.
5. Update postprocessors as needed and regenerate `COVERAGE.md` with
   `npm run build:coverage`.
6. Run `node tools/check-data.js` and the release checks.

`tools/check-data.js` verifies referenced standalone ConceptMaps and reports
mapping-selection ambiguities. Compare its report with
`CONVERSION-AMBIGUITY.md`; update that file and `README.md` when documented
limitations change.

### FHIR specification archives

`data/fhir-spec-downloads/` holds the official specification archives used to
generate `data/runtime/fhir-tables/`. Its `sources.yaml` is authoritative for
publication URLs, versions, paths, dates, licenses, and ZIP-internal bundles.

After updating `sources.yaml`, run:

```bash
npm run download:fhir-specs
npm run build:runtime-data -- fhir-tables
npm run check:runtime-data-integrity -- --complete
```

The builder reads the declared bundles directly from each ZIP and creates no
persistent intermediate files.

## Alternate datasets and runtime roots

Every source and output location is selectable, so experiments do not need to
touch the committed data. Build one component into an alternate root:

```bash
npm run build:runtime-data -- \
  fml-mappings \
  --dataset-root /path/to/alternate-fml-dataset \
  --runtime-data-root /path/to/alternate-runtime
```

For a full build, use `--fml-dataset-root` and `--fhir-dataset-root` to select
alternate datasets.

A one-component build creates a valid partial root. Copy the unchanged
component into it without rebuilding:

```bash
npm run copy:runtime-data -- \
  --fhir-tables \
  --from-runtime-data-root data/runtime \
  --to-runtime-data-root /path/to/alternate-runtime
```

Complete-root copies use the same command with no scope option, or with an
explicit `--all`. Their destination must not already exist. Component copies
may update an existing root and leave its other component untouched.

## Recovery

A component build removes that component's manifest section and directory
before writing it. A failed or interrupted build therefore leaves the root
without that component rather than with a mismatched manifest and directory.
The other component is untouched.

If you made a complete-root copy first, move the failed root aside and use the
copy as the source for a complete copy back to the original path. Otherwise,
recover the tracked generated data from git:

```bash
git restore data/runtime
git clean -fd data/runtime
```

Review the exact target before running either recovery procedure.

## Reference

### Directories and defaults

| Role | Default | Contents | Selected with |
| --- | --- | --- | --- |
| FML dataset | `data/fhir-cross-version/` | `sources.yaml`, FML files, route catalogs, and ConceptMaps | `--dataset-root` for one component; `--fml-dataset-root` for a full build |
| FHIR dataset | `data/fhir-spec-downloads/` | `sources.yaml` and official specification archives | `--dataset-root` for one component; `--fhir-dataset-root` for a full build |
| Runtime root | `data/runtime/` | `manifest.json`, `fml-mappings/`, and `fhir-tables/` | `--runtime-data-root` |

Dataset roots contain `sources.yaml`, and every path it declares is relative to
that root and must remain within it. A runtime root may not overlap a dataset
root. ConceptMaps are part of the FML dataset, not a third input.

The runtime root has two independently owned components. A component build or
copy changes only its directory and manifest section.

### Commands

Use `--` after an npm target to pass options to its script.

| Command | Arguments and options | Purpose |
| --- | --- | --- |
| `download:fhir-specs` | `[--dataset-root DIR]` | Download missing declared archives and verify all of them. |
| `build:runtime-data` | `<fml-mappings\|fhir-tables>` `[--dataset-root DIR]` `[--runtime-data-root DIR]` | Rebuild one component in place. |
| `build:runtime-data` | `all` `[--fml-dataset-root DIR]` `[--fhir-dataset-root DIR]` `[--runtime-data-root DIR]` | Rebuild both components and validate the complete result. |
| `copy:runtime-data` | `[--all\|--fml-mappings\|--fhir-tables]` `--from-runtime-data-root DIR` `--to-runtime-data-root DIR` | Copy a complete root by default, or copy one selected component. |
| `check:runtime-data-integrity` | `[--runtime-data-root DIR]` `[--complete]` | Verify that a root is well formed and internally consistent. |
| `check:runtime-data-freshness` | `[fml-mappings\|fhir-tables\|all]` `[--runtime-data-root DIR]` `[--fml-dataset-root DIR]` `[--fhir-dataset-root DIR]` | Verify that the selected outputs still match their declared sources. Defaults to `all`. |
| `check:package` | none | Validate packed contents and report package size; includes the complete `check:runtime-data-integrity` on the committed root. Runs automatically on `prepack`. |
| `test:installed-package` | none | Pack, install, and exercise the package in Node and a browser. |

`node tools/check-data.js [FML-INPUT-DIR]` is the additional FML snapshot check.
Its optional argument is the FML input directory, not a dataset root.

### Options

| Option | Applies to | Default |
| --- | --- | --- |
| `--runtime-data-root DIR` | builds and runtime-data checks | `data/runtime` |
| `--dataset-root DIR` | component build and `download:fhir-specs` | selected component's standard dataset |
| `--fml-dataset-root DIR` | full build and freshness check | `data/fhir-cross-version` |
| `--fhir-dataset-root DIR` | full build and freshness check | `data/fhir-spec-downloads` |
| `--from-runtime-data-root DIR`, `--to-runtime-data-root DIR` | copy | required |
| `--all`, `--fml-mappings`, `--fhir-tables` | copy scope | `--all` |
| `--complete` | integrity check | off; partial roots are allowed |
| `--help`, `-h` | every command except `check:package` | print usage |

Build dataset options are scoped to their modes. `--dataset-root` is rejected
for `all`; `--fml-dataset-root` and `--fhir-dataset-root` are rejected for a
component build. Copy scope options are mutually exclusive.

### Choosing a check

| Check | Answers | Needs |
| --- | --- | --- |
| `check:runtime-data-integrity` | Is this root intact and self-consistent? | only the root |
| `check:runtime-data-freshness` | Does this root still match its sources? | the selected source datasets |
| `check:package` | Are the packed contents correct? | the committed root |
| `test:installed-package` | Does the installed package work? | a tarball and Chromium |

Freshness and package validation both perform integrity validation, but neither
implies the other. Freshness rebuilds and compares data; package validation
checks the packed file list. The installed-package test executes the result.
None of these checks writes to the selected runtime root.

### Reported measurements

Build and check commands report artifact and file counts, byte sizes,
compression ratios, and elapsed times where applicable. Compare measurements
after changing source data, encoding, or validation behavior.

### Assumptions

- Do not run concurrent mutating commands against the same runtime root.
- Keep a copy source stable while it is being copied.
- Treat alternate runtime roots as trusted inputs; loading their JavaScript
  artifact modules executes code from the selected root.
- Do not edit generated artifacts or `manifest.json` by hand.
