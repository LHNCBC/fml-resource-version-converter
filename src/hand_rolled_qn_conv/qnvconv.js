
// Converting FHIR Questionnaire resources between versions.
// The current conversions are hand-coded. If the scope goes beyond a few versions of
// questionnaires, other options, such as some template or DSL languages, should be explored.
// Specifically, explore the "<version> Conversions" tab on the HL7's page on Questionnaire, which
// was discovered after the work is done, e.g., for R4:
//   https://hl7.org/fhir/R4/questionnaire-version-maps.html
//
// Notes:
// - it is assumed that the input questionnaire resource is valid
// - conversion continues in the face of errors but records any warnings or errors at the
//   item level and returned in the result object (result.message) - see updateRetStatus()
//   for more details on the format of result objects returned by the functions.
// General notes on Questionnaire.meta:
// - preserved: meta.version, meta.lastUpdated(?), meta.source
// - updated: add a new tag that indicates the conversion
// - updated: remove all existing profiles and add the profile for the target version;

import {qnR3ToR4, qnR4ToR3} from './qnvconv_stu3_r4.js';
import {qnR4ToR5, qnR5ToR4} from './qnvconv_r4_r5.js';
import {updateRetStatus} from './qnvconv_common.js';


// The converter function table
// There is an entry for each supported FHIR version. A converter function has the signature:
//     <converter_func>(questionnaire, options)
// Where:
// @param questionnaire: required, the questionnaire resource to be converted
// @param options: optional, an object with 0 or more of the following fields:
//   - tag_conv: boolean (default true), whether to add a meta tag to record this conversion
//   - interVerExt: boolean (default false), whether to add the inter-version extensions
//     during down-conversion, or whether to recover data from such extensions during
//     up-conversion.
//     Note that this is an experimental feature, it's only implemented for conversions
//     between R4 and R5, and is disabled by default.
//     For more details on inter-version extensions, please refer to:
//         https://build.fhir.org/versions.html#extensions
// @return an object with the fields status, data, and message, where data is the resulting
//     resource after conversion. See updateRetStatus() for more details on status and message.
//
// The entries must be listed in strictly increasing order by the FHIR version. An entry
// has the following fields:
// - ver: the FHIR version
// - up_conv: the converter function for converting from this version to the next higher
//   version in this list.
// - down_conv: the converter function for converting from this version to the next lower
//   version in this list
// - profile: the profile string for the FHIR version.
// - index: the index number in this list - this is added automatically at the end using
//   the map() operation.
//
// Note that:
// - R4 and R4B are the same for Questionnaire resources but with different meta.profile.
// - the tag and profile for the resulting questionnaire are set outside the converters.
const qnConverterTable = [
  { ver: 'STU3',
    up_conv: qnR3ToR4,
    profile: 'http://hl7.org/fhir/3.0/StructureDefinition/Questionnaire'
  },
  { ver: 'R4',
    up_conv: qnNoOpConv,
    down_conv: qnR4ToR3,
    profile: 'http://hl7.org/fhir/4.0/StructureDefinition/Questionnaire'
  },
  { ver: 'R4B',
    up_conv: qnR4ToR5,
    down_conv: qnNoOpConv,
    profile: 'http://hl7.org/fhir/4.3/StructureDefinition/Questionnaire'
  },
  { ver: 'R5',
    down_conv: qnR5ToR4,
    profile: 'http://hl7.org/fhir/5.0/StructureDefinition/Questionnaire'
  },
].map((v, index) => { v.index = index; return v; });

// A mapping from the FHIR version to the version info object in the qnConverterTable above.
const qnConverterMap = qnConverterTable.reduce((acc, v) => { acc[v.ver] = v; return acc; }, {});

const supportedVersions = Object.keys(qnConverterMap);


/**
 * A NO-OP converter that does nothing and return the input questionnaire itself in the data field.
 * @param qn the input questionnaire to convert
 * @return the result object that has the fields: data, status, and message, where
 *         data is the converted questionnaire. See updateRetStatus() for more details.
 */
function qnNoOpConv(qn) {
  return {status: 1, data: qn}
}


export {
  getConverter,
  convert,
  supportedVersions
};


/**
 * Get the converter function for converting from version vFrom to vTo. If the two
 * versions aren't adjacent (e.g., STU3 to R5), the returned function will be a newly
 * composed anonymous function that performs the conversion one version step at a time.
 * @param vFrom the from version
 * @param vTo the to/target version.
 * @return A converter function that performs the conversion, or null if the versions are
 *         invalid or if the conversion isn't supported yet. See the converter function table
 *         at the top of this file for more details.
 */
function getConverter(vFrom, vTo) {
  if(vFrom === vTo || !qnConverterMap[vFrom] || !qnConverterMap[vTo]) {
    return null;
  }

  let vIndexFr = qnConverterMap[vFrom].index;
  let vIndexTo = qnConverterMap[vTo].index;
  let vIndexChain = Array(Math.abs(vIndexTo-vIndexFr)).fill(0).map((_, i) => vIndexFr + (vIndexFr < vIndexTo? i: -i));

  let funcKey = vIndexFr < vIndexTo? 'up_conv': 'down_conv';
  let converters = vIndexChain.map(vIndex => qnConverterTable[vIndex][funcKey]);

  /**
   * The combined converter function that executes the chain of converters in sequence.
   * @param qnJson the questionnaire resource to be converted
   * @param options optional conversion options. See the description about the converter
   *        function table at the top of this file for more details.
   * @return the result object that has the fields: data, status, and message, where
   *         data is the converted questionnaire. See updateRetStatus() for more details
   */
  function chainedConverter(qnJson, options) {
    let stepResult = {data: qnJson};
    let finalResult = {status: 1};

    for(let converter of converters) {
      stepResult = converter(stepResult.data, options);
      updateRetStatus(finalResult, stepResult.status, stepResult.message);
    }
    if(stepResult.data) {
      finalResult.data = stepResult.data;
      updateMeta(finalResult.data, vFrom, vTo, options);
    }

    return finalResult;
  }
  chainedConverter._versionChain = vIndexChain.map(idx => qnConverterTable[idx].ver); // for internal evaluation/troubleshooting use.
  chainedConverter._versionChain.push(qnConverterMap[vTo].ver);

  return chainedConverter;
}

/**
 * Update the meta field of the converted questionnaire. Specifically:
 * - remove all existing profiles and set to the profile corresponding to vTo.
 * - add a new tag to record this conversion.
 * @param qn the converted questionnaire resource
 * @param vFrom the FHIR version converted from
 * @param vTo the FHIR version converted to
 * @param options conversion options, optional. If specified, the only field that
 *        matters here is options.tag_conv (boolean, default true), which controls whether to
 *        add a tag to the resulting resource to record this conversion.
 */
function updateMeta(qn, vFrom, vTo, options) {
  qn.meta = qn.meta || {};
  qn.meta.profile = [ qnConverterMap[vTo].profile ];

  if(options?.tag_conv !== false) {
    let convTag = {
      code: `lhc-qnvconv-${vFrom}-to-${vTo}`,
      display: `Converted from ${vFrom} to ${vTo} by the LHC Questionnaire Version Converter`
    };

    (qn.meta.tag = qn.meta.tag || []).push(convTag);
  }
}


/**
 * Convert the given FHIR questionnaire from version vFrom to version vTo.
 * @param qnJson the FHIR questionnaire resource in json
 * @param vFrom the FHIR version of the input questionnaire
 * @param vTo the FHIR version to convert to
 * @param options optional conversion options. See the description about the converter
 *        function table at the top of this file for more details.
 * @return an object with 3 fields:
 *         - status: the status code of the conversion. See updateRetStatus() for more details
 *         - data: the converted questionnaire
 *         - message: a list (may not present) of warning/error message objects. See updateRetStatus() for more details
 */
function convert(qnJson, vFrom, vTo, options) {
  if(! qnConverterMap[vFrom] || ! qnConverterMap[vTo]) {
    throw new Error('Unsupported FHIR version. Versions currently supported are: ' + Object.keys(qnConverterMap).join(', '));
  }
  const convertFunc = getConverter(vFrom, vTo);
  return convertFunc(qnJson, options);
}
