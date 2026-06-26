

// Functions for FHIR Questionnaire conversion between STU3 and R4

import {createMsg, updateRetStatus, findChoiceX} from './qnvconv_common.js';

export {
  qnR3ToR4,
  qnR4ToR3
}

/**
 * Converting the given FHIR questionnaire resource from STU3 to R4.
 * @param r3qn the STU3 questionnaire to convert
 * @return the result object that has the fields: data, status, and message, where
 *         data is the converted questionnaire. See updateRetStatus() for more details.
 */
function qnR3ToR4(r3qn) {
  if(r3qn.resourceType !== 'Questionnaire') {
    return {status: 0, data: r3qn, message: [createMsg(r3qn, 0, 'Not a Questionnaire resource')]}
  }
  let r4qn = JSON.parse(JSON.stringify(r3qn)); // make a deep copy

  let ret = {status: 1, data: r4qn};
  for(let item of r4qn.item || []) {
    let subRet = qnItemR3ToR4(item);
    updateRetStatus(ret, subRet.status, subRet.message);
  }

  return ret;
}


/**
 * Stop processing if the status is -1.
 * @param item
 * @return {{status: number}}
 */
function qnItemR3ToR4(item) {
  let ret = {status: 1, data: item}; // successful

  let ewRet = enableWhenR3ToR4(item);
  updateRetStatus(ret, ewRet.status, ewRet.message);

  let optRet = answerOptionsR3ToR4(item);
  updateRetStatus(ret, optRet.status, optRet.message);

  let {srcX: initialX, toX: valueX} = findChoiceX(item, 'initial', 'value');
  if(initialX) {
    item.initial = [{ [valueX]: item[initialX] }];
    delete item[initialX];
  }

  for(let subItem of item.item || []) {
    let subRet = qnItemR3ToR4(subItem);
    updateRetStatus(ret, subRet.status, subRet.message);
  }

  return ret;
}


/**
 * Convert the given item's enableWhen (list) in-place.
 * @param item the item whose enableWhen is to be converted.
 * @return {{data, status: number}}
 */
function enableWhenR3ToR4(item) {
  let ret = {status: 1, data: item};

  if(!item.enableWhen || !item.enableWhen.length) return ret;

  item.enableWhen = item.enableWhen.map(ew => {
    if(ew.hasOwnProperty('hasAnswer')) {
      ew.operator = 'exists';
      ew.answerBoolean = ew.hasAnswer;
      delete ew.hasAnswer;
    }
    else { // answer[X]
      ew.operator = '=';
      let {srcX: answerX} = findChoiceX(ew, 'answer');
      if(answerX === 'answerUri' || answerX === 'answerAttachment') { // not in R4
        updateRetStatus(ret, -1, createMsg(item, -1, answerX + ' dropped from enableWhen'));
        ew = null; // entry to be filtered out next.
      }
    }
    return ew;
  }).filter(ew => ew);

  if(item.enableWhen.length === 0) {
    delete item.enableWhen;
  }

  return ret;
}


/**
 * Convert the given item's option and options to the R4 counterpart.
 * @param item the item whose option and options are to be converted.
 * @return {{data, status: number}}
 */
function answerOptionsR3ToR4(item) {
  let ret = {status: 1, data: item};

  if(item.options) {
    if(item.options.reference?.startsWith('http')) {
      item.answerValueSet = item.options.reference;
      updateRetStatus(ret, 0, createMsg(item, 0, 'Using item.options.reference as answerOption canonical.'));
    }
    else {
      updateRetStatus(ret, -1, createMsg(item, -1, 'Unable to convert item.options.'));
    }
    delete item.options;
  }

  if(item.option) {
    item.answerOption = item.option;
    delete item.option;
  }

  return ret;
}


/**
 * Converting the given FHIR questionnaire resource from R4 to STU3.
 * @param r4qn the R4 questionnaire to convert
 * @return the result object that has the fields: data, status, and message, where
 *         data is the converted questionnaire. See updateRetStatus() for more details.
 */
function qnR4ToR3(r4qn) {
  if(r4qn.resourceType !== 'Questionnaire') {
    return {status: 0, data: r4qn, message: [createMsg(r4qn, 0, 'Not a Questionnaire resource')]}
  }
  let r3qn = JSON.parse(JSON.stringify(r4qn)); // make a deep copy

  let ret = {status: 1, data: r3qn};
  for(let item of r3qn.item || []) {
    let subRet = qnItemR4ToR3(item);
    updateRetStatus(ret, subRet.status, subRet.message);
  }

  if(r3qn.derivedFrom) {
    delete r3qn.derivedFrom;
    updateRetStatus(ret, -1, createMsg(r3qn, -1, 'derivedFrom is not supported in STU3, deleted'));
  }

  return ret;
}


/**
 * Convert the given item from R4 to STU3, in-place
 * @param item
 * @return {{status: number}}
 */
function qnItemR4ToR3(item) {
  let ret = {status: 1, data: item}; // successful
  if(item.enableBehavior) {
    delete item.enableBehavior;
    updateRetStatus(ret, -1, createMsg(item, -1, 'enableBehavior is not supported in STU3, deleted'));
  }

  let ewRet = enableWhenR4ToR3(item);
  updateRetStatus(ret, ewRet.status, ewRet.message);

  let optRet = answerOptionsR4ToR3(item);
  updateRetStatus(ret, optRet.status, optRet.message);

  if(item.initial && item.initial.length) {
    let valueKey = Object.keys(item.initial[0]).find(f => f.startsWith('value'));
    if(valueKey) {
      let initialKey = 'initial' + valueKey.substring(5);
      item[initialKey] = item.initial[0][valueKey];
    }
    else {
      updateRetStatus(ret, -1, createMsg(item, -1, 'Failed to convert item.initial[0]'));
    }
    if(item.initial.length > 1) {
      updateRetStatus(ret, -1, createMsg(item, -1, 'All but the first item.initial have been dropped.'));
    }
  }
  delete item.initial;

  for(let subItem of item.item || []) {
    let subRet = qnItemR4ToR3(subItem);
    updateRetStatus(ret, subRet.status, subRet.message);
  }

  return ret;
}


/**
 * Convert the given item's enableWhen (list) in-place.
 * @param item the item whose enableWhen is to be converted.
 * @return {{data, status: number}}
 */
function enableWhenR4ToR3(item) {
  let ret = {status: 1, data: item};
  if(!item.enableWhen || !item.enableWhen.length) return ret;

  item.enableWhen = item.enableWhen.map(ew => {
    if(ew.operator === 'exists') {
      ew.hasAnswer = ew.answerBoolean;
      delete ew.answerBoolean;
    }
    else if(ew.operator !== '=') {
      updateRetStatus(ret, -1, createMsg(item, -1, 'Unable to convert enableWhen with operator ' + ew.operator));
      ew = null; // to be filtered out next.
    }
    if(ew) {
      delete ew.operator;
    }
    return ew;
  }).filter(ew => ew);

  if(item.enableWhen.length === 0) {
    delete item.enableWhen;
  }

  return ret;
}


/**
 * Convert the given item's answerValueSet and answerOption from R4 to their counterparts in STU3.
 * @param item the item whose enableWhen is to be converted.
 * @return {{data, status: number}}
 */
function answerOptionsR4ToR3(item) {
  let ret = {status: 1, data: item};

  if(item.answerValueSet) {
    item.options = {reference: item.answerValueSet};
    updateRetStatus(ret, 0, createMsg(item, 0, 'Using item.answerValueSet as item.options.reference.'));
    delete item.answerValueSet;
  }

  if(item.answerOption) {
    let initialXSet = false;
    item.option = item.answerOption.map(opt => {
      if(opt.valueReference) {
        delete opt.valueReference;
        updateRetStatus(ret, -1, createMsg(item, -1, 'deleted answerOption.valueReference'));
        return null; // filter out the valueReference next.
      }

      if(opt.hasOwnProperty('initialSelected')) {
        delete opt.initialSelected;
        let {srcX: valueX, toX: initialX} = findChoiceX(opt, 'value', 'initial');
        if(initialXSet) {
          updateRetStatus(ret, -1, createMsg(item, -1, 'ignored answerOption.initialSelected for ' + opt[valueX]));
        }
        else {
          item[initialX] = opt[valueX];
        }
      }
      return opt;
    }).filter(opt => opt);

    if(item.option.length < item.answerOption.length) {
      updateRetStatus(ret, -1, createMsg(item, -1, 'answerOption entries with valueReference have been dropped.'))
    }
    if(item.option.length === 0) {
      delete item.option;
    }
    delete item.answerOption;
  }

  return ret;
}

