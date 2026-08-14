/**
 * @fileoverview Detection rules used by tools/fhir-spec-parser.js.
 *
 * Extracted from the CLI script so the rules can be unit-tested in
 * isolation, away from zip-reading and file-writing side effects. Keep
 * this module pure: no I/O, no globals, no top-level work.
 *
 * @module tools/fhir-tables-lib
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
 *   - scalarType: the single FHIR type code for a non-polymorphic element
 *     (e.g. "code", "Identifier", "canonical"). Null when the element is
 *     polymorphic, has no type[] array, or its single type entry lacks a
 *     usable code. Consumers use this to know when source and target
 *     element types differ across versions, so an FML <<types>>
 *     conversion group can be auto-invoked.
 *   - missingTypeCodes: counts el.type entries that lack a usable `code`
 *     string (older spec versions sometimes encode the type via an
 *     extension instead of a code).
 *
 * @param {Object} el  A StructureDefinition.snapshot.element (or
 *                     .differential.element) entry.
 * @returns {{
 *   pathKey:    (string|null),
 *   array:      boolean,
 *   poly:       ({types: string[]}|null),
 *   scalarType: (string|null),
 *   missingTypeCodes: number
 * }}
 */
export function classifyElement(el) {
  const result = { pathKey: null, array: false, poly: null, scalarType: null, missingTypeCodes: 0 };
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
    } else {
      // Single concrete type on a non-polymorphic element.
      const t = el.type[0];
      if (t && typeof t.code === 'string' && t.code.length > 0) {
        result.scalarType = t.code;
      } else {
        result.missingTypeCodes++;
      }
    }
  }

  return result;
}

/**
 * Accumulate poly-paths, array-paths, and element-types info across one
 * element list. Mutates `polyMap`, `arraySet`, and `elementTypesMap` in
 * place; this matches the way the CLI script aggregates across many
 * StructureDefinitions.
 *
 * Conflict resolution for `elementTypesMap`: when a key is seen more than
 * once with different scalar types (rare; typically only happens when
 * snapshot and differential entries disagree, or when a constrained
 * profile re-declares an element), the first value wins. This keeps the
 * base-resource type when extensions or profiles add narrower variants.
 *
 * @param {Array}  elements         snapshot.element or differential.element entries.
 * @param {Map<string, Set<string>>} polyMap          path -> Set<typeCode>; mutated.
 * @param {Set<string>}              arraySet         path; mutated.
 * @param {Map<string, string>|null} [elementTypesMap]  path -> typeCode; mutated
 *                                                      when provided. May be
 *                                                      null for callers that
 *                                                      don't need this table.
 * @param {Function} [onMissingTypeCode]  Optional callback `(path, sdId)`
 *                                        fired once per missing type.code.
 * @param {string}   [sdId]               StructureDefinition id; passed
 *                                        through to the callback.
 * @returns {number}  Number of elements scanned.
 */
export function processElements(elements, polyMap, arraySet, elementTypesMap, onMissingTypeCode, sdId) {
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

    if (c.scalarType && elementTypesMap && !elementTypesMap.has(c.pathKey)) {
      elementTypesMap.set(c.pathKey, c.scalarType);
    }

    for (let i = 0; i < c.missingTypeCodes; i++) {
      onMissingTypeCode?.(el.path, sdId);
    }
  }
  return count;
}
