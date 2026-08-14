# Contributing

Thank you for helping improve the FML-based FHIR Resource Version Converter.

Due to the number of FHIR resource types and versions, this project is meant to
grow incrementally, and community help is invaluable.
The FML mapping engine provides the base conversion, but the mapping files are
sometimes incomplete. Individual assessments are therefore needed, and
postprocessors can be added to address the issues found - this is an area where
community contributions make the most impact.

For example, if you find yourself converting resources of type T from version V1
to V2 and this package's coverage status for this conversion is "not_reviewed"
or "known_gaps", you can review the FML mapping/conversion, create a postprocessor
if needed, and contribute your work back to this project. Thank you!

This package ships with fhir-cross-version data (from HL7) and some data tables
extracted from the official FHIR specification, which are needed at runtime.
Normally you wouldn't need to update these datasets, but if you do, for example,
to add support for a new FHIR version or to get the latest fhir-cross-version
mapping files, please see the `Repository data` section for instructions.


## Development setup

Install dependencies from the repository root:

```bash
npm install
```

Run the full test suite:

```bash
npm test
```

Run the build, which will generate/regenerate the coverage document, `COVERAGE.md`:

```bash
npm run build
```

Before submitting a change, run both:

```bash
npm run build
npm test
```

## Conversion architecture

A single-hop conversion (between adjacent versions) runs in this order:

1. Validate the resource type and version pair.
2. Deep-clone the caller's input resource.
3. Run caller preprocessors, if any.
4. Run the FML mapping.
5. Run package and/or caller postprocessors.
6. Return the converted resource plus coverage, status, and diagnostics.

Conversions are defined only between adjacent versions and per direction (for
example, R3->R4 and R4->R3 are separate). A non-adjacent conversion such as
R3->R5 runs as a chain of single hops (R3->R4->R5), and the chain's coverage
rolls up to the lowest hop. Each hop is therefore reviewed and labeled
independently.

The FML engine code under `src/fml_base_conv/` should faithfully execute the
FML mappings. When an FML mapping is found to be incomplete or erroneous, either:
- add a postprocessor to correct the output, rather than making ad hoc fixes
  to the engine for a specific mapping, or
- fix the FML mapping file itself and work with HL7 to get the fix into the
  official fhir-cross-version project.

## Coverage levels

Coverage describes the level of completeness of conversions. It is separate
from runtime status. The coverage levels are **not_reviewed**, **known_gaps**,
**best_effort**, and **complete**. See [Coverage levels](README.md#coverage-levels)
in `README.md` for their definitions.

The postprocessor registry files, e.g. `src/postprocessors/R4_R5/registry_R4_to_R5.js`,
are the source of truth - these files are manually maintained. An entry is added
or updated when a conversion is reviewed, or when postprocessors are added.

The `COVERAGE.md` report is generated from the postprocessor registries
described above. Please do not manually edit `COVERAGE.md`.

When you assign a coverage level:

- Judge completeness against the resource's own top-level elements for valid
  input. Inter-version extensions (IVE) and `contained[]` conversion are out of
  scope and do not lower a coverage claim.
- "Lossy but unavoidable" (source content with no target representation) is
  conventionally best_effort, not complete.
- A postprocessor must never lower the running coverage level.


## Onboarding a resource type

The FML engine already maps every resource type for the versions supported,
so onboarding is not about adding a mapping. It means reviewing a resource's
FML conversion for a version pair, assigning an honest coverage level, and,
where the FML falls short, adding a postprocessor to improve the output.
The review is the real work; any code follows from it.

### Step 1 - Review the FML output

Goal: find the concrete gaps between the FML-converted result and a correct
target-version resource.

1. Compare the FHIR specification for the source and target versions to see
   the differences. A good place to start is the target version's specification
   page, where you can find a "Diff" tab that lists the field changes from the
   previous version. For example, if you are looking at converting Questionnaire
   from R3 to R4, the [R4 spec page](https://hl7.org/fhir/R4/questionnaire.html)
   has a "R3 Diff" tab that shows the changes from R3.
2. Review the FML mapping to identify the gaps. If you are comfortable with FML,
   you can review the mapping file directly and see whether/where it falls short.
   Otherwise, you can create one or more representative source resources under
   `test/data/` to cover the fields you expect to be risky, run the conversion,
   and inspect the output. Such tests are recommended even if you've reviewed
   the FML mappings, and the sample resources are handy for writing mocha tests.
   A quick harness:

   ```js
   import { singleHopConverter } from './src/index.js';
   const result = singleHopConverter.convert(sourceResource, 'R3', 'R4');
   console.log(JSON.stringify(result, null, 2));
   ```
3. Write down the gaps if any.

Typical gap categories to look for:

- Elements valid in the source with no target equivalent (dropped -> lossy).
- Elements renamed or restructured across versions (FML leaves the old shape).
- Cardinality changes, e.g. target 0..1 vs source 0..*, or vice versa.
- Choice type `[x]` mismatches and value-set/enum changes.
- Invalid output: the FML emitted a field the target schema does not allow.

### Step 2 - Decide what to do based on the review

- If the FML output is already valid and complete, no postprocessor is needed:
  add a registry entry with the fml coverage set to complete. See the Questionnaire
  entry in registry_R4_to_R5.js for an example.
- If the FML output isn't perfect:
  - if there is nothing one can do to improve it - for example, a source data
    element has no representation in the target, then add a registry entry with
    the fml coverage set to best_effort, and no postprocessors are needed.
    See the Questionnaire entry in registry_R4_to_R5.js for an example on how
    to add an entry.
  - If there is still room to improve, the FML coverage (in the registry entry)
    should be set to "known_gaps". If you plan to write a postprocessor to
    improve the conversion output, please follow the guidance in the next section
    and update the registry entry accordingly. See the Questionnaire entry in
    registry_R4_to_R3.js for an example.


## Adding or updating a postprocessor

Postprocessors live under `src/postprocessors/`, grouped by version pair.

### Postprocessor directory layout

Each version-pair directory contains postprocessors for both conversion
directions for that pair. Each direction has a registry file named
`registry_<FROM>_to_<TO>.js`. Postprocessors are usually grouped by
resource types, e.g., R4_R5/Questionnaire.js contains postprocessors for
converting the Questionnaire resources from R4 to R5 and from R5 to R4.

Start with one file per resource type per version pair, covering both
conversion directions. Helper files can certainly be used for maintainability.
If you decide to split the code based on conversion direction, please keep
the naming convention consistent with the registry naming, e.g.
`Patient_R3_to_R4.js` and `Patient_R4_to_R3.js`. Put code reusable across
different version pairs under `util/`, and put resource-specific reusable
logic in `util/<resource>.js`.

The directory structure looks like this:

```text
src/postprocessors/
  registry.js
  R2_R3/
    registry_R2_to_R3.js
    registry_R3_to_R2.js
  R3_R4/
    registry_R3_to_R4.js
    registry_R4_to_R3.js
    Questionnaire.js
  R4_R5/
    registry_R4_to_R5.js
    registry_R5_to_R4.js
    Questionnaire.js
  R4B_R5/
    registry_R4B_to_R5.js
    registry_R5_to_R4B.js
    Questionnaire.js
  util/
    elements.js
    questionnaire.js
```

The top-level registry, `src/postprocessors/registry.js`, automatically combines
the direction-specific registries during initialization. If a resource type has
no explicit entry in a specific registry (e.g., registry_R4_to_R5.js) but an FML
mapping exists, the lookup returns the default entry with FML coverage set to
**not_reviewed** and no package postprocessors.

Registry resource type keys use the type entering the conversion hop. If
the mapping renames the resource, register the postprocessor under the source
type; its `target` argument still contains the converted output resource.

Let's walk through a hypothetical example before explaining the details. Suppose
the FML mapping for ResourceTypeX from R4 to R5 drops the field someFieldFoo when
its value is "foo", but it should really be mapped to "foobar". We add a
postprocessor to fix that and document it in the registry.

```js
// src/postprocessors/R4_R5/ResourceTypeX.js, define and export post processors.
import { COVERAGE } from '../../converter/coverage.js';
import {
  statusFromMessages,
  infoMessage,
} from '../../converter/diagnostics.js';

/**
 * Correct fields that the FML mapping cannot fully convert.
 *
 * @param {Object} target FML-converted target resource, usually mutated in place.
 * @param {Object} ctx Conversion context.
 * @returns {{resource: Object, status: string, messages: Array<Object>}} Result.
 */
function executeFunc(target, ctx) {
  const messages = [];

  if (ctx.sourceResource.someFieldFoo === 'foo') {
    messages.push(infoMessage('Converted someFieldFoo from "foo" to "foobar".'));
    target.someFieldFoo = 'foobar';
  }

  return { resource: target, status: statusFromMessages(messages), messages };
}

export const conv_R4_to_R5 = { // postprocessor descriptor for use in the registry
  name: 'ResourceTypeX_R4_to_R5',
  coverage: COVERAGE.COMPLETE, // the overall conversion is now complete.
  description: 'Fixed someFieldFoo mapping.',
  execute: executeFunc,
};
```

Then, in `registry_R4_to_R5.js`, add a registry entry for ResourceTypeX:

```js
import { COVERAGE } from '../../converter/coverage.js';
import { conv_R4_to_R5 } from './ResourceTypeX.js';

const registry = {
  // ...
};

registry.ResourceTypeX = {
  fml: {
    coverage: COVERAGE.KNOWN_GAPS,
    description: 'FML mapping has issues converting someFieldFoo.',
  },
  processors: [conv_R4_to_R5],
};

export { registry };

```

The postprocessor entries in the registries are postprocessor descriptors,
which are objects with the following properties:

- `name`: required stable name for reporting and diagnostics.
- `execute`: required postprocessor function. It receives the
  FML-converted target resource and a conversion context, and returns
  `{ resource, status, messages }`.
- `coverage`: optional coverage level after this postprocessor runs. Omit it or
  use `COVERAGE.NEUTRAL` when the processor does not change the coverage claim.
- `description`: optional human-readable explanation of what the processor does
  and any important limitations.

Postprocessor descriptors may contain additional fields for local use, but the
runtime only depends on the properties above.


Processor rules:
- Use a clear, stable `name`; it appears in conversion reports.
- Include a human-readable `description`, including important limitations.
- Return `{ resource, status, messages }`.
- `status` must match message severity in both directions: `status` is `warning`
  if and only if at least one warning message is present. Deriving it with
  `statusFromMessages(messages)` satisfies this automatically. (A warning-level
  message must raise the status; if no status impact is intended, use an info
  message instead.)
- Use `infoMessage()` for non-lossy notes and `warningMessage()` for lossy or
  potentially surprising behavior.
- Add JSDoc to functions.

The postprocessor context includes:
- `sourceResource`: the resource immediately before the FML step, after any
  caller preprocessors.
- `fromVer`: source version token.
- `toVer`: target version token.

## Updating the registry

Register reviewed resource coverage in the direction-specific registry file.
For example:

```text
src/postprocessors/R4_R5/registry_R5_to_R4.js
```

If FML alone is complete:

```js
export const registry = {
  Questionnaire: {
    fml: {
      coverage: COVERAGE.COMPLETE,
      description: 'FML fully covers R5->R4 for valid input; no postprocessor needed.',
    },
    processors: [],
  },
};
```

If FML has known gaps and a postprocessor completes the conversion:

```js
export const registry = {
  Questionnaire: {
    fml: {
      coverage: COVERAGE.KNOWN_GAPS,
      description: 'FML leaves item.type incomplete',
    },
    processors: [conv_R5_to_R4],
  },
};
```

After changing registry entries, regenerate coverage:

```bash
npm run build:coverage
```

## Testing expectations

Add tests for the behavior change you made.

Cover, at minimum:

- Each corrected field, before and after.
- The status/message contract: a warning message is present if and only if the
  status is `warning`.
- No-op safety on inputs that have none of the risky fields.

Useful test locations include:

- `test/mocha/postprocessors/` for resource-specific postprocessors and registry
  coverage.
- `test/mocha/converter/` for pipeline, coverage, diagnostics, and descriptor
  behavior.
- `test/mocha/fml_base_conv/` for FML parser and engine behavior.
- `test/data/` for representative FHIR input resources.


Run:

```bash
npm run build
npm test
```

## Submitting a pull request

- Work on a branch and open the pull request against `master`.
- Keep the change focused - one resource type and version pair per pull request
  where practical.
- Make sure `npm run build` and `npm test` both pass, and include the
  regenerated `COVERAGE.md` if you changed a registry entry.
- In the description, summarize what you reviewed and why you chose the
  coverage level.

## Repository data

The package ships two kinds of FHIR data. They have different purposes and
different update procedures.

### Directory `data/fhir-cross-version/`

This directory contains a checked-in snapshot of HL7's
`fhir-cross-version` project. The FML mapping files are required
at runtime, so they are shipped with the package.

Please exercise caution if you plan to update the snapshot. An update to the FML
mapping files may invalidate some postprocessors, because they operate on the
output of the FML mapping step. The fhir-cross-version project is also still at
an early stage. That said, if an update is justified, go ahead.

To update this snapshot:

1. Update `data/fhir-cross-version/SOURCE.md` with the source URL, commit, and
   snapshot date.
2. Update the snapshot files in `data/fhir-cross-version/input` with the new
   files from the fhir-cross-version project.
3. Run the data-integrity check (see below) and address anything it reports.
4. Re-run the FML parser tests and conversion tests.
5. Review behavior changes for any resource and version pair affected by the
   new mappings.
6. Update postprocessors as needed and regenerate (no hand editing) `COVERAGE.md`.

#### Checking the snapshot with `tools/check-data.js`

After refreshing the snapshot, run:

```bash
node tools/check-data.js
```

Snapshot refreshes are infrequent, so this is deliberately a manual step and is
not part of `npm test`. The tool reports two things:

- **ConceptMap integrity.** Every standalone ConceptMap referenced by the FML
  mappings must be present and parseable. A problem here is a genuine error and
  the tool exits non-zero.
- **Mapping selection ambiguities (informational).** The FML files may declare
  a source resource type with more than one target type (Type A), or a single
  source/target pair served by more than one mapping file (Type B). These are
  not errors and do not affect the exit code, but they are something you should
  be aware of and address appropriately.

Compare the reported ambiguities against
[CONVERSION-AMBIGUITY.md](CONVERSION-AMBIGUITY.md). If an entry has appeared or
disappeared, update that document, and update `README.md` as well if a
documented limitation changed. A new Type B ambiguity on an actively supported
version pair is worth a closer look, since the converter cannot currently
resolve one on its own.

### Directories `data/fhir-defs/` and `data/fhir-spec-downloads/`

The directory `data/fhir-spec-downloads/` contains the official FHIR spec zip
files, which are themselves not shipped with the package but are needed to build
the runtime files under `data/fhir-defs/`. The spec zip files may be downloaded
into `data/fhir-spec-downloads/` using the provided build script.

The files under `data/fhir-defs/` are runtime tables derived from the official
HL7 FHIR specification files described above. The FML engine uses these tables
to understand FHIR JSON details that are not explicitly represented in the FML
mappings, such as:

- polymorphic field names, for example `Observation.value[x]`
- array/cardinality paths
- scalar element types that may need type conversion

Do not edit the generated JSON files by hand. The generated JSON files are
shipped with the package because they are needed at runtime.

#### Regenerate the `data/fhir-defs/` tables

To download the FHIR spec files and regenerate `data/fhir-defs/`, run:

```bash
npm run build:fhir-defs -- --download-missing
```
If the FHIR spec files are already present, you can simply run:

```bash
npm run build:fhir-defs
```

Please feel free to reach out if you have any questions or need assistance -
open an [issue](https://github.com/LHNCBC/fml-resource-version-converter/issues).

Thank you for contributing!
