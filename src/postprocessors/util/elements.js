/**
 * @fileoverview Generic, resource-agnostic helpers for FHIR element shapes.
 *
 * Two concerns live here, both independent of any resource type or version:
 *   - Primitive companion mechanics: a FHIR primitive keeps its id/extension in
 *     a sibling `_<name>` object, so relocating/removing a primitive must carry
 *     that companion too. copyPrimitive / renamePrimitive / deletePrimitive
 *     encapsulate that rule so callers never strand a `_`-companion.
 *   - Choice-type detection: findValueKey locates the single `value[x]` choice
 *     carried on an element object (the payload may be primitive or complex).
 *
 * These are pure mechanics with no diagnostics or business logic; callers decide
 * what any loss means and how to report it.
 *
 * @module postprocessors/util/elements
 */

/**
 * Copy a FHIR primitive value and its `_`-companion (id/extension) from a source
 * object onto a target object under a (possibly different) key.
 *
 * FHIR keeps a primitive's id/extension in a sibling `_<name>` object, so
 * copying a primitive (e.g. answerOption.valueString -> item.initialString) must
 * carry that companion too, or the id/extension is lost. The source is left
 * untouched. Either the value, the companion, or both may be present; a
 * companion-only (extension-only) primitive is copied faithfully. For a complex
 * type (no `_`-companion exists) this simply copies the value object, whose
 * id/extension already live inline.
 *
 * @param {Object} src Source object (read-only).
 * @param {string} fromKey Source key (e.g. "valueString").
 * @param {Object} dst Target object, mutated in place.
 * @param {string} toKey Target key (e.g. "initialString").
 */
export function copyPrimitive(src, fromKey, dst, toKey) {
  if (fromKey in src) dst[toKey] = src[fromKey];
  if (`_${fromKey}` in src) dst[`_${toKey}`] = src[`_${fromKey}`];
}

/**
 * Rename a FHIR primitive value and its `_`-companion within a single object.
 *
 * FHIR stores a primitive's id/extension in a sibling `_<name>` object, so
 * renaming a primitive must carry that companion too, or the metadata is
 * stranded on a field that no longer exists. Absent keys are ignored.
 *
 * @param {Object} obj Object to mutate in place.
 * @param {string} fromKey Current key.
 * @param {string} toKey New key.
 */
export function renamePrimitive(obj, fromKey, toKey) {
  if (fromKey in obj) {
    obj[toKey] = obj[fromKey];
    delete obj[fromKey];
  }
  if (`_${fromKey}` in obj) {
    obj[`_${toKey}`] = obj[`_${fromKey}`];
    delete obj[`_${fromKey}`];
  }
}

/**
 * Delete a FHIR primitive value and its `_`-companion (id/extension) from an
 * object, reporting what was actually removed so the caller can decide whether
 * the loss warrants a diagnostic.
 *
 * @param {Object} obj Object to mutate in place.
 * @param {string} key Key to remove.
 * @returns {{hadValue: boolean, hadCompanion: boolean}} Which parts existed and
 *   were removed (the bare value and/or its `_`-companion).
 */
export function deletePrimitive(obj, key) {
  const hadValue = key in obj;
  if (hadValue) delete obj[key];

  const meta = `_${key}`;
  const hadCompanion = meta in obj;
  if (hadCompanion) delete obj[meta];

  return { hadValue, hadCompanion };
}

/**
 * Find the value[x] choice carried on a FHIR element object.
 *
 * The object is expected to carry at most one value[x] choice (per the FHIR
 * single-choice rule); the first matching key wins and no violation check is
 * performed. Note the name says "Key" but with `suffixOnly` a suffix is
 * returned instead - the result is always a string or undefined.
 *
 * @param {Object} obj Element object (e.g. an answerOption, initial, or option
 *   entry) that may carry a single value[x] choice.
 * @param {Object} [options] Lookup options.
 * @param {boolean} [options.companionAware=false] Also detect an extension-only
 *   primitive (only `_valueX` present), resolving to the logical name "valueX"
 *   even though the bare value is absent.
 * @param {boolean} [options.suffixOnly=false] Return just the type suffix
 *   ("String") rather than the full key ("valueString").
 * @returns {string|undefined} The value[x] key, its suffix, or undefined if the
 *   object carries no value[x].
 */
export function findValueKey(obj, { companionAware = false, suffixOnly = false } = {}) {
  let key = Object.keys(obj).find(k => k.startsWith('value') && k.length > 'value'.length);

  if (!key && companionAware) {
    const meta = Object.keys(obj).find(k => k.startsWith('_value') && k.length > '_value'.length);
    if (meta) key = meta.slice(1); // "_valueString" -> "valueString"
  }

  if (!key) return undefined;
  return suffixOnly ? key.slice('value'.length) : key;
}
