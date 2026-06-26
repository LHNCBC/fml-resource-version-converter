
// Common functions used by the converters.

export {
  createMsg,
  updateRetStatus,
  findChoiceX,
  findIntVerExts,
  toIntVerExtUrl,
  removeInterVerExts,
  addExtension
}


/**
 * Find the choice type [X] key in the given object for the given prefix and optionally create a new
 * key name for the given toPrefix.
 * For example, if the given srcPrefix is "value", this function will try to find the value[X] key (field
 * name) in the given object. If value[X] exists and toPrefix is provided (e.g., "initial"), it will also
 * create the corresponding key name initial[X].
 * @param srcObj the source object
 * @param srcPrefix the source choice [X] prefix, e.g., "value", "initial"
 * @param toPrefix the "to" choice [X] prefix, e.g., "value", "initial". If and only if
 *        toPrefix is given (and the source key exists), a toKey will be created and returned.
 * @return an object (may be empty but not null/undefined) with two possible fields:
 *         - srcX: the srcPrefix[X] key if exists
 *         - toX: the toPrefix[X] key if toPrefix is given and srcX exists
 */
function findChoiceX(srcObj, srcPrefix, toPrefix) {
  let ret = {};
  let srcX = Object.keys(srcObj || {}).find(f => f.startsWith(srcPrefix));
  if(srcX) {
    ret.srcX = srcX;
    if(toPrefix) {
      ret.toX = toPrefix + srcX.substring(srcPrefix.length);
    }
  }
  return ret;
}


/**
 * Create a new message object to be used in the return object of some of the functions.
 * The returned message object has the following fields:
 * - ctxId: the context id, which has the value idOrCtx.linkId || idOrCtx.id || idOrCtx || 'unknown'.
 *          The intention is to use item.linkId for item, questionnaire.id for questionnaire, and
 *          allows the specification of the context id directly.
 * - status: the status code related to this message, the code definition is the same as that
 *           specified in updateRetStatus().
 * - text: the message text.
 * @param idOrCtx an id or context object (questionnaire resource or item) to identify whom the message is about.
 * @param status the conversion status code, see updateRetStatus() for more details
 * @param text the message text.
 * @return the message object created.
 */
function createMsg(idOrCtx, status, text) {
  const ctxId = typeof idOrCtx === 'string' && idOrCtx || idOrCtx?.linkId || idOrCtx?.id || 'unknown';
  return {ctxId, status, text};
}


/**
 * A convenient function for updating the given ret (return) object, which can have the following
 * known fields and any other fields that this function does not care about.
 * . status: the status code, required:
 *    1: conversion completed with-success
 *    0: conversion completed with-warning
 *   -1: conversion completed with-loss, i.e., some elements may have been dropped.
 *   -2: conversion aborted due to unexpected errors.
 * . message: an optional list of message objects, see createMsg() for more details.
 * . data: the optional result value (object or primitive), can be set directly outside of this function.
 * Note that the ret.status is updated only if the given status is less/worse than the existing value.
 * @param ret the result object, see the description above.
 * @param status the status code, see the description above.
 * @param message a single message object or a list of message objects, see the description above.
 * @return the updated ret object.
 */
function updateRetStatus(ret, status, message) {
  if(status < ret.status) {
    ret.status = status;
  }
  if(message) {
    (ret.message = ret.message || []).push(...(Array.isArray(message)? message: [message]));
  }

  return ret;
}


/**
 * Find the inter-version extensions on the given element for the given fields.
 * @param ele a data element (field) of a FHIR resource, on which to find inter-version extensions
 * @param fhirVer the FHIR version
 * @param extPathPrefix inter-version extension url without the field name.
 * @param fields the fields to check if they had been preserved as inter-version extensions
 * @return the list of inter-version extensions or empty list if none.
 */
function findIntVerExts(ele, fhirVer, extPathPrefix, ...fields) {
  if(! ele.extension?.length || !fields?.length) {
    return [];
  }
  let extUrlSet = new Set(fields.map(f => toIntVerExtUrl(fhirVer, extPathPrefix + '.' + f)));

  return ele.extension.filter(ext => extUrlSet.has(ext.url));
}


/**
 * Create FHIR inter-version extension URL for the given FHIR version and extension path as
 * described in https://build.fhir.org/versions.html#extensions.
 * @param fhirVer FHIR version
 * @param ivePath the inter-version extension url path
 * @return the inter-version extension URL
 */
function toIntVerExtUrl(fhirVer, ivePath) {
  return `http://hl7.org/fhir/${fhirVer}/StructureDefinition/extension-${ivePath}`;
}


/**
 * Per spec, check and remove the inter-version extensions on the given element for the given
 * FHIR version. There is no recursion here, that is, sub-elements, if any, will not be checked.
 * @param ele the element whose extensions are to be checked.
 * @param fhirVer the target FHIR version, it's the numeric version#, e.g., 3.0, 4.0, 4.3 (for R4B), 5.0, etc.
 */
function removeInterVerExts(ele, fhirVer) {
  let len = ele?.extension?.length || 0;
  let intVerExtPrefix = `http://hl7.org/fhir/${fhirVer}/StructureDefinition/extension-`;
  for(let i = len - 1; i >= 0; --i) {
    let ext = ele.extension[i];
    if(ext?.url?.startsWith(intVerExtPrefix)) {
      ele.extension.splice(i, 1);
    }
  }
}


/**
 * Add the given inter-version extension to the given element.
 * @param ele the element to which the extension is to be added.
 * @param ive the inter-version extension to be added.
 */
function addExtension(ele, ive) {
  ele.extension = ele.extension || [];
  ele.extension.push(ive);
}
