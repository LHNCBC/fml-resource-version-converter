# FML-based FHIR Resource Version Converter

This FML-based FHIR Resource Version Converter is a JavaScript package
designed to be a general, extensible framework to support the conversion
of FHIR resources between versions by leveraging the HL7 FHIR cross-version
FML (FHIR Mapping Language) mapping files.

At the core of the package is an FML engine that executes these mappings.
The mappings handle most data elements, but some still contain gaps. The
package provides a framework for:
- documenting FML mapping coverage and limitations
- adding postprocessors incrementally to improve conversions
- chaining conversions between non-adjacent versions, such as R3 to R5

As a baseline, this package supports every conversion for which a bundled
FML mapping is available, to the extent covered by that mapping. Building on
that baseline:

- Individual FML mappings need to be reviewed and gaps identified.
- Identified gaps can be addressed with postprocessors where possible.
- This package currently ships with postprocessors for a limited number of
  resource types and version pairs.
- The community is encouraged to contribute by reviewing the FML conversions
  and by providing postprocessors to improve the conversion. Detailed instructions
  for contributing are in [CONTRIBUTING.md](CONTRIBUTING.md).

Here are a few key terms used in this package:

**Conversion tuple:** A combination of resource type, source version, and target
version. Where the context is clear, this document uses **conversion** as
shorthand. For a single-hop conversion, the versions are adjacent and a bundled
FML mapping exists for that combination. For example,
`data/fhir-cross-version/input/R4toR5/Patient4to5.fml`
is the FML mapping file for converting a Patient resource from R4 to R5.

**Onboarding:** the term onboarding is used to describe the process of
reviewing an FML conversion mapping and adding postprocessors as needed to
achieve the best conversion currently practical. Therefore, a fully
onboarded conversion is one that meets the following criteria:
- the FML mapping has been reviewed for completeness and correctness
- any known gaps in the FML mapping have been addressed to the fullest extent
  possible with postprocessors
- the review status and postprocessors (where applicable) have been documented and
  registered in the postprocessor registry (see [CONTRIBUTING.md](CONTRIBUTING.md)
  for details).

Reviewed conversions currently cover:
- **Binary (R2 <-> R3, R3 <-> R4, R4 <-> R5, and R4B <-> R5)**
- **CodeSystem (R3 <-> R4, R4 <-> R5, and R4B <-> R5)**
- **Library (R3 <-> R4, R4 <-> R5, and R4B <-> R5)**
- **Questionnaire (R3 <-> R4, R4 <-> R5, and R4B <-> R5)**
- **ValueSet (R3 <-> R4, R4 <-> R5, and R4B <-> R5)**

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
import { chainedConverter, singleHopConverter } from '@lhncbc/fml-resource-version-converter';

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

const result = chainedConverter.convert(questionnaireR4, 'R4', 'R5');

console.log(result.resource);  // the converted R5 Questionnaire
console.log(result.status);    // 'ok' or 'warning'
console.log(result.coverage);  // effective coverage for this invocation
```

**chainedConverter.convert(resource, fromVer, toVer)** throws when the request
cannot be run, such as an unknown version token, the same source and target
version, an unknown resource type, or an unsupported version path.

The input resource is deep-cloned before conversion. Your original resource object
is not modified.

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

`chainedConverter.convert()` supports adjacent pairs and multi-hop paths along
the supported lanes. For example, **R3 -> R5** runs as **R3 -> R4 -> R5**.
Use `singleHopConverter.convert()` only when you specifically want the flat
single-hop result shape for one adjacent pair.

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

For chained conversion, each parent hop contains the flat reports for the
children converted during that hop. Reports are not correlated across hops;
callers that need a child's history can correlate entries by id. This lets a
parent postprocessor add, remove, or reorder children without imposing a report
synchronization rule on the next hop.

## Limitations

Please keep the following in mind:

- **Bundle entry resources are not version-converted.** Bundle structure is
  mapped, but each `entry.resource` is carried through as-is. Recursive
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
the author for an FML mapping or postprocessor. It describes general conversion
capabilities regardless of a particular invocation.

- When adding a postprocessor to the registry, use
  `assertDeclaredCoverage()`. It verifies the descriptor's declared coverage,
  returns the descriptor unchanged, and throws if the declaration does not
  match the registry's expectation. This makes the coverage visible in the
  registry and protects against unintended descriptor changes.

**Effective coverage:** Coverage derived for the conversion pipelines used by
a particular invocation.

- It is based on the declared coverage of the FML mappings and postprocessors
  actually used.
- It depends on the conversion's structure and configuration: resource types,
  contained-resource types, source and target versions, and caller-provided
  postprocessors. Bundle entry resources will participate once their conversion
  is supported. It does not depend on input values or runtime diagnostics.
- There are two types of coverage aggregations: (1) Within one resource-hop,
  effective coverage is the last non-neutral coverage declaration in this
  sequence: the FML declaration, followed by the declarations of the ordered
  postprocessors. By default, a postprocessor may improve the running coverage
  but may not lower it. (2) Across separate resource-hop conversions, effective
  coverage is the lowest resource-hop coverage. The aggregation includes every
  resource-hop conversion performed: each primary or child resource converted
  at each version hop, such as R3 -> R4 and R4 -> R5.

**Runtime status:** What was observed while processing the input. The returned
status is ok when no warnings were reported and warning when any warning was
reported. Info messages are reported but do not affect status. A hard failure
throws.

Together, effective coverage and runtime status provide the fullest available
assessment of a conversion result, subject to the declared coverage claims.

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

`getRegistryEntry()` returns the FML declaration and package postprocessor
descriptors. It does not return an overall coverage field; effective coverage
can only be derived from the pipeline actually used by an invocation.

For a specific hop, use keyed `preprocs` or `postprocs`:

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

## Migration notes

- `convertSingleHop(resource, fromVer, toVer)` is now
  `singleHopConverter.convert(resource, fromVer, toVer)` for adjacent one-hop
  conversions with the flat result shape.
- For normal one-shot conversion, use
  `chainedConverter.convert(resource, fromVer, toVer)`. It supports multi-hop
  paths and always returns `hops[]`.
- Manual chains such as **R3 -> R4** followed by **R4 -> R5** can usually become
  one `chainedConverter.convert(resource, 'R3', 'R5')` call.
- Old single-hop `preprocs: [...]` and `postprocs: [...]` array options are now
  `preproc: [...]` and `postproc: [...]` for outer-boundary processors. Keyed
  `preprocs` and `postprocs` are maps or lookup functions.
- `postprocessPolicy` is now part of the postprocessor entry:
  `{ policy: 'append' | 'replace', psps: [...] }`.

## Examples

A runnable example script is included in the repository:

```bash
node examples/conversions.js
```

It demonstrates a single adjacent-hop conversion, a simple multi-hop chain with
one boundary preprocessor and postprocessor, a non-trivial chain (**R3 -> R5**)
with per-hop postprocessors, and contained resources targeted by their own
type-and-hop keys.

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

Due to the sheer number of resource type and version pair combinations, this package
is meant to grow incrementally: review one resource type and version pair at a time,
add a postprocessor if needed, test, and then regenerate the coverage report.

Reviewed conversions currently cover only a few resource types and versions.
Contributions for other resource types and version pairs are welcome.

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

There is also a lower-level experimental CLI at
`src/fml_base_conv/convert_cli.js` for engine-level testing.

## License

See [LICENSE.md](LICENSE.md).
