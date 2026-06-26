import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from "path";
import { getConverter } from '../../../src/hand_rolled_qn_conv/qnvconv.js';
import { newPathFrom } from "../../../src/hand_rolled_qn_conv/cli_util.js";
import {toIntVerExtUrl} from "../../../src/hand_rolled_qn_conv/qnvconv_common.js";

// A map of the supported FHIR versions (mapped to itself)
const FHIR_V = ['STU3', 'R4', 'R4B', 'R5'].reduce((acc, v) => {acc[v] = v; return acc;}, {});
const iveUrl = (fhirVer, urlPath) => `http://hl7.org/fhir/${fhirVer}/StructureDefinition/extension-Questionnaire.item.answerConstraint`
const __dirname= import.meta.dirname;
const testFiles = {
  STU3: path.resolve(__dirname, '../../data/qn-ver-conv-test-stu3base.json'),
  R4: path.resolve(__dirname, '../../data/qn-ver-conv-test-r4base.json'),
  R4B: path.resolve(__dirname, '../../data/qn-ver-conv-test-r4bbase.json'),
  R5: path.resolve(__dirname, '../../data/qn-ver-conv-test-r5base.json'),
  R4_IVE: path.resolve(__dirname, '../../data/qnvconv-test-r4-with-inter-ver-ext.json'),
  R5_IVE: path.resolve(__dirname, '../../data/qnvconv-test-r5-for-inter-ver-ext.json'),
  output: path.resolve(__dirname, '../../data/output')
}

let PROFILE = {
  STU3: 'http://hl7.org/fhir/3.0/StructureDefinition/Questionnaire',
  R4: 'http://hl7.org/fhir/4.0/StructureDefinition/Questionnaire',
  R4B: 'http://hl7.org/fhir/4.3/StructureDefinition/Questionnaire',
  R5: 'http://hl7.org/fhir/5.0/StructureDefinition/Questionnaire'
}

fs.mkdirSync(testFiles.output, {recursive: true});

/**
 * Test questionnaire conversion for the given json file from version vFrom to vTo.
 * @param qnFile the json file for the questionnaire resource to be converted.
 * @param vFrom from FHIR version
 * @param vTo to FHIR version
 * @param callback a callback function that takes 2 parameters:
 *        - converted: boolean, true if converted, false if aborted due to unexpected errors.
 *        - qnFrom: the questionnaire before the conversion
 *        - qnTo: the questionnaire after the conversion.
 * @param options optional conversion options. See the description about the converter
 *        function table at the top of qnvconv.js for more details.
 */
function testQnVerConvFile(qnFile, vFrom, vTo, callback, options) {
  const inRes = JSON.parse(fs.readFileSync(qnFile));
  const converter = getConverter(vFrom, vTo);
  if(! converter) {
    console.log('Unable to obtain converter from %s to %s', vFrom, vTo);
    callback(false);
    return;
  }
  let convRet = converter(inRes, options);

  // write the converted questionnaire and messages to file for possible manual inspection
  fs.writeFileSync(newPathFrom(qnFile, testFiles.output, '-' + vTo, '.json'), JSON.stringify(convRet.data, null, 4));
  fs.writeFileSync(newPathFrom(qnFile, testFiles.output, '-msg-' + vTo, '.json'), JSON.stringify(convRet.message||[], null, 4));

  callback(convRet.status > -2, inRes, convRet.data);
}


/**
 * Test questionnaire conversion from vFrom to vto.
 * @param vFrom the source FHIR version
 * @param vTo the target/to FHIRversion
 * @param callback the function to be called when done. See testQnVerConvFile() for more details.
 * @param options optional conversion options. See testQnVerConvFile() for more details.
 */
function testQnVerConv(vFrom, vTo, callback, options) {
  const qnFile = testFiles[vFrom];
  testQnVerConvFile(qnFile, vFrom, vTo, callback, options);
}


describe('FHIR Questionnaire version conversion', function() {
  it('should work from STU3 to R4', function(done) {
    testQnVerConv(FHIR_V.STU3, FHIR_V.R4, (converted, qnFrom, qnTo) => {
      assert(!!converted);
      assert.equal(qnTo.meta.profile[0], PROFILE.R4);
      assert(qnTo.meta?.tag?.find(t => t.code === 'lhc-qnvconv-STU3-to-R4')); // the conversion is tagged

      let x002 = qnTo.item.find(t => t.linkId === '/X-002');
      assert(x002);
      assert.equal(x002.enableWhen[0].operator, '=');
      assert.equal(x002.initial[0].valueString, 'Mint');

      let x003 = qnTo.item.find(t => t.linkId === '/X-003');
      assert(x003);
      assert.equal(x003.answerOption[0].valueCoding.code, 'c');

      let x011 = qnTo.item.find(t => t.linkId === '/X-011');
      assert(x011);
      assert.equal(x011.enableWhen[0].operator, 'exists');
      assert.equal(x011.enableWhen[0].answerBoolean, true);

      done();
    });
  });


  it('should work from R4 to STU3 (tag conv history by default)', function(done) {
    testQnVerConv(FHIR_V.R4, FHIR_V.STU3, (converted, qnFrom, qnTo) => {
      assert(!!converted);
      assert(qnTo.meta.tag.find(t => t.code === 'lhc-qnvconv-R4-to-STU3')); // the conversion is tagged
      assert(!qnTo.derivedFrom);

      let x002 = qnTo.item.find(t => t.linkId === '/X-002');
      assert(x002);
      assert(!x002.enableWhen[0].operator);
      assert.equal(x002.enableWhen[0].answerString, 'ice cream');
      assert.equal(x002.initialString, 'Mint');

      let x003 = qnTo.item.find(t => t.linkId === '/X-003');
      assert(x003);
      assert.equal(x003.option[0].valueCoding.code, 'c');
      assert.equal(Object.hasOwnProperty(x003.option[0].initialSelected), false);
      assert.equal(x003.initialCoding.code, "c");

      let x006 = qnTo.item.find(t => t.linkId === '/X-006');
      assert(x006);
      assert(!x006.enableWhen); // unable to convert operator > to STU3

      let x011 = qnTo.item.find(t => t.linkId === '/X-011');
      assert(x011);
      assert(x011.enableWhen[0].hasOwnProperty('hasAnswer'));

      done();
    });
  });

  it('should work from R4 to R5 (with conv history tagging disabled)', function(done) {
    testQnVerConv(FHIR_V.R4, FHIR_V.R5, (converted, qnFrom, qnTo) => {
      assert(!!converted);
      assert(! qnTo.meta.tag.find(t => t.code === 'lhc-qnvconv-R4-to-R5')); // the conversion is tagged

      let x003 = qnTo.item.find(t => t.linkId === '/X-003');
      assert(x003);
      assert.equal(x003.type, "coding"); // choice to coding

      let x010 = qnTo.item.find(t => t.linkId === '/X-010');
      assert(x010);
      assert(x010.answerConstraint, 'optionsOrString');
      assert(x010.type, 'coding');

      let x011 = qnTo.item.find(t => t.linkId === '/X-011');
      assert(x011);

      done();
    }, {tag_conv: false});
  });

  it('should work from R5 to R4', function(done) {
    testQnVerConv(FHIR_V.R5, FHIR_V.R4, (converted, qnFrom, qnTo) => {
      assert(!!converted);
      assert(qnTo.meta?.tag?.find(t => t.code === 'lhc-qnvconv-R5-to-R4')); // the conversion is tagged

      let x003 = qnTo.item.find(t => t.linkId === '/X-003');
      assert(x003);
      assert.equal(x003.type, "open-choice"); // coding + optionsOrString => open-choice

      let x010 = qnTo.item.find(t => t.linkId === '/X-010');
      assert(x010);
      assert(!x010.answerConstraint); // answerOption + optionsOrType => choice (with loss)

      done();
    });
  });

  // This is just to test that the chained-conversion works
  it('should work from STU3 to R5', function(done) {
    testQnVerConv(FHIR_V.STU3, FHIR_V.R5, (converted, qnFrom, qnTo) => {
      assert(!!converted);
      assert(qnTo.meta?.tag?.find(t => t.code === 'lhc-qnvconv-STU3-to-R5')); // the conversion is tagged

      let x010 = qnTo.item.find(t => t.linkId === '/X-010');
      assert(x010);
      assert(x010.answerConstraint, 'optionsOrString');
      assert(x010.type, 'coding');

      done();
    });
  });

  // The questionnaires are the same before and after, and the conversion path has been tested
  // in the STU3 to R5 conversion above. Only need to test the changes in meta.
  it('should work from R4 to R4B', function(done) {
    testQnVerConv(FHIR_V.R4, FHIR_V.R4B, (converted, qnFrom, qnTo) => {
      assert(!!converted);
      assert.equal(qnTo.meta.profile[0], PROFILE.R4B);
      assert(qnTo.meta?.tag?.find(t => t.code === 'lhc-qnvconv-R4-to-R4B')); // the conversion is tagged
      done();
    });
  });

  // The questionnaires are the same before and after, and the conversion path has been tested
  // in the STU3 to R5 conversion above. Only need to test the changes in meta.
  it('should work from R4B to R4', function(done) {
    testQnVerConv(FHIR_V.R4B, FHIR_V.R4, (converted, qnFrom, qnTo) => {
      assert(!!converted);
      assert.equal(qnTo.meta.profile[0], PROFILE.R4);
      assert(qnTo.meta?.tag?.find(t => t.code === 'lhc-qnvconv-R4B-to-R4')); // the conversion is tagged
      done();
    });
  });
});

describe('FHIR Questionnaire version conversion', function() {
  it('should include inter-version extension when appropriate (R5 to R4)', function(done) {
    testQnVerConvFile(testFiles["R5_IVE"], FHIR_V.R5, FHIR_V.R4, (converted, qnFrom, qnTo) => {
      assert(!!converted);
      let verAlgIVE = qnTo.extension.some(ext => ext.url === toIntVerExtUrl('5.0', 'Questionnaire.versionAlgorithm'));
      assert(verAlgIVE);

      let x001 = qnTo.item.find(t => t.linkId === '/X-001');
      assert(x001);
      assert(! x001.extension); // perfect conversion, no need to preserve anything with inter-version extension.

      let x002 = qnTo.item.find(t => t.linkId === '/X-002');
      assert(x002);
      let acIVE = x002.extension.some(ext => ext.url === toIntVerExtUrl('5.0', 'Questionnaire.item.answerConstraint'));
      assert(acIVE);

      done();
    }, {interVerExt: true});
  });

  it('should recover inter-version extension when appropriate (R4 to R5)', function(done) {
    testQnVerConvFile(testFiles["R4_IVE"], FHIR_V.R4, FHIR_V.R5, (converted, qnFrom, qnTo) => {
      assert(!!converted);
      assert.equal(qnTo.versionAlgorithmCoding.code, 'semver');
      assert(! qnTo.extension.some(ext => ext.url.startsWith(toIntVerExtUrl('5.0', 'Questionnaire'))));

      let x001 = qnTo.item.find(t => t.linkId === '/X-001');
      assert(x001);
      let acIVE = x001.extension?.some(ext => ext.url === toIntVerExtUrl('5.0', 'Questionnaire.item.answerConstraint'));
      assert(! acIVE);
      assert.equal(x001.answerConstraint, 'optionsOrType');

      done();
    });
  });
});
