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
import { chainedConverter } from '@lhncbc/fml-resource-version-converter';

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
console.log(result.coverage);  // 'not_reviewed', 'known_gaps', 'best_effort', or 'complete'
```

**chainedConverter.convert(resource, fromVer, toVer)** throws when the request
cannot be run, such as an unknown version token, the same source and target
version, an unknown resource type, or an unsupported version path.

The input resource is deep-cloned before conversion. Your original resource object
is not modified.

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
  is planned for a future release.
- **Reviewed postprocessors are supplied only for Questionnaire.** Other resource
  types are converted by the FML mapping alone (see [COVERAGE.md](COVERAGE.md)),
  and more postprocessors may be added in future releases. You certainly can
  supply your own postprocessors as needed - and better yet, contribute
  them back to the project.
- **A few FML language features are not yet implemented:** `let` constants,
  inline `conceptmap` declarations, and the `share`/`collate` target list
  modes. These are not used by the current HL7 cross-version mapping files,
  and current conversions are not affected. The engine will emit a warning
  message if it sees one. The features will be implemented in a future release.

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

For `singleHopConverter.convert()`, keyed maps may use either the full
`'Questionnaire:R4->R5'` key or the type-only `'Questionnaire'` key.

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
with per-hop postprocessors, and - commented out - how contained resource types
would be targeted once contained-resource support is available.

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

There is also a lower-level experimental CLI at
`src/fml_base_conv/convert_cli.js` for engine-level testing.

## License

See [LICENSE.md](LICENSE.md).
