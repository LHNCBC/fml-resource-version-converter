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
Direct support for such chained conversions is planned for a future release.

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
import { convertSingleHop } from '@lhncbc/fml-resource-version-converter';

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

const result = convertSingleHop(questionnaireR4, 'R4', 'R5');

console.log(result.resource);  // the converted R5 Questionnaire
console.log(result.status);    // 'ok' or 'warning'
console.log(result.coverage);  // 'not_reviewed', 'known_gaps', 'best_effort', or 'complete'
```

**convertSingleHop(resource, fromVer, toVer, opts?)** throws when the request cannot be
run, such as an unknown version token, the same source and target version, an
unknown resource type, or a version pair with no direct FML mapping.

The input resource is deep-cloned before conversion. Your original resource object
is not modified.

Because resources are sometimes renamed or split between FHIR versions, a
source resource type can map to more than one target type on a single hop. Use
`opts.targetResourceType` to assert the intended target:

```js
// R4 -> R3: a ServiceRequest may become a ProcedureRequest or a ReferralRequest,
// so the target type must be stated explicitly.
const result = convertSingleHop(serviceRequestR4, 'R4', 'R3', {
  targetResourceType: 'ProcedureRequest',
});
```

`targetResourceType` names the **intended target type**. It is **required**
only when the source resource maps to more than one target on the hop (as with
`ServiceRequest` R4->R3 above); for a one-to-one mapping it is optional. When
supplied, it is checked against the target type declared by the FML
StructureMap, so a mismatched value is rejected rather than silently ignored.

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

This release exposes a single-hop conversion API. If you need **R3 -> R5**, call
the converter once for **R3 -> R4** and then again for **R4 -> R5**. Direct support
for multi-hop conversions is planned for a future release.

R4B only has FML mappings to and from R5, and specifically, there is no FML mapping
between **R4 <-> R4B** (not needed).
For conversions between **R3 <-> R4B**, use **R4** instead of
**R4B** when that is acceptable.

## Limitations

This initial release focuses on the single-hop conversion of a top-level
resource. Please keep the following in mind:

- **Contained resources are not version-converted.** A resource's `contained[]`
  entries are carried through as-is and are not converted to the target version.
  If your resource holds contained resources that must match the target version,
  convert them separately for now. Automatic conversion of contained resources
  is planned for a future release, at which point the conversion report will
  include a per-contained-resource status you can check.
- **Bundle entry resources are not version-converted.** Bundle structure is
  mapped, but each `entry.resource` is carried through as-is. Recursive
  conversion of Bundle entries is planned for a future release.
- **Non-adjacent versions require manual chaining.** Only direct (adjacent) FML
  hops are supported by a single call. For a conversion such as **R3 -> R5**, call
  the converter once for **R3 -> R4** and then again for **R4 -> R5**. Automatic
  multi-hop chaining is planned for a future release.
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

A successful conversion returns a result object:

```text
{
  resource,       // converted resource
  coverage,       // 'not_reviewed', 'known_gaps', 'best_effort', or 'complete'
  status,         // 'ok' or 'warning'
  fml_base_conv,  // report for the FML mapping step
  postprocessors, // reports for postprocessors, omitted when none ran
  preprocessors,  // reports for caller preprocessors, omitted when none ran
}
```

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
const result = convertSingleHop(resource, 'R3', 'R4', {
  preprocs: [myPreprocessor],
  postprocs: [myPostprocessor],
  postprocessPolicy: 'append',
  checkCoverage: true,
});
```

**postprocessPolicy** controls how your postprocessors combine with the package's
registered postprocessors (if any):

- **append** (default): run package postprocessors first, then yours.
- **replace**: run only the postprocessors specified in the request -
  this may include the package postprocessors if you explicitly include
  them in your list (in any order you deem appropriate). The package
  postprocessors may be obtained using the `getRegistryEntry()`
  function in the public API.

The processor contract is documented in [CONTRIBUTING.md](CONTRIBUTING.md) for
contributors and advanced users.

## Command line

The repository includes a small command-line runner for quick checks and shell
pipelines:

```bash
node bin/convert.js R4 R5 questionnaire-r4.json > questionnaire-r5.json
```

You can also read the input resource from stdin:

```bash
cat questionnaire-r4.json | node bin/convert.js R4 R5 > questionnaire-r5.json
```

The converted JSON is written to stdout. A short status summary and any warnings
are written to stderr. Use `--verbose` to include info messages:

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

There is also a lower-level experimental CLI at
`src/fml_base_conv/convert_cli.js` for engine-level testing.

## License

See [LICENSE.md](LICENSE.md).
