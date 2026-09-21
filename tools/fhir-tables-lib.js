/**
 * @fileoverview Detection rules used by tools/fhir-spec-parser.js.
 *
 * Kept separate from ZIP parsing so the rules can be unit-tested in
 * isolation. Keep this module pure: no I/O, no globals, no top-level work.
 *
 * @module tools/fhir-tables-lib
 */

/** Dotted FHIR element path with no `[x]` suffix and no leading marker. */
const ELEMENT_PATH_RE = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/;

/** Local (same-StructureDefinition) content reference, e.g. `#Questionnaire.item`. */
const LOCAL_CONTENT_REFERENCE_RE = /^#[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/;

/**
 * Strip a trailing `[x]` so a path can be used as a table key.
 *
 * @param {*} path Candidate element path.
 * @returns {string|null} Normalized key, or null when `path` is not a
 *   non-empty string.
 */
function normalizePathKey(path) {
  if (typeof path !== 'string' || path.length === 0) return null;

  return path.endsWith('[x]') ? path.slice(0, -3) : path;
}

/**
 * Index `element.name` -> `element.path` for one StructureDefinition.
 *
 * DSTU2 resolves `nameReference` against these names. Names are unique within
 * a StructureDefinition in the bundled DSTU2 specification, but first-wins is
 * applied anyway so the result never depends on iteration order.
 *
 * @param {Array} elements snapshot.element or differential.element entries.
 * @returns {Map<string, string>} Name index (empty for specs without names).
 */
function indexElementNames(elements) {
  const nameToPath = new Map();
  for (const el of elements) {
    if (!el || typeof el.name !== 'string' || el.name.length === 0) continue;
    if (typeof el.path !== 'string' || el.path.length === 0) continue;
    if (!nameToPath.has(el.name)) nameToPath.set(el.name, el.path);
  }

  return nameToPath;
}

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
 *   - contentReference: normalized local element path referenced by the
 *     element, with the leading "#" removed. Null when absent or invalid.
 *     DSTU2 predates `contentReference` and instead points at another
 *     element's `name` via `nameReference`; when `nameToPath` resolves that
 *     name, the resulting path populates this same field so every consumer
 *     sees one normalized representation regardless of spec version.
 *
 * @param {Object} el  A StructureDefinition.snapshot.element (or
 *                     .differential.element) entry.
 * @param {Map<string, string>|null} [nameToPath]  DSTU2 `element.name` ->
 *                     `element.path` index for the SAME StructureDefinition.
 *                     Required to resolve `nameReference`; ignored for specs
 *                     that use `contentReference`.
 * @returns {{
 *   pathKey:    (string|null),
 *   array:      boolean,
 *   poly:       ({types: string[]}|null),
 *   scalarType: (string|null),
 *   missingTypeCodes: number,
 *   contentReference: (string|null)
 * }}
 */
export function classifyElement(el, nameToPath = null) {
  const result = {
    pathKey: null,
    array: false,
    poly: null,
    scalarType: null,
    missingTypeCodes: 0,
    contentReference: null,
  };
  if (!el || typeof el.path !== 'string' || el.path.length === 0) return result;

  result.pathKey = normalizePathKey(el.path);
  if (typeof el.contentReference === 'string'
      && LOCAL_CONTENT_REFERENCE_RE.test(el.contentReference)) {
    result.contentReference = el.contentReference.slice(1);
  } else if (typeof el.nameReference === 'string' && nameToPath) {
    // DSTU2 spelling. The referenced element is named, not pathed, so the
    // caller's per-StructureDefinition name index does the resolution.
    const referenced = normalizePathKey(nameToPath.get(el.nameReference));
    if (referenced && ELEMENT_PATH_RE.test(referenced)) {
      result.contentReference = referenced;
    }
  }

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
 * Accumulate poly-paths, array-paths, element-types, and content-reference
 * info across one element list. Mutates the supplied collections in place;
 * this matches the way the CLI script aggregates across many
 * StructureDefinitions.
 *
 * Conflict resolution for `elementTypesMap`: when a key is seen more than
 * once with different scalar types (rare; typically only happens when
 * snapshot and differential entries disagree, or when a constrained
 * profile re-declares an element), the first value wins. This keeps the
 * base-resource type when extensions or profiles add narrower variants.
 *
 * `elements` must be the element list of a SINGLE StructureDefinition: DSTU2
 * `nameReference` values are resolved against the names declared alongside
 * them, and pooling several definitions would let one definition's names
 * capture another's references.
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
 * @param {Map<string, string>|null} [contentReferencesMap] Referencing path
 *                                        -> referenced path; mutated when
 *                                        provided.
 * @param {Function} [onContentReferenceIssue] Optional callback receiving
 *                                        `(path, reference, existing, sdId)`
 *                                        for invalid references or conflicts.
 *                                        `reference` is the raw
 *                                        `contentReference`/`nameReference`
 *                                        value when it could not be resolved.
 * @returns {number}  Number of elements scanned.
 */
export function processElements(
  elements,
  polyMap,
  arraySet,
  elementTypesMap,
  onMissingTypeCode,
  sdId,
  contentReferencesMap,
  onContentReferenceIssue,
) {
  // Built once per call because DSTU2 `nameReference` is resolved against the
  // names declared by the SAME StructureDefinition. Callers pass one
  // definition's elements at a time, so this scope is exactly right.
  const nameToPath = indexElementNames(elements);
  let count = 0;
  for (const el of elements) {
    count++;
    const c = classifyElement(el, nameToPath);
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

    const rawReference = el.contentReference ?? el.nameReference;
    if (rawReference != null && !c.contentReference) {
      onContentReferenceIssue?.(el.path, rawReference, null, sdId);
    } else if (c.contentReference && contentReferencesMap) {
      const existing = contentReferencesMap.get(c.pathKey);
      if (existing == null) {
        contentReferencesMap.set(c.pathKey, c.contentReference);
      } else if (existing !== c.contentReference) {
        onContentReferenceIssue?.(el.path, c.contentReference, existing, sdId);
      }
    }

    for (let i = 0; i < c.missingTypeCodes; i++) {
      onMissingTypeCode?.(el.path, sdId);
    }
  }
  return count;
}
