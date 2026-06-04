

// Command line interface for FHIR Questionnaire resources conversion between versions.
// As of 2025-02-07, it supports conversion between any of these versions: STU3, R4, and R5.
// See the commander description below on the usage details.


import * as fs from 'fs';
import * as path from'path';
import { program as commander} from "commander";

import { getConverter, supportedVersions } from './qnvconv.js';
import { updateRetStatus, createMsg } from './qnvconv_common.js';
import { newPathFrom } from'./cli_util.js';

commander.showHelpAfterError(); // instruct commander to show full help message on invalid command line arguments.
commander
  .option('-v, --verbosity <number>', 'message display level: 0 - very brief; 1 - brief; 2 - detailed.',
    (x)=>parseInt(x), 1) // there seems to be a bug, using parseInt alone doesn't work when option value equals default.
  .option('-p, --pretty', 'whether to enable pretty print when writing results to file', false)
  .argument('<version-from>', 'the FHIR version for the input questionnaires')
  .argument('<version-to>', 'the target version for the converted questionnaires')
  .argument('<input-path>', 'the path for the input file or directory - only .json files will be processed.')
  .argument('<output-dir>', 'output directory (must exist).')
  .description('Converting questionnaire resources between FHIR versions. Note that the output files will be ' +
    'put under the output-dir, where the output file names are created based on the input file names. ' +
    'For example, for converting input file "my-file.json" to R5, the output file name is "my-file-R5.json' )
  .action((vFrom, vTo, inputPath, outputDir) => {
    // console.log(JSON.stringify(commander.opts(), null, 4)); process.exit(0);
    processPath(inputPath, outputDir, vFrom, vTo, commander.opts());
  })
  .parse(process.argv);


/**
 * Convert the resource (or resources) in the given path (file or directory).
 * @param inPath the input questionnaire file (or directory) name. Directories will be searched
 *        recursively for .json file to be processed.
 * @param outDir output directory - the output file names are created based on the input file names
 *        by adding the target FHIR version as file name suffix, e.g., if the input file name is
 *        my-qn.json and the target/output version is R5, the output file name will be: my-qn-R5.json
 * @param vFrom the FHIR version of the input questionnaires
 * @param vTo the FHIR version of the output questionnaires
 * @param opts conversion options. Currently, there are two options, verbosity and pretty.
 */
function processPath(inPath, outDir, vFrom, vTo, opts) {
  let stats = fs.statSync(inPath);
  if (stats.isDirectory()) {
    stats.num_dir += 1;
    fs.readdirSync(inPath, {withFileTypes: true}).forEach(entry => {
      let subOutDir = entry.isDirectory()? path.join(outDir, entry.name): outDir;
      processPath(path.join(inPath, entry.name), subOutDir, vFrom, vTo, opts);
    });
  }
  else if(inPath.match(/.+\.json$/)) {
    stats.num_json_file += 1;
    const outPath = newPathFrom(inPath, outDir, '-' + vTo, '.json');
    processResFile(inPath, outPath, vFrom, vTo, opts);
  }
  else {
    stats.num_file_ignored += 1;
    console.log('==== Ignoring: ', inPath);
  }
}


/**
 * Process the given file, which can be a single resource or a bundle.
 * @param inPath the input json file name
 * @param outPath the output file name
 * @param vFrom the FHIR version of the input questionnaires
 * @param vTo the FHIR version of the output questionnaires
 * @param opts conversion options, currently only has one option, verbosity
 * @return true if successful, false if error(s) occurred
 */
function processResFile(inPath, outPath, vFrom, vTo, opts) {
  console.log('==== converting', inPath);
  let converter = getConverter(vFrom, vTo);
  if(! converter) {
    console.error('Unable to convert from %s to %s. Versions currently supported:', vFrom, vTo, supportedVersions);
    return false;
  }

  let resource = JSON.parse(fs.readFileSync(inPath));
  let result = convertResource(resource, converter, null, opts);

  if(result.data) {
    fs.mkdirSync(path.dirname(outPath), {recursive: true});
    fs.writeFileSync(outPath, JSON.stringify(result.data, null, opts.pretty? 4: 0));
    console.log('==== converted questionnaire written to:', outPath);
    if(result.message) {
      console.log("==== Info/warn/error messages registered during the conversion");
      console.error(JSON.stringify(result.message, null, 4));
    }
  }
  else {
    console.error('%s: result.data not set, conversion might have failed.', inPath);
    return false;
  }
  return true;
}


/**
 * Convert the questionnaire resource (or resources if it's a bundle) using the given version converter.
 * Note that resources that aren't questionnaires will not be changed and returned as they are.
 * @param res a questionnaire resource or a bundle
 * @param converter the converter to use.
 * @param parentIdPath optional, it should be provided if and only if the given resource is in a bundle,
 *        and this path is the resource id path starting from the top level.
 *        It's used to put a context in the displayed messages.
 * @param opts conversion options, currently only has one option, verbosity
 * @return the result object as described in updateRetStatus(). Specifically, the data field is the
 *         converted resource.
 */
function convertResource(res, converter, parentIdPath, opts) {
  if(res.resourceType === 'Questionnaire') {
    let result = converter(res);
    let idPath = [...(parentIdPath || []), res.id].join('.');
    if(opts.verbosity > 0) {
      console.log('Conversion status for %s: %s (1: success; 0: with-warning; -1: with-loss)', idPath, result.status);
    }
    if(opts.verbosity > 1) { // slightly formatted warning/error message recorded during conversion.
      console.log('Conversion messages for %s:\n%s\n', idPath,
        (result.message || []).map(m => [m.status || ' 0', m.ctxId, m.text].join(' | ')).join('\n') || '[]');
    }
    return result;
  }
  else if(res.resourceType === 'Bundle') {
    parentIdPath = [...(parentIdPath || []), res.id || '#unknown-bundle#'];
    let bundleRet = {status: 1, data: res};
    res.entry.forEach(ent => {
      let result = convertResource(ent.resource, converter, parentIdPath, opts);
      ent.resource = result.data;
      updateRetStatus(bundleRet, result.status, result.message);
    });
    return bundleRet;
  }
  else {
    let idPath =  [...(parentIdPath||[]), res.id || '#unknown-qn#'].join('.');
    console.log('Not a Questionnaire nor a Bundle (returned as is): %s', idPath);
    return {status: 0, data: res, message: [createMsg(idPath, 0, 'Not a Questionnaire nor bundle.')]}
  }
}
