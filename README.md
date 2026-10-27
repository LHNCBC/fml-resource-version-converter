# FML-based FHIR Resource Version Converter

This FML-based FHIR Resource Version Converter is a JavaScript package
for converting FHIR resources between FHIR versions by leveraging HL7's
FHIR cross-version FML (FHIR Mapping Language) mapping files.

The HL7's fhir-cross-version project provides FML mapping files for
converting FHIR resources between adjacent FHIR versions. While there are
rare exceptions (as documented in CONVERSION-AMBIGUITY.md), there is
generally one FML mapping file for each **conversion triple** of
(resource-type, from-version, to-version),
where from-version and to-version are adjacent versions. Unless otherwise
specified, this document assumes one FML mapping file per conversion triple.

The base case conversion is to convert a resource of a given type from one
version to the next adjacent version (in either direction), which we refer
to as a "conversion hop", or simply, a **hop**. A conversion between
non-adjacent versions may be performed as a **chain** of hops.

At the core of the package is an FML engine that executes the FML mappings
to make the conversion. However, the mappings can often be incomplete or
contain errors. This package provides a flexible framework for supporting
incremental improvements:
- registries for documenting FML mapping coverage and limitations
- postprocessors may be added/contributed to this package to fill the gaps.
- users may specify custom postprocessors to address any remaining concerns.

Please refer to COVERAGE.md for the current coverage status for specific
conversions. The community is encouraged to help improve this package by
reviewing the FML conversions and by providing postprocessors as needed
to fill the gaps. It's relatively straightforward to address one conversion
triple at a time. Detailed instructions for contributing are in
[CONTRIBUTING.md](CONTRIBUTING.md).

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
console.log(result.coverage);  // effective coverage for this invocation
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
and the FHIR spec. Users of this package normally do not need to worry
about how the runtime data have been built. In case you are curious, the
source datasets and regeneration workflow are documented in
[DATA-MAINTENANCE.md](DATA-MAINTENANCE.md).

The default package entry preloads the runtime data
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

Due to the spec changes from version to version, there are rare cases (details
see CONVERSION-AMBIGUITY.md) where for a given source resource, there are
ambiguities on what the target resource type should be. In such cases, use
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

`targetResourceType` applies only to the primary resource. Target types for
ambiguous contained-resource mappings cannot currently be selected; such a
contained conversion throws. A child-specific target selector is planned for a
future release.

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

`chainedConverter.convert()` supports adjacent pairs and multi-hop paths.
For example, **R3 -> R5** runs as **R3 -> R4 -> R5**.

R4B only has FML mappings to and from R5, and specifically, there is no FML mapping
between **R4 <-> R4B** (not needed).
For conversions between **R3 <-> R4B**, use **R4** instead of
**R4B** when that is acceptable.

## Contained resources

The public converters automatically version-convert each resource in a
resource's `contained[]` array. On every hop, the parent FML mapping runs first,
then each contained resource is converted through its own preprocessor, FML,
and postprocessor stages. The converted children are written back before the
parent's postprocessors run, so those processors see children in the target
version.

FHIR prohibits a contained resource from containing other resources. The
contained-resource orchestration does not renumber or reorder children, or
rewrite local `#id` references. FML mappings and postprocessors remain
responsible for their own output.

If any contained resource cannot be converted, the whole conversion throws. For
example, R5 -> R4 fails for an R5 Questionnaire containing a `Requirements`
resource, which R4 does not have. One possible workaround is to give the parent
a preprocessor for that hop to manipulate the resource so that the conversion
doesn't fail. Take care not to leave dangling references; for example, removing
a child orphans any `#id` references to it. This workaround may not work in all
situations.

For chained conversion, each parent hop contains the flat reports for the
children converted during that hop. Reports are not correlated across hops;
callers that need a child's history can correlate entries by id. This lets a
parent postprocessor add, remove, or reorder children without imposing a report
synchronization rule on the next hop.

## Limitations

The converter converts a resource and its contained resources. Please keep
the following in mind:

- **Bundle entry resources are not yet converted.** The bundle resource itself
  is converted, but each `entry.resource` is carried through as-is. Recursive
  conversion of Bundle entries is planned for a future release.
- **One-to-many conversion is not yet supported.** A future release will handle
  cases such as R2 -> R3 `CarePlan` -> `CarePlan` + `CareTeam` when needed.
- **Ambiguous target selection is limited.** `targetResourceType` (and the CLI
  option `--target-resource-type`) applies only to the primary resource of a
  single-hop conversion. It cannot select targets for contained resources, and
  chained conversion does not support target selection. Child-specific target
  selection may be added in a future release.
- **Reviewed conversions** currently cover a few resource types and versions.
  The FML conversions for other resource types and versions have not been
  reviewed (see [COVERAGE.md](COVERAGE.md)).
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
- Inter-version extension: in some cases the FML mappings add inter-version
  extensions to the target resources, but it's not being done consistently
  across versions and across resource types. At this point, this package
  does not make a general statement on where things stand with regard to
  inter-version extensions.
- **Extensions on primitive companions are not yet converted.** No warning is
  emitted, so the result may be invalid in the target version.
  To be fixed in a future release.
- **Some R4 -> R3 `Library` extensions keep source-version content.** This is due
  to the postprocessor's incomplete repair of FML mapping issues; the remaining
  content is kept without a warning. To be fixed in a future release.

## Conversion notes

Two behaviors are worth knowing before comparing input and output:

- **`meta.profile` is version-adjusted.** A standard FHIR base profile of the
  source version is rewritten to the target version, a base profile of any other
  version is dropped, and, when no concrete profile value remains, the mapping's
  declared target profile is added, for example
  `http://hl7.org/fhir/3.0/StructureDefinition/Questionnaire`. Profiles of your
  own are left untouched. Note that a converted resource therefore carries a
  `meta.profile` even when the input had no `meta` at all, and that these
  version-tagged canonicals come from HL7's cross-version mappings rather than
  from the published specification of the target version.
- **The bundled mappings carry recorded local changes.** The checked-in snapshot
  of HL7's `fhir-cross-version` project is not always identical to its upstream
  commit. Any difference is recorded in `data/fhir-cross-version/sources.yaml`
  and is carried into the runtime data provenance, so the mappings this package
  runs are always traceable.

## Understanding the result

`chainedConverter.convert()` returns a result object with one report entry per
hop:

```text
{
  resource,       // converted resource
  coverage,       // effective coverage for the entire invocation
  status,         // 'ok' or 'warning'
  hops: [
    {
      fromVer,
      toVer,
      preprocessors,  // omitted when none ran for the hop
      fml_base_conv,  // FML report; coverage here is declared coverage
      contained: [    // omitted when no children were converted in this hop
        {
          resource,   // child output before the parent postprocessors
          coverage,   // effective coverage for this child resource-hop
          status,
          preprocessors,
          fml_base_conv,
          postprocessors,
        },
      ],
      postprocessors, // omitted when none ran for the hop
    },
  ],
}
```

`singleHopConverter.convert()` returns the same per-hop report fields flattened
onto the top-level result, without a `hops` array, so its `contained[]` reports
also appear at the top level.

The key fields are:

- **resource**: the converted FHIR resource.
- **coverage**: the effective coverage of all resource-hop conversions performed.
- **status**: whether the conversion completed without warnings (**ok**) or with
  warnings (**warning**). Info messages are reported but do not affect status.
  Hard failures throw instead of returning a result.

### Declared coverage, effective coverage, and runtime status

On the subject of conversion completeness, there are three key concepts:
declared coverage, effective coverage, and runtime status.

**Declared coverage:** A static, input-independent completeness claim made by
the reviewer (maintainer/contributor) for an FML mapping or postprocessor.
It only applies to the primary resource being converted in one resource-hop
without considering its contained resources or bundle entry resources. It
describes general conversion capabilities and not the outcome of particular
invocations.

- For contributors: when adding a postprocessor to the registry, use
  `assertDeclaredCoverage()`. It verifies the descriptor's declared coverage,
  returns the descriptor unchanged, and throws if the declaration does not
  match the registry's expectation. This makes the coverage visible in the
  registry and protects against unintended descriptor changes.

**Effective coverage:** The aggregate of the declared coverages of all the
components actually involved in a particular conversion. For example, a
conversion may involve FML conversion, postprocessor(s), contained resources,
etc., not to mention the multiple hops conversions, e.g., R3 -> R5 via R4.

However, it still describes the "static" coverage of the pipeline and does
not take into account the runtime execution status. There are two types of
coverage aggregations:
- Within one primary resource-hop, effective coverage is the last non-neutral coverage declaration in this
  sequence: the FML declaration, followed by the declarations of the ordered
  postprocessors. By default, a postprocessor may improve the running coverage
  but may not lower it.
- Across separate resource-hop conversions, effective
  coverage is the lowest resource-hop coverage. The aggregation includes every
  resource-hop conversion performed: each primary or child resource converted
  at each version hop, such as R3 -> R4 and R4 -> R5.

**Runtime status:** What was observed while processing the input. The returned
status is ok when no warnings were reported and warning when any warning was
reported. Info messages are reported but do not affect status. A hard failure
throws. Specifically, an error while converting any contained resource aborts
the entire conversion.

Together, effective coverage and runtime status provide the fullest available
assessment of a conversion result, subject to the declared coverage claims.

Runtime engine warnings are non-exhaustive.
See [Scope and limitations of runtime engine warnings](CONTRIBUTING.md#scope-and-limitations-of-runtime-engine-warnings).

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

The top-level `result.coverage` is effective coverage and is normally one of
the ordered levels:
**not_reviewed**, **known_gaps**, **best_effort**, or **complete**.
The **neutral** level is mostly seen on individual processor reports,
especially for caller-provided processors.

Inter-version extension (IVE) round-trip preservation is not part of declared
coverage. A data element preserved solely through an IVE is still considered
lost for coverage purposes because target-version tools may not interpret it.

See [COVERAGE.md](COVERAGE.md) for the current coverage level report.

## Custom pre- and postprocessors

Custom processors may be passed in to further improve or reshape the
conversion the way you want. They may be provided as part of the fourth
argument (options).

### Passing in a single preprocessor and/or postprocessor
```js
const result = chainedConverter.convert(resource, 'R3', 'R5', {
  preproc: [myPreprocessor],
  postproc: { policy: 'append', psps: [myPostprocessor] },
  checkCoverage: true,
});
```

`preproc` is applied to the first hop for the primary resource - the very
first processor to run. `postproc` is applied to the last hop for the primary
resource - the very last processor to run. The postprocessor `policy` controls
how your postprocessors combine with the package's registered postprocessors
for that hop:

- **append** (default): run package postprocessors first, then yours.
- **replace**: run only the postprocessors specified in your request -
  this may include the package postprocessors if you explicitly include
  them in your list (in any order you deem appropriate). The package
  postprocessors may be obtained using the `getRegistryEntry()`
  function in the public API.

### Passing in preprocessors and/or postprocessors for specific hops

To pass in processors for specific hops, use keyed `preprocs` or `postprocs`. In
the example below, the key `'Questionnaire:R4->R5'` identifies the hop from R4
to R5 for the `Questionnaire` resource type.

```js
const result = chainedConverter.convert(resource, 'R3', 'R5', {
  postprocs: {
    'Questionnaire:R4->R5': { policy: 'replace', psps: [myPostprocessor] },
  },
});
```

Keyed maps are reusable configuration. They may contain entries for any
supported direct hop and resource type; entries unused by the current request
or absent from its `contained[]` resources are ignored. Malformed keys and keys
that do not identify a supported direct hop are still rejected.

The same keyed maps are used for the primary resource and contained resources.
An entry runs for every resource whose entering type and hop match its key. If a
parent and one of its contained resources have the same type, the entry runs for
both. The singular `preproc` and `postproc` options remain primary-only.

`preprocs` and `postprocs` may also be lookup functions called as
`(resourceType, fromVersion, toVersion)`:

```js
postprocs: (type, fromVersion, toVersion) =>
  type === 'Library' && fromVersion === 'R4' && toVersion === 'R5'
    ? [myPostprocessor]
    : undefined
```

The converter calls the lookup for the primary resource and each contained
resource on every hop. Return `undefined` when no entry applies; a lookup that
always returns an entry applies it to every converted resource.

In a keyed `preprocs` or `postprocs` entry, the resource type is the type
entering that hop. This also applies when a mapping renames the resource: for
`Sequence` R3 -> `MolecularSequence` R4, use the postprocessor key
`Sequence:R3->R4`, even though the postprocessor receives the converted
`MolecularSequence`.

For `singleHopConverter.convert()`, keyed maps may use either the full
`'Questionnaire:R4->R5'` key or the type-only `'Questionnaire'` key. These are
two spellings of the same entry. If both occur in one map, the later property in
the map takes precedence; their processor lists are not merged, just as if you
specify two entries with the same key in a map.

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

The converted JSON is written to stdout. A short summary with effective
coverage and runtime status, plus any parent or contained-resource warnings,
is written to stderr. Use `--verbose` to include info messages:

```bash
node bin/convert.js --verbose R3 R4 questionnaire-r3.json > questionnaire-r4.json
```

For a source type with multiple possible targets, select the intended mapping
with `--target-resource-type`:

```bash
node bin/convert.js R4 R3 service-request-r4.json \
  --target-resource-type ProcedureRequest > procedure-request-r3.json
```

`--target-resource-type` applies only to the primary resource in an adjacent
conversion. The CLI cannot currently select a target type for an ambiguous
contained resource; that conversion fails with a contextual error.

## Coverage and contributions

Due to the sheer number of resource type and version pair combinations, this
package is meant to grow incrementally: review one conversion triple a time,
add a postprocessor if needed, test, and then regenerate the coverage report.
Contributions are welcome.

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

For one direct conversion:

```js
const input = {
  resourceType: 'Patient',
  active: true,
  name: [{ family: 'Smith', given: ['Jane'] }],
};

const factory = createFmlEngineFactory();

if (!factory.hasMapping(input.resourceType, 'R4', 'R5')) {
  throw new Error('No direct mapping is available');
}

const warnings = [];
const engine = factory.createEngine(input.resourceType, 'R4', 'R5', {
  onWarning: message => warnings.push(message),
});

const output = engine.convert({ input }).resource;
```

- `createFmlEngineFactory()` takes no arguments and returns a factory for the
  bundled mappings.
- `factory.hasMapping(resourceType, fromVer, toVer)` checks whether a direct
  mapping is available.
- `factory.resolveMapping(resourceType, fromVer, toVer, options)` returns the
  selected mapping definition.
- `factory.createEngine(resourceType, fromVer, toVer, options)` creates an
  engine for one adjacent hop. Its optional `options` include:
  - `onWarning(message)`: receives warning diagnostic text.
  - `onInfo(message)`: receives informational diagnostic text.
  - `targetResourceType`: selects the target resource type when the source
    mapping is ambiguous.
  - `strict` (default `false`): throw, instead of warn, when a code cannot be
    translated.
- `engine.convert({ input })` returns `{ resource }`; `output` above is that
  converted FHIR resource (for example, `{ resourceType: 'Patient', ... }`),
  not a conversion report.

This API runs FML mappings only: it does not run package postprocessors or
produce the high-level coverage/status report. For a multi-hop conversion,
call an engine for each hop from `planHops()`.

The engine also converts only the resource it is given. Nested resource
instances, including `contained[]` entries, are copied as data and are not
version-converted. Contained-resource conversion is performed by the public
converters, not at the engine level.

There is also a lower-level experimental CLI at
`src/fml_base_conv/convert_cli.js` for engine-level testing.

## License

See [LICENSE.md](LICENSE.md).
