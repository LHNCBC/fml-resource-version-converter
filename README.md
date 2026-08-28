# FML-based FHIR Resource Version Converter

This FML-based FHIR Resource Version Converter is a JavaScript package
for converting FHIR resources between FHIR versions.

The conversion starts with HL7's FHIR cross-version FML (FHIR Mapping Language)
mapping files, which handle most, and sometimes all, data elements in
a conversion. When a mapping is incomplete, postprocessors may be used
to refine the converted resource.

The initial release includes postprocessors for **Questionnaire** only. For the
other resource types, the FML mappings have not been reviewed and no
package postprocessors have been provided. However, the converter can
still handle most of the data elements (via FML mapping), and
you can pass in a postprocessor as needed to make the conversion complete.

This project is designed as a general, extensible framework to support all
FHIR resource types and versions for which FML mapping files exist.
Postprocessors can be added incrementally and cleanly in future releases
as the FML mappings are reviewed.

For non-adjacent version pairs such as R3 -> R5, the conversion can be
completed through a hop via R4, that is, R3 -> R4 and then R4 -> R5.
The `chainedConverter` entry point performs this hop chaining for you.

The community is encouraged to contribute by reviewing the conversions for
other resource types and version pairs, and by providing postprocessors
as needed to make the conversions complete. Detailed instructions
for contributing are in [CONTRIBUTING.md](CONTRIBUTING.md).

As a historical note, this project evolved from the now-deprecated
[questionnaire-version-converter](https://github.com/LHNCBC/questionnaire-version-converter),
which was a hand-rolled converter for FHIR Questionnaire resources.


## Installation

```bash
npm install @lhncbc/fml-resource-version-converter
```

The package is published as an ES module.


## Quick start


```js
import { singleHopConverter } from '@lhncbc/fml-resource-version-converter';

const questionnaireR4 = {
  resourceType: 'Questionnaire',
  status: 'active',
  item: [
    {
      linkId: 'q1',
      text: 'Favorite color?',
      type: 'choice',
      answerOption: [
        { valueCoding: { code: 'blue', display: 'Blue' } },
      ],
    },
  ],
};

const result = singleHopConverter.convert(questionnaireR4, 'R4', 'R5');

console.log(result.resource);  // the converted R5 Questionnaire
console.log(result.status);    // 'ok' or 'warning'
console.log(result.coverage);  // 'not_reviewed', 'known_gaps', 'best_effort', or 'complete'
```

The singleHopConverter shown above is for converting resources between adjacent
versions (single hop), e.g., R4 -> R5. For conversion between non-adjacent
versions, use
  `chainedConverter.convert(resource, fromVer, toVer)`,
which automatically creates a conversion chain and performs the end-to-end conversion.
For example, R3 -> R5 is run as R3 -> R4 followed by R4 -> R5.

Note that the converters throw when the request cannot be run, such as an unknown
version token, the same source and target version, an unknown resource type, or
an unsupported version path.

The input resource is deep-cloned before conversion. Your original resource object
is not modified.

The conversion uses runtime data prepared from the HL7 FML mapping data
and the FHIR spec. The default package entry preloads the runtime data
for all supported conversions (resource types, source-target versions),
which incurs moderate initialization time and memory cost. Applications
that need fewer combinations of source-target version conversions, especially
browser applications, may import the converter factory and only the
required runtime data, as illustrated below.

```js
import { converterFactory } from
  '@lhncbc/fml-resource-version-converter/converter-factory';
import runtimeData from
  '@lhncbc/fml-resource-version-converter/runtime/r4-to-r5';

const { singleHopConverter } = converterFactory.create(runtimeData);
const result = singleHopConverter.convert(questionnaireR4, 'R4', 'R5');
```

`converterFactory.create()` accepts one runtime data module or an array. The
returned `singleHopConverter`, `chainedConverter`, and `getRegistryEntry` are
all scoped to those modules. A chain is available only when every required hop
was included:

```js
import r2ToR3 from
  '@lhncbc/fml-resource-version-converter/runtime/r2-to-r3';
import r3ToR4 from
  '@lhncbc/fml-resource-version-converter/runtime/r3-to-r4';

const { chainedConverter } = converterFactory.create([r2ToR3, r3ToR4]);
const result = chainedConverter.convert(resourceR2, 'R2', 'R4');
```

The package also exports `runtime/all`, which contains the same complete runtime
selection used internally by the default package entry. Pass it explicitly to
`converterFactory.create()` when constructing an all-data converter; the factory
requires one runtime data module or a non-empty array and has no implicit default.

Runtime data objects are opaque and read-only by contract. Conversion remains
synchronous; a dynamic import can be used when an application wants to defer
loading and initialization.

When a browser build emits sourcemaps, configure the builder not to embed
dependency source text. Otherwise a builder can copy the large Base64 runtime
payloads into `sourcesContent`. For Vite/Rollup:

```js
export default {
  build: {
    sourcemap: true,
    rollupOptions: {
      output: { sourcemapExcludeSources: true },
    },
  },
};
```

This preserves sourcemap locations while keeping the runtime payload only in
the JavaScript bundle.

Because resources are sometimes renamed or split between FHIR versions, a
source resource type can map to more than one target type on a single hop. Use
`opts.targetResourceType` to assert the intended target:

```js
// R4 -> R3: a ServiceRequest may become a ProcedureRequest or a ReferralRequest,
// so the target type must be stated explicitly.
const result = singleHopConverter.convert(serviceRequestR4, 'R4', 'R3', {
  targetResourceType: 'ProcedureRequest',
});
```

`targetResourceType` names the **intended target type**. It is **required**
only when the source resource maps to more than one target on the hop (as with
`ServiceRequest` R4->R3 above); for a one-to-one mapping it is optional. When
supplied, it is checked against the target type declared by the FML
StructureMap, so a mismatched value is rejected rather than silently ignored.

Naming a target type does not always identify a single mapping: `ProcedureRequest`
R3 -> R2 targeting `DiagnosticOrder` is served by two FML StructureMaps and
therefore cannot be run. See [Limitations](#limitations).

## Supported version pairs

Use the canonical version tokens **R2**, **R3**, **R4**, **R4B**, and **R5**.
Other names such as **STU3**, **DSTU2**, or **4.0.1** are not accepted by the
public API.

As of this release, direct FML mappings are available for the following
adjacent pairs, in both directions:

```text
R2  <-> R3
R3  <-> R4
R4  <-> R5
R4B <-> R5
```

`chainedConverter.convert()` supports adjacent pairs and multi-hop paths along
the supported lanes. For example, **R3 -> R5** runs as **R3 -> R4 -> R5**.
Use `singleHopConverter.convert()` only when you specifically want the flat
single-hop result shape for one adjacent pair.

R4B only has FML mappings to and from R5, and specifically, there is no FML mapping
between **R4 <-> R4B** (not needed).
For conversions between **R3 <-> R4B**, use **R4** instead of
**R4B** when that is acceptable.

## Limitations

This initial release focuses on top-level resource conversion. Please keep the
following in mind:

- **Contained resources are not version-converted.** A resource's `contained[]`
  entries are carried through as-is and are not converted to the target version.
  If your resource holds contained resources that must match the target version,
  convert them separately for now. Automatic conversion of contained resources
  is planned for a future release, at which point the conversion report will
  include a per-contained-resource status you can check.
- **Bundle entry resources are not version-converted.** Bundle structure is
  mapped, but each `entry.resource` is carried through as-is. Recursive
  conversion of Bundle entries is planned for a future release.
- **One-to-many conversion is not yet supported.** A future release will handle
  cases such as R2 -> R3 `CarePlan` -> `CarePlan` + `CareTeam` when needed.
- **Ambiguous target selection with `targetResourceType` (or the CLI option
  `--target-resource-type`) is supported only for a single hop.** Support for
  selecting targets within a multi-hop conversion may be added in a future
  release.
- **Reviewed postprocessors are supplied only for Questionnaire.** Other resource
  types are converted by the FML mapping alone (see [COVERAGE.md](COVERAGE.md)),
  and more postprocessors may be added in future releases. You certainly can
  supply your own postprocessors as needed - and better yet, contribute
  them back to the project.
- **A few FML language features are not yet implemented:** `let` constants and
  inline `conceptmap` declarations. Bundled mappings do not use them; the engine
  emits a warning if it sees one.
- **Target list-mode semantics are not fully supported.** The engine recognizes
  these modes but currently uses an append fallback and emits a warning. The
  only bundled conversion currently impacted is HealthcareService R3 -> R2:
  each specialty may become a separate `serviceType` without its required
  `type`, producing invalid DSTU2 output.
- **Automatic resolution of ambiguous StructureMap selection is not supported.**
  The only bundled conversion currently impacted is `ProcedureRequest` R3 -> R2
  with target type `DiagnosticOrder`: two StructureMaps declare that same
  source/target pair (`DiagnosticOrder.fml` and `ProcedureRequestDO.fml`), and
  choosing between them requires clinical knowledge this converter does not
  have. See [CONVERSION-AMBIGUITY.md](CONVERSION-AMBIGUITY.md) for the full list
  of known mapping ambiguities.

## Understanding the result

`chainedConverter.convert()` returns a result object with one report entry per
hop:

```text
{
  resource,       // converted resource
  coverage,       // 'not_reviewed', 'known_gaps', 'best_effort', or 'complete'
  status,         // 'ok' or 'warning'
  hops: [
    {
      fromVer,
      toVer,
      preprocessors,  // omitted when none ran for the hop
      fml_base_conv,  // report for the FML mapping step
      postprocessors, // omitted when none ran for the hop
    },
  ],
}
```

`singleHopConverter.convert()` returns the same per-hop report fields flattened
onto the top-level result, without a `hops` array.

The two most important fields are:

- **resource**: the converted FHIR resource.
- **status**: whether the conversion completed without warnings (**ok**) or with
  warnings (**warning**). Hard failures throw instead of returning a result.

Coverage is separate from runtime status. It describes the capability and
completeness of the FML mapping and any related postprocessors.

### Coverage levels

- **not_reviewed**: the FML mapping has not yet been reviewed for completeness for
  that specific resource type and version pair combination.
- **known_gaps**: the conversion has known gaps that could be improved with
  additional mapping or postprocessing.
- **best_effort**: the conversion has been reviewed and implemented as far as
  practical, but documented limitations remain because some valid source content
  cannot be fully represented in the target version or is intentionally out of
  scope.
- **complete**: the conversion has been reviewed, and no known necessary
  conversion gaps remain for valid supported input.
- **neutral**: the processor or component makes no coverage claim and does not
  change the conversion's running coverage level. This is useful for custom
  processors that add metadata, tags, logging, or other changes that do not
  affect conversion completeness.

The top-level `result.coverage` is normally one of the ordered levels:
**not_reviewed**, **known_gaps**, **best_effort**, or **complete**.
The **neutral** level is mostly seen on individual processor reports,
especially for caller-provided processors.

See [COVERAGE.md](COVERAGE.md) for the current coverage level report.

## Custom pre- and postprocessors

Most users do not need custom processors. If you do, pass them in the optional
fourth argument:

```js
const result = chainedConverter.convert(resource, 'R3', 'R5', {
  preproc: [myPreprocessor],
  postproc: { policy: 'append', psps: [myPostprocessor] },
  checkCoverage: true,
});
```

`preproc` is applied to the first hop for the primary resource - the very first
processor to run. `postproc` is applied to the last hop for the primary resource
- the very last processor to run, so its output is the final result. The
postprocessor `policy` controls
how your postprocessors combine with the package's registered postprocessors
for that hop:

- **append** (default): run package postprocessors first, then yours.
- **replace**: run only the postprocessors specified in the request -
  this may include the package postprocessors if you explicitly include
  them in your list (in any order you deem appropriate). The package
  postprocessors may be obtained using the `getRegistryEntry()`
  function in the public API.

For a specific hop, use keyed `preprocs` or `postprocs`:

```js
const result = chainedConverter.convert(resource, 'R3', 'R5', {
  postprocs: {
    'Questionnaire:R4->R5': { policy: 'replace', psps: [myPostprocessor] },
  },
});
```

In a keyed `preprocs` or `postprocs` entry, the resource type is the type
entering that hop. This also applies when a mapping renames the resource: for
`Sequence` R3 -> `MolecularSequence` R4, use the postprocessor key
`Sequence:R3->R4`, even though the postprocessor receives the converted
`MolecularSequence`.

For `singleHopConverter.convert()`, keyed maps may use either the full
`'Questionnaire:R4->R5'` key or the type-only `'Questionnaire'` key. These are
two spellings of the same entry. If both occur in one map, the later property in
the map takes precedence; their processor lists are not merged, just as if you
specify two entries with the same key.

The package also exports helpers for authoring processors - `makeProcessor`,
`validateProcessorDescriptor`, `makeMessage`, `infoMessage`, `warningMessage`,
and `statusFromMessages`.

The processor contract is documented in [CONTRIBUTING.md](CONTRIBUTING.md) for
contributors and advanced users.

## Examples

A more elaborate example may be found in the repository (not shipped in the
installed npm package). Find it on GitHub at
[examples/conversions.js](examples/conversions.js), then run it from a repo
checkout:

```bash
node examples/conversions.js
```

It demonstrates:

- a single adjacent hop (**R4 -> R5**) that prints a leaf-level diff of what the
  mapping changed,
- a multi-hop chain (**R3 -> R5**) with a real postprocessor applied to one
  specific hop (keyed `Questionnaire:R4->R5`), and
- how to read the result objects.

## Command line

The repository includes a small command-line runner for quick checks and shell
pipelines:

```bash
node bin/convert.js R4 R5 questionnaire-r4.json > questionnaire-r5.json
```

The CLI also supports multi-hop conversion:

```bash
node bin/convert.js R3 R5 questionnaire-r3.json > questionnaire-r5.json
```

You can also read the input resource from stdin:

```bash
cat questionnaire-r4.json | node bin/convert.js R4 R5 > questionnaire-r5.json
```

The converted JSON is written to stdout. A short status summary and any per-hop
warnings are written to stderr. Use `--verbose` to include info messages:

```bash
node bin/convert.js --verbose R3 R4 questionnaire-r3.json > questionnaire-r4.json
```

For a source type with multiple possible targets, select the intended mapping
with `--target-resource-type`:

```bash
node bin/convert.js R4 R3 service-request-r4.json \
  --target-resource-type ProcedureRequest > procedure-request-r3.json
```

## Coverage and contributions

Due to the sheer number of resource type and version pair combinations, this package is meant to
grow incrementally: review one resource type and version pair at a time, add a
postprocessor if needed, test, and then regenerate the coverage report.

In this initial release, reviewed postprocessors are supplied only for
**Questionnaire**. Contributions for other resource types are welcome.

See [COVERAGE.md](COVERAGE.md) for current coverage status.
See [CONTRIBUTING.md](CONTRIBUTING.md) on how to contribute.

## Using the FML engine directly

The public API above runs the FML mapping and package postprocessors together.
If you want the lower-level FML engine without postprocessor orchestration, use
the `./fml-engine` entry point:

```js
import {
  createFmlEngineFactory,
  getAdjacentPairs,
  planHops,
} from '@lhncbc/fml-resource-version-converter/fml-engine';
```

`createFmlEngineFactory()` takes no arguments and uses the complete committed
runtime data. Raw FML roots are maintainer inputs, not runtime configuration.

There is also a lower-level experimental CLI at
`src/fml_base_conv/convert_cli.js` for engine-level testing.

## License

See [LICENSE.md](LICENSE.md).
