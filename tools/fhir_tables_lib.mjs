/**
 * @fileoverview Detection rules used by tools/build_fhir_tables.mjs.
 *
 * Extracted from the CLI script so the rules can be unit-tested in
 * isolation, away from zip-reading and file-writing side effects. Keep
 * this module pure: no I/O, no globals, no top-level work.
 *
 * @module tools/fhir_tables_lib
 */

/** Matches "profiles-resources.json" or "profiles-types.json" anywhere in a zip entry name. */
export const BUNDLE_ENTRY_RE = /(^|[\\/])profiles-(resources|types)\.json$/i;

/**
 * Inspect one StructureDefinition element and report what derived-data
 * tables it should contribute to.
 *
 * Detection rules:
 *   - pathKey: el.path with any trailing "[x]" stripped. Null when the
 *     element has no path (skipped element).
 *   - array:   el.max is present and is neither "0" nor "1". FHIR also
 *     allows numeric upper bounds like "2", all of which mean "array".
 *   - poly:    set when el.path ends in "[x]" OR el.type has more than
 *     one entry; carries the de-duplicated FHIR type codes.
 *   - missingTypeCodes: counts el.type entries that lack a usable `code`
 *     string (older spec versions sometimes encode the type via an
 *     extension instead of a code).
 *
 * @param {Object} el  A StructureDefinition.snapshot.element (or
 *                     .differential.element) entry.
 * @returns {{
 *   pathKey: (string|null),
 *   array:   boolean,
 *   poly:    ({types: string[]}|null),
 *   missingTypeCodes: number
 * }}
 */
export function classifyElement(el) {
  const result = { pathKey: null, array: false, poly: null, missingTypeCodes: 0 };
  if (!el || typeof el.path !== 'string' || el.path.length === 0) return result;

  result.pathKey = el.path.endsWith('[x]') ? el.path.slice(0, -3) : el.path;

  if (el.max && el.max !== '0' && el.max !== '1') {
    result.array = true;
  }

  if (Array.isArray(el.type) && el.type.length > 0) {
    const endsWithX = el.path.endsWith('[x]');
    const multiType = el.type.length > 1;
    if (endsWithX || multiType) {
      const types = [];
      for (const t of el.type) {
        if (t && typeof t.code === 'string' && t.code.length > 0) {
          types.push(t.code);
        } else {
          result.missingTypeCodes++;
        }
      }
      if (types.length > 0) result.poly = { types };
    }
  }

  return result;
}

/**
 * Accumulate poly-paths and array-paths info across one element list.
 * Mutates `polyMap` and `arraySet` in place; this matches the way the
 * CLI script aggregates across many StructureDefinitions.
 *
 * @param {Array}  elements  snapshot.element or differential.element entries.
 * @param {Map<string, Set<string>>} polyMap   path -> Set<typeCode>; mutated.
 * @param {Set<string>}              arraySet  path; mutated.
 * @param {Function} [onMissingTypeCode]  Optional callback `(path, sdId)`
 *                                        fired once per missing type.code.
 * @param {string}   [sdId]               StructureDefinition id; passed
 *                                        through to the callback.
 * @returns {number}  Number of elements scanned.
 */
export function processElements(elements, polyMap, arraySet, onMissingTypeCode, sdId) {
  let count = 0;
  for (const el of elements) {
    count++;
    const c = classifyElement(el);
    if (!c.pathKey) continue;

    if (c.array) arraySet.add(c.pathKey);

    if (c.poly) {
      let set = polyMap.get(c.pathKey);
      if (!set) {
        set = new Set();
        polyMap.set(c.pathKey, set);
      }
      for (const t of c.poly.types) set.add(t);
    }

    for (let i = 0; i < c.missingTypeCodes; i++) {
      onMissingTypeCode?.(el.path, sdId);
    }
  }
  return count;
}

