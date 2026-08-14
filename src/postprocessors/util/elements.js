/**
 * @fileoverview Generic, resource-agnostic helpers for FHIR element shapes.
 *
 * Four concerns live here, all independent of any resource type or version:
 *   - Primitive companion mechanics: a FHIR primitive keeps its id/extension in
 *     a sibling `_<name>` object, so relocating/removing a primitive must carry
 *     that companion too. copyPrimitive / renamePrimitive / deletePrimitive
 *     encapsulate that rule so callers never strand a `_`-companion.
 *     removePrimitiveArrayEntries applies the same rule to a repeating
 *     primitive, where the companion is a position-aligned array.
 *     hasPrimitiveValueOrExtension distinguishes a valid extension-only
 *     primitive from invalid id-only metadata, and addDataAbsentReasonExtension
 *     uses the companion to mark a primitive as present-but-valueless.
 *   - Choice-type detection: findValueKey locates the single `value[x]` choice
 *     carried on an element object (the payload may be primitive or complex).
 *   - Content probing: hasAnyContent reports whether an element carries
 *     meaningful content under any of a set of candidate property names, so a
 *     caller can decide whether unrepresentable source content was present.
 *   - Canonical normalization: stripCanonicalVersion removes a canonical's
 *     version pin while retaining any fragment identifier.
 *
 * These are pure mechanics with no diagnostics or business logic; callers decide
 * what any loss means and how to report it.
 *
 * @module postprocessors/util/elements
 */

/**
 * Return whether an object has meaningful content in any named property.
 *
 * "Meaningful" means present and non-null, and - for the container types - not
 * empty: an empty array or an object with no keys carries nothing worth
 * reporting. Listing a primitive together with its `_`-companion (for example
 * `['status', '_status']`) detects an extension-only primitive as content.
 *
 * @param {Object|undefined} object Object to inspect.
 * @param {string[]} names Property names.
 * @returns {boolean} True when a named property has content.
 */
export function hasAnyContent(object, names) {
  if (!object || typeof object !== 'object') return false;

  return names.some(name => {
    if (!Object.hasOwn(object, name)) return false;
    const value = object[name];
    if (value == null) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
  });
}

/**
 * Return whether a primitive has a value or extension content that represents
 * a valid value-less occurrence in FHIR JSON.
 *
 * An element id alone does not satisfy Element invariant ele-1. Any extension
 * does satisfy ele-1 and can represent the primitive without a bare value.
 *
 * @param {Object|undefined} object Object holding the primitive.
 * @param {string} key Primitive property name.
 * @returns {boolean} True when the primitive is represented validly.
 */
export function hasPrimitiveValueOrExtension(object, key) {
  if (!object || typeof object !== 'object') return false;
  if (Object.hasOwn(object, key) && object[key] != null) return true;

  const extensions = object[`_${key}`]?.extension;
  return Array.isArray(extensions) && extensions.length > 0;
}

/**
 * Remove a canonical `|version` suffix while preserving any `#fragment`.
 *
 * Canonical syntax orders the parts as `url|version#fragment`, so the fragment
 * must be carried across when the version is dropped.
 *
 * @param {string} reference Canonical reference.
 * @returns {string} The reference without its version suffix.
 */
export function stripCanonicalVersion(reference) {
  const bar = reference.indexOf('|');
  if (bar === -1) return reference;

  const hash = reference.indexOf('#', bar);
  return hash === -1
    ? reference.slice(0, bar)
    : reference.slice(0, bar) + reference.slice(hash);
}

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
 * Remove entries from a repeating FHIR primitive, keeping its `_`-companion
 * array aligned.
 *
 * A repeating primitive stores id/extension in a parallel `_<name>` array, where
 * position matters and absent metadata is `null`. Splicing the value array alone
 * would silently re-associate every companion after the removal point, so both
 * arrays are rebuilt together. When every entry is removed, or when no companion
 * entry carries content any more, the affected key is deleted rather than left
 * as an empty array.
 *
 * @param {Object} obj Object holding the repeating primitive, mutated in place.
 * @param {string} key Primitive array key (e.g. "operator").
 * @param {function(*, number): boolean} shouldRemove Predicate receiving the
 *   value and its index; return true to drop that entry.
 * @returns {{removed: Array<{index: number, value: *}>, remaining: number}}
 *   Entries removed (in original order, with their original indexes) and the
 *   number of entries left.
 */
export function removePrimitiveArrayEntries(obj, key, shouldRemove) {
  const values = obj?.[key];
  if (!Array.isArray(values)) return { removed: [], remaining: 0 };

  const companionKey = `_${key}`;
  const companion = Array.isArray(obj[companionKey]) ? obj[companionKey] : null;
  const removed = [];
  const keptValues = [];
  const keptCompanion = [];

  values.forEach((value, index) => {
    if (shouldRemove(value, index)) {
      removed.push({ index, value });
      return;
    }
    keptValues.push(value);
    if (companion) keptCompanion.push(companion[index] ?? null);
  });

  if (removed.length === 0) return { removed, remaining: values.length };

  if (keptValues.length === 0) {
    delete obj[key];
    delete obj[companionKey];
    return { removed, remaining: 0 };
  }

  obj[key] = keptValues;
  if (companion) {
    if (keptCompanion.some(entry => entry != null)) obj[companionKey] = keptCompanion;
    else delete obj[companionKey];
  }

  return { removed, remaining: keptValues.length };
}

/**
 * Canonical URL of the standard FHIR data-absent-reason extension.
 *
 * @type {string}
 */
export const DATA_ABSENT_REASON_URL = 'http://hl7.org/fhir/StructureDefinition/data-absent-reason';

/**
 * Mark a FHIR primitive as present-but-valueless by attaching the standard
 * data-absent-reason extension to its `_`-companion.
 *
 * FHIR allows an extension to stand in place of a primitive's value; R5 added
 * `ElementDefinition.mustHaveValue` precisely so a profile can forbid that,
 * and its own documentation names data-absent-reason as the typical extension
 * used this way. The element then exists for invariant purposes while
 * asserting nothing about the value it does not have.
 *
 * The caller is responsible for only applying this where the value really is
 * absent; this function is pure mechanics and does not inspect `obj[key]`.
 * It is idempotent: a companion that already carries a data-absent-reason
 * extension is left untouched, and any unrelated extensions are preserved.
 *
 * @param {Object} obj Object holding the primitive, mutated in place.
 * @param {string} key Primitive key (e.g. "supplements").
 * @param {string} [reason='unknown'] Code from the data-absent-reason value set.
 * @returns {boolean} True when the extension was added, false when one was
 *   already present or the target was not an object.
 */
export function addDataAbsentReasonExtension(obj, key, reason = 'unknown') {
  if (!obj || typeof obj !== 'object') return false;

  const companionKey = `_${key}`;
  if (obj[companionKey] == null || typeof obj[companionKey] !== 'object') {
    obj[companionKey] = {};
  }
  const companion = obj[companionKey];

  if (!Array.isArray(companion.extension)) companion.extension = [];
  if (companion.extension.some(entry => entry?.url === DATA_ABSENT_REASON_URL)) return false;

  companion.extension.push({ url: DATA_ABSENT_REASON_URL, valueCode: reason });
  return true;
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
