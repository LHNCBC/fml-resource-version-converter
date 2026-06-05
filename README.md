### Questionnaire Version Converter

This questionnaire converter converts FHIR&copy; Questionnaire resources between different FHIR versions. 
It includes a library and a command line tool. The FHIR versions currently supported include STU3, R4, and R5, 
and the support for R6 is being considered.

A few general notes:
- The converter assumes that the input questionnaires are valid, and if not, the results may be corrupted.
- The converter continues on in the face of errors, e.g., when a data element from the source version 
  cannot be converted to the target version and will report such incidents at the item level.
- The intention is to always produce a valid questionnaire if the input is valid, although
  there may be data losses, e.g., data elements unable to convert.
- The resulting resource will have the same resource id and url (if present) as the input resource.

#### Installing the package
As with any npm packages, it needs to be installed before use:
<pre>npm install questionnaire-version-converter-lhc</pre>

#### Using the Questionnaire Conversion Library
To make a conversion within javascript apps/code: 
<pre>
import { convert } from 'questionnaire-version-converter';
let resultOjb = convert(qnJson, 'STU3', 'R4');
</pre>
or,
<pre>
import { getConverter } from 'questionnaire-version-converter';
let converter = getConverter('STU3', 'R4');
let resultOjb = converter(qnJson);
</pre>
Where the result object has 3 fields:
- status: the status code:
  - 1: conversion completed with success
  - 0: conversion completed with warning 
  - -1: conversion completed with data loss, i.e., some elements may have been dropped. 
  - -2: conversion aborted due to unexpected errors. 
- message: a list of message objects (may not present) each has the following fields:
  - ctxId: the context id, usually the linkId of the item the message is about, but it can also be
    the questionnaire id if the issue is at the top level.
  - status: statue code or nature of the message, can be 0, -1, or -2 as described above.
  - text: the message text.
- data: the converted questionnaire


#### Using the Command Line Tool
The command line tool may be used to convert questionnaire files, either single resource files or 
resource bundle files, and the result files are written to the output directory specified on the
command line.
- Only .json files will be processed.
- JSON files that aren't FHIR resources or aren't Questionnaire resources will still be written to the
  output directory, as is.
- For resources in a bundle, the resources that aren't Questionnaire resources will be copied as is
  to the output file.


To get detailed usage instructions, run
- node src/qnvconv_cli.js --help

For examples:
- node src/qnvconv_cli.js R4 R5 /tmp/my-questionnaire.json /tmp

Will convert the given questionnaire file (single Questionnaire or bundle) from R4 to R5 and write to the
output file /tmp/my-questionnaire-R5.json (note the -R5 suffix in the result file name).

- node src/qnvconv_cli.js R4 R5 /tmp/my-source-dir/ /tmp/output

Will process every .json file under /tmp/my-source-dir/ (recursively) and write the output
files to /tmp/output, with the same subdirectory structure as the source directory.

### An experimental FML Based Resource Version Converter

This project ships with an experimental, FML (FHIR Mapping Language) based FHIR resource version
converter that executes the HL7 [fhir-corss-version](https://build.fhir.org/ig/HL7/fhir-cross-version)
FML mapping files to convert FHIR resources (of any type) between versions.

Note that the FHIR Cross-Version Mapping Pack itself is still under development, and this converter is
in its own early stage of development and testing and has not yet been integrated into the Questionnaire
version converter, which still uses the hand rolled converting logic.

The plan is to use this FML based converter as the base converter and a layer needs to be built on
top of it to handle anything that the FML mapping files haven't fully covered. This FML based converter
has built-in framework for plugging in pre and/or post processors to support this type of integration.

Interested users may take a look at src/fml_base_conv/convert_cli.js as an example on how to use it.
