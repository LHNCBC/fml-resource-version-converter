/**
 * @fileoverview FHIR Mapping Language (FML) cross-version conversion engine.
 *
 * Compiles FML source text + optional ConceptMap resources into an executable
 * converter for FHIR JSON resources. Targets the subset of FML used by the
 * official HL7 cross-version mappings at https://hl7.org/fhir/uv/xver/.
 *
 *   +------------------------------------------------------------------+
 *   |  Pipeline:                                                       |
 *   |    parseFml(text)  -> AST { metadata, uses, groups }             |
 *   |                       (defined in ./fml_parser.js)               |
 *   |    compile(ast)    -> engine bound to translator + diagnostics   |
 *   |    engine.convert({ input }) -> conversion result               |
 *   +------------------------------------------------------------------+
 *
 * Public API:
 *   compileFmlXver({ fmlText, conceptMaps, ...opts }) -> engine
 *   engine.convert({ input, entryGroup? })
 *     -> { resource: output JSON resource, spinOffResources? }
 *
 * Design tenets:
 *   - Tight: every operation that could produce an incorrect output emits
 *     a warning via `onWarning`. Information-level surprises (correct but
 *     possibly unexpected) go through `onInfo`.
 *   - One execution path: `execRule` dispatches to `execScalarRule` or
 *     `execArrayRule`; both share `applyTarget` / `computeTargetValue` /
 *     `writeTarget`. No quick-path duplication.
 *   - Polymorphic fields (value[x]) honor an explicit trailing-string
 *     poly name when present, falling back to `root + Cap(typeHint)`.
 *   - Group invocations resolve their arguments by name from the calling
 *     scope and bind them positionally to the group's declared parameters.
 *
 * The AST shape consumed by this module is defined in ./fml_parser.js
 * (see its @fileoverview for the full typedef block).
 *
 * ----- Transform reference ------------------------------------------------
 *
 * The transform language is a subset of FML. Each transform is called as
 * `fn(arg1, arg2, ...)` on the RHS of a target assignment.
 *
 *   literal(s)                  // 'foo' string literal as-is
 *   varRef(name)                // bare identifier, read from scope
 *   copy(v)                     // deep-clone v
 *   translate(code, mapUrl)     // ConceptMap lookup
 *   create(typeName)            // { resourceType: typeName }
 *   truncate(v, n)              // v.substring(0, n) (strings only)
 *   cast(v, type)               // type in {string|boolean|integer|decimal}
 *   append(a, b, c, ...)        // string concatenation
 *   reference(v)                // wrap as { reference: v }
 *   c(system, code, display?)   // Coding literal
 *   cc(system, code, display?)  // CodeableConcept literal
 *   id(system, value)           // Identifier literal
 *   qty(value, unit?, sys?, c?) // Quantity literal
 *
 *   uuid, dateOp, evaluate, pointer, escape: recognised but not implemented;
 *   emit a warning and return undefined.
 *
 * @module fml_base_conv/fml_xver_engine
 */

import fhirpathLib from 'fhirpath';
import dstu2Model from 'fhirpath/fhir-context/dstu2/index.js';
import stu3Model  from 'fhirpath/fhir-context/stu3/index.js';
import r4Model    from 'fhirpath/fhir-context/r4/index.js';
import r5Model    from 'fhirpath/fhir-context/r5/index.js';
import { parseFml } from './fml_parser.js';

/**
 * FHIRPath model objects per FHIR version label. A model gives the
 * fhirpath.js evaluator FHIR-schema awareness (polymorphic JSON field
 * collapsing, `ofType(T)` / `is T` / `as T`, type-inheritance checks).
 * Without it, only plain field navigation and generic FHIRPath functions
 * work. R4B has no dedicated bundled model; we reuse R4 (the two are
 * structurally compatible for FHIRPath purposes).
 */
const FHIRPATH_MODEL = {
  R2:  dstu2Model,
  R3:  stu3Model,
  R4:  r4Model,
  R4B: r4Model,
  R5:  r5Model,
};

/**
 * Match a leading bare identifier in a FHIRPath expression. The FML
 * parser emits expressions whose first token is either a scope-bound
 * alias (e.g. `v.substring(...)`) or a field of the iteration context
 * (e.g. `coding.exists(...)`). Splitting on this lets the engine pick
 * the right FHIRPath context.
 */
const FHIRPATH_HEAD_RE = /^([a-zA-Z_$][a-zA-Z0-9_$]*)/;

// ----- Helpers ------------------------------------------------------------

/**
 * Type-guard for plain JSON objects (excludes arrays and null).
 * Used wherever we need to distinguish "real object" from primitives or
 * arrays before destructuring, merging, or recursing into structure.
 * @param {*} x
 * @returns {boolean}
 */
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/**
 * FHIR primitive type codes. In JSON, these types split their bare value and
 * Element metadata across `field` and `_field`.
 *
 * @type {Set<string>}
 */
const FHIR_PRIMITIVES = new Set([
  'boolean', 'integer', 'decimal', 'string', 'uri', 'url', 'canonical',
  'base64Binary', 'instant', 'date', 'dateTime', 'time', 'code', 'oid',
  'id', 'markdown', 'unsignedInt', 'positiveInt', 'uuid', 'xhtml',
  'integer64',
]);

/**
 * Capitalise the first letter of a string. Used to construct polymorphic
 * FHIR field names: `cap('boolean')` -> `'Boolean'`, so a source declared
 * as `value : boolean` reads from the field `valueBoolean`.
 * @param {string} s
 * @returns {string}
 */
const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;

/**
 * Deep-clone any JSON-safe value (primitives, arrays, plain objects).
 * We use this instead of `structuredClone` because our inputs are always
 * JSON-shaped (no Dates, Maps, or Sets), and a focused implementation
 * is both faster and self-documenting.
 * @param {*} x
 * @returns {*}  A deep copy with no shared references.
 */
function deepClone(x) {
  if (x === null || typeof x !== 'object') return x;
  if (Array.isArray(x)) return x.map(deepClone);
  const o = {};
  for (const k of Object.keys(x)) o[k] = deepClone(x[k]);
  return o;
}

/**
 * Copy a JSON FHIR primitive property and its optional `_field` companion.
 *
 * Handles ordinary and companion-only primitives without introducing absent
 * properties. Used by structural base copiers, whose fields bypass FML rule
 * source bindings and target writes.
 *
 * @param {Object} src Source object.
 * @param {Object} tgt Target object.
 * @param {string} key Primitive property name.
 * @returns {void}
 */
function copyPrimitiveProperty(src, tgt, key) {
  if (src[key] !== undefined) tgt[key] = deepClone(src[key]);
  const companionKey = `_${key}`;
  if (src[companionKey] !== undefined) {
    tgt[companionKey] = deepClone(src[companionKey]);
  }
}

/**
 * Walk a dot-separated path on `obj`, returning `undefined` if any
 * intermediate segment is missing. Safe to call on optional FHIR
 * sub-structures.
 *
 * @example
 *   getPath({ item: { linkId: 'q1' } }, 'item.linkId')  // -> 'q1'
 *   getPath({ item: {} },               'item.linkId')  // -> undefined
 *
 * @param {Object|null|undefined} obj
 * @param {string} path
 * @returns {*}
 */
function getPath(obj, path) {
  if (!path) return obj;
  let cur = obj;
  for (const seg of path.split('.')) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/**
 * Walk a dot-path on `obj`, creating intermediate objects as needed, and
 * return the parent of the last segment plus that segment's name. The
 * caller assigns via `parent[key] = value`; this two-step form lets the
 * caller decide whether to overwrite, append, or merge.
 *
 * @example
 *   const o = {};
 *   const { parent, key } = ensurePath(o, 'a.b.c');
 *   parent[key] = 1;
 *   // o is now { a: { b: { c: 1 } } }
 *
 * @param {Object} obj
 * @param {string} path
 * @returns {{parent: Object, key: string}}
 */
function ensurePath(obj, path) {
  const segs = path.split('.');
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    if (!isObject(cur[segs[i]])) cur[segs[i]] = {};
    cur = cur[segs[i]];
  }
  return { parent: cur, key: segs[segs.length - 1] };
}

// ----- Built-in FHIR base-type copiers ------------------------------------

/**
 * Copiers for FHIR's abstract base types. When a group is declared as
 * `group X(...) extends Y { ... }`, the engine first applies the matching
 * base copier to the source/target pair before running X's own rules.
 * This handles the boilerplate inheritance fields (id, meta, extension, ...)
 * that every resource carries.
 *
 * FHIR inheritance hierarchy:
 *
 *   Element            (id, extension)
 *     +- DataType        (same shape as Element in JSON)
 *     +- BackboneElement (Element + modifierExtension)
 *   Resource           (id, meta, implicitRules, language)
 *     +- DomainResource (Resource + text, contained, extension, modifierExtension)
 *         +- CanonicalResource, MetadataResource (same shape as DomainResource in JSON)
 *
 * Each copier mutates `tgt` in place; only defined fields are copied so we
 * never introduce `null` keys that weren't in the source.
 */
const BASE_COPIERS = {
  Element(src, tgt) {
    if (src.id !== undefined)        tgt.id        = src.id;
    if (src.extension !== undefined) tgt.extension = deepClone(src.extension);
  },
  BackboneElement(src, tgt) {
    BASE_COPIERS.Element(src, tgt);
    if (src.modifierExtension !== undefined) tgt.modifierExtension = deepClone(src.modifierExtension);
  },
  DataType(src, tgt) {
    BASE_COPIERS.Element(src, tgt);
  },
  Resource(src, tgt) {
    if (src.id !== undefined)            tgt.id            = src.id;
    // Resource.id has no `_id` companion field
    if (src.meta !== undefined)          tgt.meta          = deepClone(src.meta);
    copyPrimitiveProperty(src, tgt, 'implicitRules');
    copyPrimitiveProperty(src, tgt, 'language');
  },
  DomainResource(src, tgt) {
    BASE_COPIERS.Resource(src, tgt);
    if (src.text !== undefined)              tgt.text              = deepClone(src.text);
    if (src.contained !== undefined)         tgt.contained         = deepClone(src.contained);
    if (src.extension !== undefined)         tgt.extension         = deepClone(src.extension);
    if (src.modifierExtension !== undefined) tgt.modifierExtension = deepClone(src.modifierExtension);
  },
  CanonicalResource(src, tgt) { BASE_COPIERS.DomainResource(src, tgt); },
  MetadataResource(src, tgt)  { BASE_COPIERS.DomainResource(src, tgt); },
};

// ----- ConceptMap translator ----------------------------------------------

/**
 * Build a fast lookup index for one ConceptMap resource.
 *
 * A FHIR ConceptMap is organised as: ConceptMap -> groups -> elements
 * (source codes) -> targets (mapped codes with a relationship). This
 * function flattens that into a Map keyed by `${groupIdx}::${sourceCode}`
 * for O(1) lookup. Group metadata and ordering are preserved so coded inputs
 * can select the matching source system and construct a target Coding.
 *
 * Supports both R4 (`equivalence`) and R5 (`relationship`) target fields;
 * either is normalised to lowercase under the `rel` key.
 *
 * @param {Object} cm  A FHIR ConceptMap resource (R4 or R5 shape).
 * @returns {{url: string, groups: Object[], lookup: Map<string, Object>, unmapped: Map<number, Object>}}
 * @throws {Error} If the ConceptMap has neither `url` nor `id`.
 */
function indexConceptMap(cm) {
  const url = cm.url || cm.id;
  if (!url) throw new Error('ConceptMap is missing url/id');

  const groups = Array.isArray(cm.group) ? cm.group : [];
  const lookup = new Map();
  const unmapped = new Map();

  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    if (g.unmapped) unmapped.set(gi, g.unmapped);
    for (const el of g.element || []) {
      if (!el?.code) continue;
      const targets = (el.target || [])
        .map(t => ({
          code:    t.code,
          display: t.display,
          rel:     String(t.relationship || t.equivalence || '').toLowerCase(),
        }))
        .filter(t => t.code);
      const key = `${gi}::${el.code}`;
      const entry = lookup.get(key) || { targets: [], noMap: false };
      entry.targets.push(...targets);
      entry.noMap ||= el.noMap === true;
      lookup.set(key, entry);
    }
  }
  return {
    url,
    groups: groups.map(group => ({
      sourceSystem: group.source || group.sourceUri,
      targetSystem: group.target || group.targetUri,
    })),
    lookup,
    unmapped,
  };
}

/**
 * Normalize a FHIR code, Coding, or CodeableConcept into candidate Codings.
 * Coding order is retained so a CodeableConcept is tried deterministically.
 *
 * @param {*} source A code primitive or coded datatype.
 * @returns {Object[]} Candidate Coding-shaped objects.
 */
function sourceCodings(source) {
  if (typeof source === 'string') return [{ code: source }];
  if (!isObject(source)) return [];

  if (Array.isArray(source.coding)) {
    return source.coding.filter(coding => isObject(coding) && coding.code != null);
  }

  return source.code != null ? [source] : [];
}

/**
 * Shape one translated Coding according to the FML translate output selector.
 *
 * @param {Object} coding Translated Coding-shaped value.
 * @param {string} output One of code, system, display, Coding, CodeableConcept.
 * @returns {*}
 */
function selectTranslationOutput(coding, output) {
  if (output === 'code') return coding.code;
  if (output === 'system') return coding.system;
  if (output === 'display') return coding.display;

  const result = {};
  if (coding.system !== undefined) result.system = coding.system;
  if (coding.code !== undefined) result.code = coding.code;
  if (coding.display !== undefined) result.display = coding.display;

  if (output === 'Coding') return result;
  if (output === 'CodeableConcept') return { coding: [result] };
  return undefined;
}

/**
 * Apply an output selector when translation falls back to the source value.
 * Complex coded inputs are preserved whole when the requested output type
 * matches, avoiding loss of text, alternative codings, or Element metadata.
 *
 * @param {*} source Original code, Coding, or CodeableConcept.
 * @param {Object} firstCoding First usable Coding normalized from the source.
 * @param {string} output Requested translation output selector.
 * @returns {*}
 */
function selectUnchangedTranslationOutput(source, firstCoding, output) {
  if (output === 'CodeableConcept') {
    if (isObject(source) && Array.isArray(source.coding)) return deepClone(source);
    return { coding: [deepClone(firstCoding)] };
  }

  if (output === 'Coding') return deepClone(firstCoding);
  return selectTranslationOutput(firstCoding, output);
}

/**
 * Create a code translator backed by a set of ConceptMaps.
 *
 * The returned `translate(source, mapUrl, output)` function accepts a code,
 * Coding, or CodeableConcept, looks it up in the named ConceptMap, and shapes
 * the selected target according to the requested output. Available targets
 * are chosen in this priority order:
 *
 *   1. `equivalent` / `equal`         - exact semantic match (silent)
 *   2. `source-is-narrower-than-target` / `wider` - safe widening (INFO)
 *   3. `source-is-broader-than-target` / `narrower` /
 *      `related-to`                    - lossy match (WARNS)
 *   4. First listed target             - unrecognized relationship (WARNS)
 *   5. `unmapped.mode = fixed`         - group-level fallback code (INFO)
 *   6. `unmapped.mode = use-source-code` / `provided` - use the source code
 *                                                       in the target system
 *   7. Otherwise: return source code unchanged (WARNS), or throw if strict.
 *
 * @param {Object[]} conceptMaps                Indexed at construction time.
 * @param {Object}   opts
 * @param {boolean}  [opts.strict=false]        Throw on missing map / unmappable.
 * @param {Function} [opts.onWarning]
 * @param {Function} [opts.onInfo]
 * @returns {{translate: (source: *, mapUrl: string, output: string) => *}}
 */
function makeTranslator(conceptMaps, { strict = false, onWarning, onInfo } = {}) {
  const byUrl = new Map();
  for (const cm of conceptMaps) {
    const idx = indexConceptMap(cm);
    byUrl.set(idx.url, idx);
  }

  // Exact or safe (widening) -- no information lost in forward direction.
  const EXACT = new Set(['equivalent', 'equal']);
  const SAFE  = new Set(['source-is-narrower-than-target', 'wider']);
  // Potentially lossy -- target is narrower or relationship is vague.
  const LOSSY = new Set([
    'source-is-broader-than-target', 'narrower',
    'related-to',
  ]);

  /**
   * Choose the best target from a list of candidate mappings for one source
   * code. Emits diagnostics whenever the choice is not provably correct.
   */
  function pickTarget(targets, code, mapUrl) {
    if (!targets?.length) return undefined;

    const exact = targets.find(t => EXACT.has(t.rel));
    if (exact) return exact;

    // Widening (source narrower than target) is safe -- emit info, not warning.
    const safe = targets.find(t => SAFE.has(t.rel));
    if (safe) {
      onInfo?.(`translate("${code}", ${mapUrl}): widening "${safe.rel}" -> "${safe.code}"`);
      return safe;
    }

    const lossy = targets.find(t => LOSSY.has(t.rel));
    if (lossy) {
      onWarning?.(`translate("${code}", ${mapUrl}): using lossy relationship "${lossy.rel}" -> "${lossy.code}"`);
      return lossy;
    }

    const usableTargets = targets.filter(target => ![
      'not-related-to',
      'unmatched',
      'disjoint',
    ].includes(target.rel));
    if (usableTargets.length === 0) return undefined;

    onWarning?.(`translate("${code}", ${mapUrl}): unrecognised relationship "${usableTargets[0].rel}", falling back to first target "${usableTargets[0].code}"`);
    return usableTargets[0];
  }

  /**
   * Return group indexes applicable to a source Coding. An explicit source
   * system must match the ConceptMap group; an absent system may use any group.
   *
   * @param {Object} idx Indexed ConceptMap.
   * @param {Object} coding Source Coding-shaped value.
   * @returns {number[]} Applicable group indexes in declaration order.
   */
  function matchingGroupIndexes(idx, coding) {
    const indexes = [];
    for (let gi = 0; gi < idx.groups.length; gi++) {
      const sourceSystem = idx.groups[gi].sourceSystem;
      if (!coding.system || !sourceSystem || coding.system === sourceSystem) {
        indexes.push(gi);
      }
    }
    return indexes;
  }

  /**
   * Add the target system from a ConceptMap group to a selected target.
   *
   * @param {Object} target Selected target element or fallback coding.
   * @param {Object} group Indexed ConceptMap group metadata.
   * @returns {Object} Coding-shaped translation result.
   */
  function translatedCoding(target, group) {
    return {
      ...(group.targetSystem !== undefined ? { system: group.targetSystem } : {}),
      code: target.code,
      ...(target.display !== undefined ? { display: target.display } : {}),
    };
  }

  /**
   * Translate a FHIR code or coded datatype and select the requested output.
   *
   * @param {*} source A code primitive, Coding, or CodeableConcept.
   * @param {string} mapUrl ConceptMap canonical URL.
   * @param {string} output Requested result: code, system, display, Coding, or CodeableConcept.
   * @returns {*} Selected translation value.
   */
  function translate(source, mapUrl, output) {
    if (source == null) return source;
    const codings = sourceCodings(source);
    const firstCoding = codings[0];

    if (!['code', 'system', 'display', 'Coding', 'CodeableConcept'].includes(output)) {
      const message = `translate: unsupported output selector "${output}"`;
      if (strict) throw new Error(message);
      onWarning?.(`${message}; omitting result`);
      return undefined;
    }

    if (!firstCoding) {
      const message = 'translate: source is not a code, Coding, or populated CodeableConcept';
      if (strict) throw new Error(message);
      onWarning?.(`${message}; omitting result`);
      return undefined;
    }

    const idx = byUrl.get(mapUrl);
    if (!idx) {
      if (strict) throw new Error(`Missing ConceptMap: ${mapUrl}`);
      onWarning?.(`translate: ConceptMap not found - ${mapUrl}; returning source coding unchanged`);
      return selectUnchangedTranslationOutput(source, firstCoding, output);
    }

    // Try source codings and matching groups in declaration order.
    let explicitNoMapCode = null;
    let excludedTargetCode = null;
    for (const coding of codings) {
      for (const gi of matchingGroupIndexes(idx, coding)) {
        const entry = idx.lookup.get(`${gi}::${coding.code}`);
        if (!entry) continue;
        if (entry.noMap && entry.targets.length === 0) {
          explicitNoMapCode ??= coding.code;
          continue;
        }

        const target = pickTarget(entry.targets, coding.code, mapUrl);
        if (target !== undefined) {
          return selectTranslationOutput(
            translatedCoding(target, idx.groups[gi]),
            output,
          );
        }
        if (entry.targets.length > 0) excludedTargetCode ??= coding.code;
      }
    }

    // No explicit mapping; try group-level `unmapped` fallbacks.
    for (const coding of codings) {
      for (const gi of matchingGroupIndexes(idx, coding)) {
        const entry = idx.lookup.get(`${gi}::${coding.code}`);
        if (entry?.noMap || entry?.targets.length > 0) continue;

        const unmapped = idx.unmapped.get(gi);
        if (unmapped?.mode === 'fixed' && unmapped.code) {
          onInfo?.(`translate("${coding.code}", ${mapUrl}): no explicit mapping, using fixed unmapped code "${unmapped.code}"`);
          return selectTranslationOutput(
            translatedCoding({ code: unmapped.code }, idx.groups[gi]),
            output,
          );
        }
        if (unmapped?.mode === 'use-source-code' || unmapped?.mode === 'provided') {
          onInfo?.(`translate("${coding.code}", ${mapUrl}): no explicit mapping, using the source code (unmapped.mode=${unmapped.mode})`);
          return selectTranslationOutput(
            translatedCoding({ code: coding.code }, idx.groups[gi]),
            output,
          );
        }
      }
    }

    if (strict) throw new Error(`No mapping for "${firstCoding.code}" in ${mapUrl}`);
    if (explicitNoMapCode !== null) {
      onWarning?.(`translate: "${explicitNoMapCode}" is explicitly marked noMap in ${mapUrl}; returning unchanged`);
    } else if (excludedTargetCode !== null) {
      onWarning?.(`translate: "${excludedTargetCode}" has no related target in ${mapUrl}; returning unchanged`);
    } else {
      onWarning?.(`translate: no mapping for "${firstCoding.code}" in ${mapUrl}; returning unchanged`);
    }
    return selectUnchangedTranslationOutput(source, firstCoding, output);
  }

  return { translate };
}

// ----- Scope chain --------------------------------------------------------

/**
 * Lexically-scoped variable map for rule and group execution.
 *
 * Each group invocation creates a fresh scope chained to its caller; each
 * rule iteration creates a child scope so per-item bindings don't leak.
 * Lookup walks up the parent chain.
 *
 * @example
 *   const outer = new Scope().set('src', srcObj).set('tgt', tgtObj);
 *   const inner = outer.child().set('item', items[0]);
 *   inner.get('src');   // -> srcObj   (resolved via parent)
 *   inner.get('item');  // -> items[0] (own binding)
 */
class Scope {
  /** @param {Scope|null} [parent] */
  constructor(parent = null) {
    /** @type {Map<string, *>} */
    this.bindings = new Map();
    /** @type {Scope|null} */
    this.parent = parent;
  }
  /** Bind `name` to `value` in this scope (shadows any parent binding). */
  set(name, value) { this.bindings.set(name, value); return this; }
  /** Look up `name` in this scope, then walk up the parent chain. */
  get(name) {
    if (this.bindings.has(name)) return this.bindings.get(name);
    return this.parent ? this.parent.get(name) : undefined;
  }
  /** True iff `name` is bound anywhere in this scope or its parents. */
  has(name) {
    if (this.bindings.has(name)) return true;
    return this.parent ? this.parent.has(name) : false;
  }
  /** Create a child scope; its bindings shadow ours without modifying us. */
  child() { return new Scope(this); }
}

// ----- Engine: compile + run ----------------------------------------------

/**
 * Compile FML text (+ optional ConceptMaps) into an executable converter.
 *
 * Diagnostic policy:
 *   - `onWarning` fires whenever the engine takes an action that is not
 *     guaranteed to be semantically correct: lossy translation, missing
 *     map, unimplemented transform, missing source for a polymorphic
 *     read, group-arity mismatch, etc.
 *   - `onInfo` fires for correct-but-noteworthy events: `unmapped.mode=
 *     provided` fall-through, polymorphic field missing from source.
 *
 * Strict mode (`strict`) converts translation warnings into thrown
 * errors. It does NOT affect non-translation warnings; wire `onWarning` to
 * `throw` if you want hard-stop on every potential correctness issue.
 *
 * @param {Object}   opts
 * @param {string}   opts.fmlText                FML mapping source.
 * @param {Object[]} [opts.conceptMaps=[]]       ConceptMap JSON resources.
 * @param {boolean}  [opts.strict=false]
 * @param {string}   [opts.fromVer]              Source FHIR version (e.g. 'R4').
 *                                               Used to update meta.profile after
 *                                               conversion.
 * @param {string}   [opts.toVer]                Target FHIR version (e.g. 'R5').
 * @param {Object}   [opts.mapping]              Selected resource mapping
 *                                               descriptor. Factory-created
 *                                               engines always provide this;
 *                                               raw compiler callers may omit it.
 * @param {Function} [opts.onWarning]            (msg: string) => void
 * @param {Function} [opts.onInfo]               (msg: string) => void
 * @param {Function} [opts.onRuleExec]           ({rule, srcVal}) => void
 *                                               Called after every executed
 *                                               rule; useful for audit logs.
 * @returns {{metadata: Object, uses: Object[], groups: string[], convert: Function}}
 * @throws {SyntaxError} If `fmlText` has malformed rule/group syntax.
 * @throws {Error}       If a ConceptMap is missing `url`/`id`.
 */
export function compileFmlXver({
  fmlText,
  conceptMaps     = [],
  importedFmlTexts = [],
  strict          = false,
  fromVer         = null,
  toVer           = null,
  mapping         = null,
  srcDefs         = null,
  tgtDefs         = null,
  onWarning       = null,
  onInfo          = null,
  onRuleExec      = null,
} = {}) {
  const ast        = parseFml(fmlText, onWarning);
  const groups     = ast.groups;

  // Pre-load groups from imported FML texts (type groups like Coding, Reference, etc.).
  // Imported groups are merged into the local map; local groups take precedence.
  // The imported ASTs are also kept so default-group indexing can find
  // <<types>> / <<type+>> groups declared in them.
  const importedAsts = [];
  for (const importedText of importedFmlTexts) {
    const importedAst = parseFml(importedText, onWarning);
    importedAsts.push(importedAst);
    for (const [name, group] of importedAst.groups) {
      if (!groups.has(name)) {
        groups.set(name, group);
      }
    }
  }

  const translator = makeTranslator(conceptMaps, { strict: strict || false, onWarning, onInfo });

  /**
   * FHIRPath model for the source FHIR version (used by all
   * fhirpath.js evaluations the engine performs). Falls back to
   * undefined when fromVer is unknown, in which case fhirpath.js runs
   * in plain-JSON mode (no FHIR-schema awareness).
   */
  const fpModel = fromVer ? FHIRPATH_MODEL[fromVer] : undefined;

  /**
   * Evaluate a FHIRPath expression authored in an FML rule.
   *
   * Dispatch:
   *   1. If the expression's head identifier is bound in the current
   *      scope, use that binding as the FHIRPath context and strip the
   *      head (and following dot) from the expression. This handles the
   *      common FML idiom where the head is a source alias, e.g.
   *      `v.substring(0, 8)` with `v` bound by `src.value as v`.
   *   2. Otherwise treat the expression as a field-access path on the
   *      iteration context (`$this`) when set, falling back to an empty
   *      object. This handles guards like `coding.exists(...)` or
   *      `reference.resolve().exists()` whose head is a field of the
   *      current iteration item, not a scope alias.
   *
   * Returns the FHIRPath result, normalising the single-element-array
   * case to its bare value (matches the rest of the engine's "scalar
   * unless plural" convention).
   *
   * @param {string} expr             FHIRPath expression text.
   * @param {Scope}  scope            Current rule scope.
   * @param {string} diagLabel        Short label used in warning messages.
   * @returns {*}                     Evaluation result, or undefined.
   */
  function evalFhirpath(expr, scope, diagLabel) {
    try {
      const m = expr.match(FHIRPATH_HEAD_RE);
      let context, rest;
      if (m && scope.has(m[1])) {
        // Head identifier is a scope-bound alias.
        const tail = expr.slice(m[1].length);
        context = scope.get(m[1]);
        if (tail === '' || tail[0] === '.') {
          // `alias` alone, or `alias.path...` -- strip the alias and
          // optional dot; the remainder evaluates against the binding.
          rest = tail.startsWith('.') ? tail.slice(1) : '';
        } else {
          // Alias followed by a non-dot continuation, typically an
          // infix word operator: `vs in (...)`, `s = 'x' and ...`, etc.
          // Replacing the head with $this lets fhirpath.js parse the
          // operator correctly while still rooting evaluation at the
          // alias binding (which is the context passed in).
          rest = '$this' + tail;
        }
      } else {
        context = scope.has('$this') ? scope.get('$this') : {};
        rest = expr;
      }
      if (context == null) context = {};
      if (!rest) return context;
      const result = fhirpathLib.evaluate(context, rest, {}, fpModel);
      if (Array.isArray(result)) {
        if (result.length === 0) return undefined;
        if (result.length === 1) return result[0];
      }
      return result;
    } catch (e) {
      onWarning?.(`FHIRPath ${diagLabel} evaluation failed for "${expr}": ${e.message}`);
      return undefined;
    }
  }

  /**
   * Build the set of last-segment names that appear as polymorphic fields
   * anywhere in a FHIR version (e.g. "value", "initial", "deceased").
   *
   * The input is the consolidated defs object (see data/fhir-defs/{VER}.json);
   * its `polyPaths` keys are full dotted paths from the resource root,
   * e.g. "Observation.value", "Questionnaire.item.initial.value",
   * "Patient.deceased". Only the final segment is retained here.
   *
   * Returns an empty Set when `defs` or `defs.polyPaths` is missing.
   *
   * @param {Object|null} defs  Parsed FHIR defs JSON, or null.
   * @returns {Set<string>}
   */
  function buildPolyLeaves(defs) {
    const leaves = new Set();
    if (defs?.polyPaths) {
      for (const k of Object.keys(defs.polyPaths)) {
        leaves.add(k.split('.').pop());
      }
    }
    return leaves;
  }

  /**
   * Polymorphic-leaf set for the source FHIR version. Used by readSource()
   * to decide whether a bare-path miss is a candidate for variant expansion
   * ("initial" -> "initialString"). Target polymorphism is resolved by its
   * absolute path through tgtPolyTypeLists below.
   */
  const srcPolyLeaves = buildPolyLeaves(srcDefs);
  // Whether target polymorphic metadata is available. When it is, the poly
  // path table is authoritative for deciding whether a suffix may be appended;
  // when it is absent (e.g. defs-less unit tests) the engine falls back to a
  // source/target leaf-name heuristic. An explicitly empty table is still
  // authoritative: it means none of the supplied target paths is polymorphic.
  const hasTgtPolyInfo = tgtDefs?.polyPaths != null;

  /**
   * Set of absolute dotted paths whose target field is an array
   * (`max > 1`) in the target FHIR version. Consumed by writeToSlot()
   * (called from every write site) to decide whether to push (or
   * initialize an array) rather than overwrite a slot.
   */
  const tgtArrayPaths = new Set(tgtDefs?.arrayPaths || []);

  /**
   * Set of FHIR resource type names (kind === 'resource') across the source
   * and target versions, built from the defs' `resourceTypes` arrays. Used by
   * the `create('X')` transform to decide whether an instance should carry
   * `resourceType` (resources) or be a bare object (primitives / datatypes).
   * The union is safe because resource-ness is version-stable; consulting
   * both versions tolerates a type present in only one of the loaded defs.
   * Empty when no defs are supplied (raw compile), in which case `create()`
   * adds no `resourceType`.
   */
  const resourceTypeSet = new Set([
    ...(srcDefs?.resourceTypes || []),
    ...(tgtDefs?.resourceTypes || []),
  ]);

  /**
   * Maps of absolute FHIR dotted paths to their single concrete type
   * code (e.g. "canonical", "Reference", "Identifier") for non-poly
   * scalar elements in the source and target FHIR versions. These power
   * default-group dispatch and primitive serialization.
   */
  const srcElementTypes = new Map(Object.entries(srcDefs?.elementTypes || {}));
  const tgtElementTypes = new Map(Object.entries(tgtDefs?.elementTypes || {}));

  /**
   * Look up schema metadata for an absolute FHIR path, re-rooting at complex
   * datatype boundaries when the resource snapshot does not expand datatype
   * internals. For example, `Patient.name.family` resolves by first finding
   * `Patient.name -> HumanName`, then looking up `HumanName.family`.
   *
   * @param {Map<string, *>} index Schema metadata keyed by FHIR path.
   * @param {Map<string, string>} elementTypes Element-type table for the same version.
   * @param {string|null} absolutePath Resource- or datatype-rooted FHIR path.
   * @param {Set<string>} [visited] Re-rooted paths already inspected.
   * @returns {*|undefined} The indexed value, or undefined when unresolved.
   */
  function lookupSchemaEntry(index, elementTypes, absolutePath, visited = new Set()) {
    if (!absolutePath || visited.has(absolutePath)) return undefined;
    visited.add(absolutePath);

    if (index.has(absolutePath)) return index.get(absolutePath);

    const segs = absolutePath.split('.');
    for (let i = segs.length - 1; i >= 1; i--) {
      const parentType = elementTypes.get(segs.slice(0, i).join('.'));
      if (!parentType || parentType[0] !== parentType[0].toUpperCase()) continue;

      const rerootedPath = `${parentType}.${segs.slice(i).join('.')}`;
      const value = lookupSchemaEntry(index, elementTypes, rerootedPath, visited);
      if (value !== undefined) return value;
    }

    return undefined;
  }

  /** Return the source element type at an absolute, possibly nested path. */
  function sourceElementType(absolutePath) {
    return lookupSchemaEntry(srcElementTypes, srcElementTypes, absolutePath) || null;
  }

  /** Return the target element type at an absolute, possibly nested path. */
  function targetElementType(absolutePath) {
    return lookupSchemaEntry(tgtElementTypes, tgtElementTypes, absolutePath) || null;
  }

  const srcPolyTypeLists = new Map(Object.entries(srcDefs?.polyPaths || {}));

  /**
   * Map from absolute FHIR dotted paths to the list of allowed FHIR type
   * codes for polymorphic fields in the target FHIR version (e.g.
   * "Questionnaire.item.enableWhen.answer" ->
   * ["boolean","decimal","integer","date","dateTime","time","string",
   *  "Coding","Quantity","Reference"]).
   *
   * Used to validate inferred polymorphic suffixes: when applyTarget
   * derives a suffix from the source's declared type, it checks that the
   * type is actually one of the allowed variants of the target poly
   * field. This avoids writing fields like `answerCode` (invalid: R4
   * enableWhen.answer doesn't accept `code` as a variant) just because
   * the source happened to be of type `code`.
   */
  const tgtPolyTypeLists = new Map(Object.entries(tgtDefs?.polyPaths || {}));

  /** Return source polymorphic choices at an absolute, possibly nested path. */
  function sourcePolyTypes(absolutePath) {
    return lookupSchemaEntry(srcPolyTypeLists, srcElementTypes, absolutePath) || null;
  }

  /** Return target polymorphic choices at an absolute, possibly nested path. */
  function targetPolyTypes(absolutePath) {
    return lookupSchemaEntry(tgtPolyTypeLists, tgtElementTypes, absolutePath) || null;
  }

  /**
   * Resolve concrete JSON names for polymorphic target fields back to their
   * bare FHIR path and type. For example,
   * `Questionnaire.item.enableWhen.answerString` maps to
   * `{ path: "Questionnaire.item.enableWhen.answer", type: "string" }`.
   *
   * @type {Map<string, {path: string, type: string}>}
   */
  const tgtTypedPolyPaths = new Map();
  for (const [polyPath, types] of tgtPolyTypeLists) {
    const segs = polyPath.split('.');
    const leaf = segs.pop();
    const parentPath = segs.join('.');
    for (const type of types) {
      const typedPath = `${parentPath}.${leaf}${cap(type)}`;
      tgtTypedPolyPaths.set(typedPath, { path: polyPath, type });
    }
  }

  /**
   * Return the FHIR primitive type at a concrete target JSON path.
   *
   * Handles both ordinary primitive paths and concrete names of polymorphic
   * primitives such as `valueString`.
   *
   * @param {string|null} absolutePath Absolute target FHIR path.
   * @returns {string|null} Primitive type code, or null for non-primitives.
   */
  function targetPrimitiveType(absolutePath) {
    if (!absolutePath) return null;
    const directType = targetElementType(absolutePath);
    if (FHIR_PRIMITIVES.has(directType)) return directType;
    const typed = lookupSchemaEntry(tgtTypedPolyPaths, tgtElementTypes, absolutePath);
    return typed && FHIR_PRIMITIVES.has(typed.type) ? typed.type : null;
  }

  /**
   * Return the schema path used for target cardinality checks.
   *
   * Concrete polymorphic JSON names are absent from `arrayPaths`, whose keys
   * use the bare `[x]` path, so normalize them before checking cardinality.
   *
   * @param {string|null} absolutePath Absolute target FHIR path.
   * @returns {string|null} Schema path.
   */
  function targetSchemaPath(absolutePath) {
    return lookupSchemaEntry(tgtTypedPolyPaths, tgtElementTypes, absolutePath)?.path || absolutePath;
  }

  /**
   * Build indexes of FML default mapping groups across the main and imported
   * ASTs. Both `<<types>>` and `<<type+>>` groups are indexed by their exact
   * source/target pair. `<<type+>>` groups are additionally indexed by source
   * type so they can select a concrete target for a polymorphic field.
   *
   * Parameter aliases are resolved to canonical FHIR type codes using their
   * `uses` declarations (for example, HumanNameR2 -> HumanName).
   *
   * @param {Ast[]} asts Parsed ASTs (main + imported).
   * @returns {{byPair: Map<string, string>, typePlusBySource: Map<string, Object[]>}}
   *   Exact-pair groups and `<<type+>>` candidates keyed by source type.
   */
  function buildDefaultGroupIndexes(asts) {
    // Pass 1: gather alias -> canonical FHIR type code from `uses` decls.
    // Canonical is the last URL segment under /StructureDefinition/
    // (e.g. "Reference", "canonical"). Alias may be absent in the `uses`
    // declaration; when absent, the canonical name itself doubles as the
    // alias.
    const aliases = new Map();
    for (const a of asts) {
      for (const u of a.uses) {
        const m = u.url.match(/\/StructureDefinition\/(\w+)$/);
        if (!m) continue;
        const canonical = m[1];
        const alias = u.alias || canonical;
        if (!aliases.has(alias)) aliases.set(alias, canonical);
      }
    }

    // Pass 2: find default groups and resolve their parameter types. The FML
    // contract requires exactly one source and one target parameter.
    const byPair = new Map();
    const typePlusBySource = new Map();
    for (const a of asts) {
      for (const [name, g] of a.groups) {
        const isTypes = g.annotations?.includes('types');
        const isTypePlus = g.annotations?.includes('type+');
        if (!isTypes && !isTypePlus) continue;
        if (g.params.length !== 2) continue;
        const [srcParam, tgtParam] = g.params;
        if (srcParam.mode !== 'source' || tgtParam.mode !== 'target') continue;
        if (!srcParam.type || !tgtParam.type) continue;
        const srcType = aliases.get(srcParam.type) || srcParam.type;
        const tgtType = aliases.get(tgtParam.type) || tgtParam.type;
        const key = `${srcType}::${tgtType}`;
        if (!byPair.has(key)) byPair.set(key, name);

        if (isTypePlus) {
          const candidates = typePlusBySource.get(srcType) || [];
          if (!candidates.some(candidate => candidate.targetType === tgtType)) {
            candidates.push({ groupName: name, targetType: tgtType });
          }
          typePlusBySource.set(srcType, candidates);
        }
      }
    }
    return { byPair, typePlusBySource };
  }

  /**
   * Default group indexes built from all `<<types>>` and `<<type+>>` groups
   * in the main and imported FML ASTs.
   */
  const {
    byPair: defaultGroupsByPair,
    typePlusBySource,
  } = buildDefaultGroupIndexes([ast, ...importedAsts]);

  /**
   * Type-mismatch diagnostics already emitted during the current conversion.
   * Array iteration can inspect the same source/target path once per item, but
   * the report should describe that mapping gap only once per resource.
   *
   * @type {Set<string>}
   */
  const reportedTypeMismatches = new Set();

  /**
   * Maps each target object created by the engine to its absolute FHIR
   * path from the resource root (e.g. {} -> "Questionnaire.item").
   *
   * We use a WeakMap rather than threading paths through Scope or
   * execGroup signatures because object identity is preserved across
   * scope binding, group invocation, and child propagation. The entry
   * we set when a child is created is still available when the same
   * object is later resolved as `tgt` inside a callee group.
   *
   * Source and target paths are both tracked so default groups and nested
   * datatype metadata can be resolved after values cross scope boundaries.
   */
  const objectPaths = new WeakMap();

  /** Record an object's absolute FHIR path (no-op for non-objects or null path). */
  function setObjectPath(obj, fhirPath) {
    if (fhirPath && obj && typeof obj === 'object') {
      objectPaths.set(obj, fhirPath);
    }
  }

  /** Return the absolute FHIR path for an object, or null if unknown. */
  function getObjectPath(obj) {
    if (!obj || typeof obj !== 'object') return null;
    return objectPaths.get(obj) || null;
  }

  /**
   * Compose a child path from a parent object and a relative path fragment.
   * Returns null when the parent's path is unknown, so callers can choose
   * to skip the path-aware behavior gracefully.
   */
  function composeChildPath(parentObj, fragment) {
    const p = getObjectPath(parentObj);
    if (!p || !fragment) return null;
    return p + '.' + fragment;
  }

  /**
   * Decide whether an absolute, resource-rooted target path is array-typed
   * (`max > 1`) in the target FHIR version.
   *
   * First normalizes a concrete polymorphic JSON name (e.g. `valueString ->
   * value[x]`) via `targetSchemaPath`, since `arrayPaths` keys use the bare
   * `[x]` form.
   *
   * The `arrayPaths` table keys datatype-internal array fields by the
   * DATATYPE root (e.g. `CodeableConcept.coding`), because a resource's
   * StructureDefinition snapshot does not expand complex-datatype internals.
   * A path the engine composes from the resource root (e.g.
   * `Encounter.class.coding`) therefore never matches directly. When the
   * direct lookup misses, this re-roots the path at each datatype boundary
   * (found via `elementTypes`, e.g. `Encounter.class -> CodeableConcept`) and
   * retries, recursing to handle nested datatypes. Purely additive: it only
   * recognizes fields that are genuinely arrays per the datatype's own
   * definition; it never demotes an existing array path.
   *
   * @param {string} absPath  Absolute resource-rooted dotted path.
   * @returns {boolean}
   */
  function isTgtArrayPath(absPath) {
    if (!absPath) return false;
    const schemaPath = targetSchemaPath(absPath);
    if (tgtArrayPaths.has(schemaPath)) return true;
    const segs = schemaPath.split('.');
    for (let i = segs.length - 1; i >= 1; i--) {
      const t = tgtElementTypes.get(segs.slice(0, i).join('.'));
      // Only complex types (upper-camel) have sub-paths worth re-rooting;
      // primitives never do.
      if (t && t[0] === t[0].toUpperCase()) {
        if (isTgtArrayPath(t + '.' + segs.slice(i).join('.'))) return true;
      }
    }
    return false;
  }

  /**
   * Write `value` to `parent[key]`, honoring target-version cardinality and
   * FHIR primitive serialization:
   *
   *   - If `absolutePath` is known to be an array field, push or initialize
   *     an array; otherwise assign scalar.
   *   - If `value` is a `{value: X, id?, extension?}` wrapper object and the
   *     absolute path resolves to a FHIR primitive type, write `X` to the
   *     ordinary field and write `id`/`extension` to the `_field` companion.
   *     This handles the FML idiom
   *     `tgt.X as t, t.value = ...` (and similar nested forms) which
   *     produce a wrapper object that must be collapsed back to the
   *     split JSON FHIR primitive encoding.
   *   - A companion supplied directly from a source binding follows the same
   *     path. This preserves metadata on shortcut copies/transforms that do
   *     not invoke a primitive conversion group.
   *   - Repeating primitive values and companions are appended together with
   *     null padding so their indices remain aligned.
   *
   * Used at all engine write sites: the general writeTarget() path and
   * the child-container creation sites (then-clause and inline-multi-
   * target lift). Routing every write through this helper ensures
   * target-version array cardinality is always honored.
   *
   * @param {Object} parent Parent object receiving the value.
   * @param {string} key Property name on the parent.
   * @param {*} value Value to write.
   * @param {string|null} absolutePath Absolute target FHIR path.
   * @param {*} [companion] Primitive metadata aligned with the value.
   * @returns {void}
   */
  function writeToSlot(parent, key, value, absolutePath, companion = undefined) {
    const primitiveType = targetPrimitiveType(absolutePath);
    if (primitiveType) {
      /**
       * Convert one expanded primitive wrapper into its bare value and
       * companion object. Non-wrapper values pass through unchanged.
       *
       * @param {*} item Candidate primitive value.
       * @param {*} suppliedCompanion Companion carried by binding provenance.
       * @returns {{value: *, companion: *}}
       */
      const splitPrimitive = (item, suppliedCompanion) => {
        if (!isObject(item)) {
          return { value: item, companion: suppliedCompanion };
        }
        const keys = Object.keys(item);
        if (!keys.every(k => k === 'value' || k === 'id' || k === 'extension')) {
          return { value: item, companion: suppliedCompanion };
        }
        const wrapperCompanion = {};
        if (item.id !== undefined) wrapperCompanion.id = deepClone(item.id);
        if (item.extension !== undefined) {
          wrapperCompanion.extension = deepClone(item.extension);
        }
        return {
          value: item.value,
          companion: suppliedCompanion ?? (
            Object.keys(wrapperCompanion).length > 0 ? wrapperCompanion : undefined
          ),
        };
      };

      if (isTgtArrayPath(absolutePath)) {
        const rawValues = Array.isArray(value) ? value : [value];
        const rawCompanions = Array.isArray(companion) ? companion : [companion];
        const values = [];
        const companions = [];
        for (let i = 0; i < rawValues.length; i++) {
          const split = splitPrimitive(rawValues[i], rawCompanions[i]);
          values.push(split.value === undefined ? null : split.value);
          companions.push(split.companion ?? null);
        }

        const existingCount = Array.isArray(parent[key])
          ? parent[key].length
          : parent[key] === undefined ? 0 : 1;
        if (Array.isArray(parent[key])) parent[key] = parent[key].concat(values);
        else if (parent[key] === undefined) parent[key] = values;
        else parent[key] = [parent[key], ...values];

        const companionKey = `_${key}`;
        const hasNewCompanion = companions.some(item => item != null);
        if (Array.isArray(parent[companionKey]) || hasNewCompanion) {
          let existingCompanions;
          if (Array.isArray(parent[companionKey])) {
            existingCompanions = parent[companionKey];
          } else {
            existingCompanions = Array(existingCount).fill(null);
          }
          parent[companionKey] = existingCompanions.concat(companions.map(deepClone));
        }
        return;
      }

      const split = splitPrimitive(value, companion);
      if (split.value !== undefined) parent[key] = split.value;
      if (split.companion != null) {
        parent[`_${key}`] = deepClone(split.companion);
      }
      return;
    }

    if (value === undefined) return;

    if (absolutePath && isTgtArrayPath(absolutePath)) {
      if (Array.isArray(value)) {
        // Bulk copy: `value` is already the array contents (typical of
        // `src.foo -> tgt.foo` where `foo` is array-typed in both
        // versions). Assign directly, or concat into an existing array.
        if (Array.isArray(parent[key])) parent[key] = parent[key].concat(value);
        else                            parent[key] = value;
      } else if (Array.isArray(parent[key])) {
        parent[key].push(value);
      } else if (parent[key] === undefined) {
        parent[key] = [value];
      } else {
        onWarning?.(`writeToSlot: ${absolutePath} is array-typed but slot has a non-array value; wrapping`);
        parent[key] = [parent[key], value];
      }
    } else {
      parent[key] = value;
    }
  }

  /**
   * Resolve one TransformArg against the current scope.
   *   - `kind: 'literal'` -> return the literal string.
   *   - `kind: 'ident'`   -> the bare words `true`, `false`, `null` are
   *                          returned as their JS literal values (FML uses
   *                          them as boolean/null literals on the RHS of
   *                          target assignments). Otherwise look up in
   *                          scope; if absent, warn and fall back to the
   *                          bare word.
   */
  function resolveArg(arg, scope) {
    if (arg.kind === 'literal') return arg.value;
    if (arg.kind === 'ident') {
      if (arg.value === 'true')  return true;
      if (arg.value === 'false') return false;
      if (arg.value === 'null')  return null;
    }
    if (scope.has(arg.value))   return scope.get(arg.value);
    onWarning?.(`Transform arg "${arg.value}" not found in scope; treating as literal string`);
    return arg.value;
  }

  /**
   * Evaluate a Transform expression and return its result.
   * See the @fileoverview "Transform reference" for supported functions.
   * Unknown / unimplemented transforms warn and return undefined.
   */
  function evalTransform(transform, scope) {
    if (!transform) return undefined;
    const { fn, args } = transform;

    switch (fn) {
      case 'literal': return args[0];

      case 'varRef': {
        const name = args[0];
        // FML uses bare `true`/`false`/`null` as boolean/null literals on
        // RHS of target assignments (e.g. `tgt.hasAnswer = true`).
        if (name === 'true')  return true;
        if (name === 'false') return false;
        if (name === 'null')  return null;
        if (scope.has(name)) {
          const v = scope.get(name);
          const cloned = deepClone(v);
          const srcPath = getObjectPath(v);
          if (srcPath) setObjectPath(cloned, srcPath);
          return cloned;
        }
        onWarning?.(`varRef "${name}" not found in scope; treating as literal string`);
        return name;
      }

      case 'translate': {
        const source = resolveArg(args[0], scope);
        const mapUrl = args[1].value;  // always a literal in valid FML
        const output = resolveArg(args[2], scope);
        return translator.translate(source, mapUrl, output);
      }

      case 'copy': {
        const v = resolveArg(args[0], scope);
        return deepClone(v);
      }

      case 'create': {
        // Only resources carry `resourceType` in FHIR JSON. Primitives and
        // complex datatypes (e.g. CodeableConcept, Coding) get a bare object
        // that subsequent rules populate. Resource-ness comes from the defs'
        // `resourceTypes` (kind === 'resource'); see resourceTypeSet. Without
        // defs the set is empty, so no `resourceType` is added.
        const typeName = args[0]?.value;
        if (!typeName) return {};
        return resourceTypeSet.has(typeName) ? { resourceType: typeName } : {};
      }

      case 'truncate': {
        const v = resolveArg(args[0], scope);
        const n = parseInt(args[1].value, 10);
        if (typeof v !== 'string') {
          onWarning?.(`truncate: value is ${typeof v}, expected string; returning unchanged`);
          return v;
        }
        return v.substring(0, n);
      }

      case 'cast': {
        const v    = resolveArg(args[0], scope);
        const type = args[1].value;
        switch (type) {
          case 'string':  return String(v ?? '');
          case 'boolean': return Boolean(v);
          case 'integer': return parseInt(v, 10);
          case 'decimal': return parseFloat(v);
          default:
            onWarning?.(`cast: unrecognised type "${type}"; returning value unchanged`);
            return v;
        }
      }

      case 'append':
        return args.map(a => {
          const v = resolveArg(a, scope);
          return v == null ? '' : String(v);
        }).join('');

      case 'reference': {
        const v = resolveArg(args[0], scope);
        if (v == null) return undefined;
        if (isObject(v)) return v;
        return { reference: String(v) };
      }

      case 'c': {
        const o = {};
        if (args[0]) o.system  = resolveArg(args[0], scope);
        if (args[1]) o.code    = resolveArg(args[1], scope);
        if (args[2]) o.display = resolveArg(args[2], scope);
        return o;
      }

      case 'cc': {
        const coding = {};
        if (args[0]) coding.system  = resolveArg(args[0], scope);
        if (args[1]) coding.code    = resolveArg(args[1], scope);
        if (args[2]) coding.display = resolveArg(args[2], scope);
        return { coding: [coding] };
      }

      case 'id': {
        const id = {};
        if (args[0]) id.system = resolveArg(args[0], scope);
        if (args[1]) id.value  = resolveArg(args[1], scope);
        return id;
      }

      case 'qty': {
        const q = {};
        if (args[0] !== undefined) q.value  = parseFloat(resolveArg(args[0], scope));
        if (args[1])               q.unit   = resolveArg(args[1], scope);
        if (args[2])               q.system = resolveArg(args[2], scope);
        if (args[3])               q.code   = resolveArg(args[3], scope);
        return q;
      }

      case 'uuid':
      case 'dateOp':
      case 'evaluate':
      case 'pointer':
      case 'escape':
        onWarning?.(`Transform "${fn}" is not implemented; rule will produce no value`);
        return undefined;

      case 'fhirpath': {
        const expr = args[0];
        return evalFhirpath(expr, scope, 'transform');
      }

      default:
        onWarning?.(`Unknown transform function: ${fn}`);
        return undefined;
    }
  }

  /**
   * Evaluate a guard expression against the current scope.
   *
   * The `left` is a dot-path whose head segment must be bound in scope;
   * we then walk the remaining segments on the bound value. An unbound
   * head is treated as a false guard (with a warning); guards exist to
   * filter, not to fail loudly.
   *
   * Comparisons are string-equality on `String(left)` vs `String(right)`,
   * which matches FML's untyped semantics. With no operator, the guard is
   * an existence check (true iff value is not null/undefined/false).
   *
   * @returns {boolean} True if the guard passes (or there is no guard).
   */
  function evalGuard(guard, scope) {
    if (!guard) return true;

    // FHIRPath-based guard expression
    if (guard.fhirpath) {
      const result = evalFhirpath(guard.fhirpath, scope, 'guard');
      // FHIRPath truthy: non-empty collection, not [false]; evalFhirpath
      // already collapses single-element arrays to their value and
      // empties to undefined.
      if (result === undefined || result === null) return false;
      if (Array.isArray(result)) {
        if (result.length === 0) return false;
        if (result.length === 1 && result[0] === false) return false;
        return true;
      }
      return result !== false;
    }

    const segs = guard.left.split('.');
    const head = segs[0];
    let left;

    if (scope.has(head)) {
      // Qualified reference: e.g., "vs0.type" or "src.status"
      const base = scope.get(head);
      left = segs.length > 1 ? getPath(base, segs.slice(1).join('.')) : base;
    } else if (scope.has('$this')) {
      // Unqualified reference: e.g., "type" resolves to $this.type (iteration context)
      const thisVal = scope.get('$this');
      left = getPath(thisVal, guard.left);
    } else {
      onWarning?.(`Guard references unknown variable "${head}"; treating guard as false`);
      return false;
    }

    if (!guard.op) return left != null && left !== false;
    if (guard.op === '=')  return String(left) === String(guard.right);
    if (guard.op === '!=') return String(left) !== String(guard.right);
    return true;
  }

  /**
   * Read a value from one source clause's context + path.
   *
   * For polymorphic sources (`src.value : boolean`), reads from the typed
   * variant of the polymorphic field (`src.valueBoolean`). The variant
   * name is taken from the rule's `trailingString` when present (FML's
   * authoritative hint), otherwise computed as `root + Cap(typeHint)`.
   *
   * Bare polymorphic reference (no `: Type` hint): when the path resolves
   * to undefined AND its leaf is a known polymorphic field name in the
   * source FHIR version (per srcPolyPaths), the parent object is scanned
   * for a typed variant matching `^leaf[A-Z]\w+$`. If exactly one such
   * key is present (the FHIR spec guarantees only one variant per
   * polymorphic instance), it is returned along with its name as polyName.
   * Multiple matches yield a warning and no value.
   *
   * Primitive sources also return their JSON `_field` companion. The value
   * remains bare so guards, transforms, and polymorphic inference retain their
   * existing behavior.
   *
   * Returns `{ctx, value, companion, present, polyName, polySuffix,
   * sourceLeaf}` where:
   *   - polyName    : full typed source field name (e.g. "initialString"),
   *                   kept for diagnostics.
   *   - polySuffix  : capitalized FHIR type suffix (e.g. "String",
   *                   "Boolean"). The write side composes
   *                   `targetLeaf + polySuffix` for the actual write.
   *   - sourceLeaf  : last segment of the source path (e.g. "initial").
   *                   Used by writeTarget to decide when to apply the
   *                   suffix (same-leaf vs different-leaf rules).
   */
  function readSource(srcSpec, scope, trailingString) {
    if (scope.get(srcSpec.context) == null) {
      return {
        ctx: null,
        value: undefined,
        companion: undefined,
        present: false,
        polyName: null,
        polySuffix: null,
        sourceLeaf: null,
      };
    }
    const ctx = scope.get(srcSpec.context);

    if (!srcSpec.path) {
      return {
        ctx,
        value: ctx,
        companion: undefined,
        present: true,
        polyName: null,
        polySuffix: null,
        sourceLeaf: null,
      };
    }

    /**
     * Tag a source value with its absolute FHIR path so write-time type
     * default-group dispatch can look up its element type. For arrays, tag each
     * element with the same path (FHIR paths are array-blind: items
     * share their parent collection's path).
     */
    const tagSourcePath = (value, absPath) => {
      if (!absPath || value == null || typeof value !== 'object') return;
      setObjectPath(value, absPath);
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item != null && typeof item === 'object') setObjectPath(item, absPath);
        }
      }
    };

    /**
     * Read the `_field` companion for a known primitive source field.
     *
     * @param {Object} rootContext Source context object.
     * @param {string} sourcePath Parsed source path.
     * @param {string} actualLeaf Concrete JSON leaf name.
     * @param {string|null} primitiveType Source primitive type.
     * @returns {*|undefined} Companion object/array when present.
     */
    const readCompanion = (rootContext, sourcePath, actualLeaf, primitiveType) => {
      if (!FHIR_PRIMITIVES.has(primitiveType)) return undefined;
      const segs = sourcePath.split('.');
      const parent = segs.length > 1
        ? getPath(rootContext, segs.slice(0, -1).join('.'))
        : rootContext;
      return parent == null ? undefined : parent[`_${actualLeaf}`];
    };

    if (srcSpec.typeHint) {
      const segs   = srcSpec.path.split('.');
      const parent = segs.length > 1 ? getPath(ctx, segs.slice(0, -1).join('.')) : ctx;
      const root   = segs[segs.length - 1];
      const polyName   = trailingString || (root + cap(srcSpec.typeHint));
      const polySuffix = cap(srcSpec.typeHint);
      let value         = parent ? parent[polyName] : undefined;
      const companion   = readCompanion(ctx, srcSpec.path, polyName, srcSpec.typeHint);
      if (value === undefined && Array.isArray(companion)) {
        value = companion.map(() => null);
      }
      if (parent != null && value === undefined && companion === undefined) {
        onInfo?.(`readSource: polymorphic field "${polyName}" not present (typeHint=${srcSpec.typeHint})`);
      }
      tagSourcePath(value, composeChildPath(ctx, srcSpec.path));
      return {
        ctx,
        value,
        companion,
        present: value != null || companion != null,
        polyName,
        polySuffix,
        sourceLeaf: root,
      };
    }

    const directAbsPath = composeChildPath(ctx, srcSpec.path);
    const sourceType = directAbsPath ? sourceElementType(directAbsPath) : null;
    const directLeaf = srcSpec.path.split('.').pop();
    const directCompanion = readCompanion(ctx, srcSpec.path, directLeaf, sourceType);
    let directValue = getPath(ctx, srcSpec.path);
    if (directValue === undefined && Array.isArray(directCompanion)) {
      directValue = directCompanion.map(() => null);
    }
    if (directValue !== undefined || directCompanion !== undefined) {
      tagSourcePath(directValue, composeChildPath(ctx, srcSpec.path));
      return {
        ctx,
        value: directValue,
        companion: directCompanion,
        present: directValue != null || directCompanion != null,
        polyName: null,
        polySuffix: null,
        sourceLeaf: directLeaf,
      };
    }

    // Source-clause `default "value"`: when the source path is absent,
    // substitute the literal default the FML author declared so the rule
    // still fires. Parsed by parseOneSource into srcSpec.defaultValue.
    if (srcSpec.defaultValue !== undefined) {
      return {
        ctx,
        value: srcSpec.defaultValue,
        companion: undefined,
        present: true,
        polyName: null,
        polySuffix: null,
        sourceLeaf: null,
      };
    }

    // Bare-path miss: try polymorphic variant expansion when the leaf is
    // known to be polymorphic in the source FHIR version.
    if (srcPolyLeaves.size > 0) {
      const segs   = srcSpec.path.split('.');
      const leaf   = segs[segs.length - 1];
      if (srcPolyLeaves.has(leaf)) {
        const parent = segs.length > 1 ? getPath(ctx, segs.slice(0, -1).join('.')) : ctx;
        if (parent != null && typeof parent === 'object') {
          const escaped = leaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re      = new RegExp('^' + escaped + '[A-Z]\\w*$');
          const matches = [...new Set(
            Object.keys(parent)
              .map(k => k.startsWith('_') ? k.slice(1) : k)
              .filter(k => re.test(k)),
          )];
          if (matches.length === 1) {
            const polyName   = matches[0];
            const polySuffix = polyName.slice(leaf.length);
            const polyTypes = sourcePolyTypes(composeChildPath(ctx, srcSpec.path)) || [];
            const sourceType = polyTypes.find(type => cap(type) === polySuffix) || null;
            const companion = readCompanion(ctx, srcSpec.path, polyName, sourceType);
            let value = parent[polyName];
            if (value === undefined && Array.isArray(companion)) {
              value = companion.map(() => null);
            }
            onInfo?.(`readSource: expanded bare polymorphic ref "${srcSpec.path}" to "${polyName}"`);
            // Tag with the bare-leaf path (matches srcElementTypes keys,
            // though poly fields wouldn't have a scalar type entry anyway).
            tagSourcePath(value, composeChildPath(ctx, srcSpec.path));
            return {
              ctx,
              value,
              companion,
              present: value != null || companion != null,
              polyName,
              polySuffix,
              sourceLeaf: leaf,
            };
          }
          if (matches.length > 1) {
            onWarning?.(`readSource: ambiguous polymorphic expansion for "${srcSpec.path}": found ${matches.join(', ')}; not expanding`);
          }
        }
      }
    }

    return {
      ctx,
      value: undefined,
      companion: undefined,
      present: false,
      polyName: null,
      polySuffix: null,
      sourceLeaf: null,
    };
  }

  /**
   * Build the expanded logical form expected by FML primitive groups.
   *
   * JSON FHIR stores Element metadata in a sibling `_field`; FML groups see
   * that same primitive as an Element-like object with `value`, `id`, and
   * `extension`.
   *
   * @param {*} value Bare primitive value.
   * @param {Object|null|undefined} companion JSON primitive companion.
   * @returns {Object} Expanded primitive.
   */
  function expandPrimitive(value, companion) {
    const expanded = {};
    if (value !== undefined && value !== null) expanded.value = deepClone(value);
    if (isObject(companion)) {
      if (companion.id !== undefined) expanded.id = deepClone(companion.id);
      if (companion.extension !== undefined) {
        expanded.extension = deepClone(companion.extension);
      }
    }
    return expanded;
  }

  /**
   * Infer the FHIR polymorphic-type suffix from a JS value's runtime type.
   * Returns `null` for ambiguous cases where guessing would be unsafe:
   * strings could be `string`/`code`/`date`/`time`/`dateTime`/`uri`/...,
   * and objects could be `Coding`/`Reference`/`Quantity`/`Identifier`/
   * `CodeableConcept`/etc. Used as a fallback when writing to a target
   * leaf that is polymorphic in the target FHIR version (e.g. R4
   * `enableWhen.answer[x]`) and the source rule provided no explicit
   * type hint.
   *
   * Only unambiguous primitive types are inferred:
   *   - boolean -> "Boolean"
   *   - integer number -> "Integer"
   *   - non-integer number -> "Decimal"
   *
   * Without this, the engine would write the bare polymorphic leaf
   * (e.g. `tgt.answer = true`), producing invalid FHIR JSON since every
   * polymorphic field must use one of its typed variants.
   *
   * @param {*} v
   * @returns {string|null}
   */
  function inferPolySuffixFromValue(v) {
    if (typeof v === 'boolean') return 'Boolean';
    if (typeof v === 'number') return Number.isInteger(v) ? 'Integer' : 'Decimal';
    return null;
  }

  /**
   * Write a value into the target context at `tgtSpec.path`.
   *
   * Polymorphic suffix logic: when `polySuffix` is provided (because the
   * matched source was polymorphic), the suffix is appended to the
   * target path's last segment provided one of:
   *   - target leaf equals the source leaf (`src.X : Type -> tgt.X` -
     classical same-root rule), OR
   *   - target leaf is itself polymorphic in the target FHIR version
   *     (`src.initial -> tgt.value` style: target field is `value[x]` in
   *     the target version, so `valueString` is a valid composition).
   *
   * When `polySuffix` is null but the target leaf IS polymorphic in the
   * target version, fall back to inferring the suffix from the value's
   * JS type (boolean/number only; see inferPolySuffixFromValue). This
   * fixes FML rules of the form `tgt.poly = v` where v's type is the
   * only information available about which variant to write.
   *
   * Otherwise the bare path is written. This prevents the source's
   * polymorphic suffix from leaking into unrelated targets (e.g. writing
   * to `tgt.operator` should not become `tgt.operatorBoolean`).
   *
   * Warns when the target context is missing or when a non-object value
   * would be assigned to a bare context (no path); both indicate a likely
   * FML/data mismatch.
   *
   * @param {Target} tgtSpec Target clause.
   * @param {*} value Target value.
   * @param {Scope} scope Current execution scope.
   * @param {string|null} polySuffix Concrete polymorphic type suffix.
   * @param {string|null} sourceLeaf Bare source field name.
   * @param {Object|Array|null|undefined} companion Primitive companion.
   * @returns {void}
   */
  function writeTarget(
    tgtSpec,
    value,
    scope,
    polySuffix,
    sourceLeaf,
    companion = undefined,
  ) {
    if (value === undefined && companion == null) return;
    const tctx = scope.get(tgtSpec.context);
    if (tctx == null) {
      onWarning?.(`writeTarget: target context "${tgtSpec.context}" not in scope`);
      return;
    }

    if (!tgtSpec.path) {
      if (isObject(value)) Object.assign(tctx, value);
      else onWarning?.(`writeTarget: cannot assign non-object value to bare context "${tgtSpec.context}"`);
      return;
    }

    let path = tgtSpec.path;
    const segs       = path.split('.');
    const targetLeaf = segs[segs.length - 1];
    const targetAbsPath = composeChildPath(tctx, path);
    const allowedTargetTypes = targetAbsPath
      ? targetPolyTypes(targetAbsPath)
      : null;
    const tgtIsPolyByPath = allowedTargetTypes != null;

    if (polySuffix) {
      // Append the suffix only when the TARGET leaf is polymorphic in the
      // target version (see resolveWritePath). A matching leaf name alone is
      // not sufficient; fall back to the leaf-name heuristic only when no
      // target poly metadata is available.
      const sameLeaf = sourceLeaf && targetLeaf === sourceLeaf;
      if (tgtIsPolyByPath || (!hasTgtPolyInfo && sameLeaf)) {
        segs[segs.length - 1] = targetLeaf + polySuffix;
        path = segs.join('.');
      }
      // Else: source carries a polymorphic suffix but the target leaf
      // isn't polymorphic in the target version; write to the bare path.
    } else if (tgtIsPolyByPath) {
      // JS-type fallback for unambiguous primitives. Validate against
      // the absolute target path's allowed variants (when known) so we
      // don't fire on paths that merely share a leaf name with an
      // unrelated poly field elsewhere.
      const inferred = inferPolySuffixFromValue(value);
      if (inferred) {
        const allowed = allowedTargetTypes;
        const inferredType = inferred.toLowerCase();  // "Boolean" -> "boolean"
        if (!allowed || allowed.includes(inferredType)) {
          segs[segs.length - 1] = targetLeaf + inferred;
          path = segs.join('.');
        }
      }
    }

    const { parent, key } = ensurePath(tctx, path);
    writeToSlot(parent, key, value, composeChildPath(tctx, path), companion);
  }

  /**
   * Execute a group with `paramValues` bound positionally to its declared
   * parameters.
   *
   * Order of operations:
   *   1. If `groupName` resolves to a built-in base type, run that copier
   *      and return.
   *   2. If the group `extends` another type, run that base/group's copier
   *      first (so derived rules can override inherited fields).
   *   3. Create a fresh scope chained to `parentScope`, bind each parameter,
   *      then execute every rule in declaration order.
   *
   * @param {string}   groupName
   * @param {Array}    paramValues  Values bound positionally to group params.
   * @param {Scope|null} [parentScope]
   * @throws {Error} If `groupName` is unknown and not a base type.
   */
  function execGroup(groupName, paramValues, parentScope = null) {
    const g = groups.get(groupName);

    if (!g) {
      if (BASE_COPIERS[groupName]) {
        const [src, tgt] = paramValues;
        if (!isObject(src) || !isObject(tgt)) {
          onWarning?.(`Built-in group "${groupName}" called with non-object args; skipping`);
          return;
        }
        BASE_COPIERS[groupName](src, tgt);
        return;
      }
      throw new Error(`Unknown group: "${groupName}"`);
    }

    if (paramValues.length !== g.params.length) {
      onWarning?.(`Group "${groupName}" called with ${paramValues.length} arg(s), expected ${g.params.length}`);
    }

    // Wrap primitive source args: FML primitive-conversion groups assume
    // the FHIR "expanded primitive" form `{value, id, extension}`, but in
    // JSON FHIR a primitive's value is the value itself (extensions live
    // in a sibling `_field`). When a source param is bound to a JS
    // primitive, wrap it so the group's rules like `src.value -> tgt.X`
    // can read the underlying value. Object sources pass through.
    const boundValues = paramValues.map((v, i) => {
      const p = g.params[i];
      if (p?.mode === 'source' && v != null && typeof v !== 'object') {
        return { value: v };
      }
      return v;
    });

    // Run extends-base copier first (for inheritance chains).
    if (g.extendsType) {
      const srcObj = boundValues[0];
      const tgtObj = boundValues[1];
      if (BASE_COPIERS[g.extendsType]) {
        if (isObject(srcObj) && isObject(tgtObj)) {
          BASE_COPIERS[g.extendsType](srcObj, tgtObj);
        } else {
          onWarning?.(`Group "${groupName}" extends ${g.extendsType} but src/tgt are not both objects; skipping base copy`);
        }
      } else if (groups.has(g.extendsType)) {
        execGroup(g.extendsType, boundValues, parentScope);
      } else {
        onWarning?.(`Group "${groupName}" extends unknown type "${g.extendsType}"`);
      }
    }

    const scope = parentScope ? parentScope.child() : new Scope();
    for (let i = 0; i < g.params.length; i++) {
      scope.set(g.params[i].alias, boundValues[i]);
    }

    for (const rule of g.rules) execRule(rule, scope);
  }

  /**
   * Resolve the args of a `then GroupName(arg1, arg2)` invocation against
   * the calling scope, producing the positional param values to pass.
   *
   * If the invocation has no args, returns `fallback` (typically
   * `[primaryValue, newTargetChild]`: the default "source item, fresh
   * target object" convention).
   *
   * Primitive source bindings with companions are expanded before being passed
   * so the called group's Element rules can see their id/extension.
   *
   * Missing args warn and are passed as `undefined`; the called group will also
   * warn (e.g. base-copier non-object check).
   *
   * @param {Object} invocation Parsed group invocation.
   * @param {Scope} scope Calling scope.
   * @param {Array} fallback Values used when the invocation has no arguments.
   * @param {Object[]} [bindings] Source bindings with primitive provenance.
   * @returns {Array} Resolved positional arguments.
   */
  function resolveInvocationArgs(invocation, scope, fallback, bindings = []) {
    if (!invocation.args || invocation.args.length === 0) return fallback;
    const out = [];
    for (const name of invocation.args) {
      if (!scope.has(name)) {
        onWarning?.(`Group invocation "${invocation.name}": arg "${name}" not in scope`);
        out.push(undefined);
      } else {
        const primitiveBinding = bindings.find(
          binding => binding.spec.alias === name && binding.companion != null,
        );
        if (primitiveBinding) {
          out.push(expandPrimitive(scope.get(name), primitiveBinding.companion));
        } else {
          out.push(scope.get(name));
        }
      }
    }
    return out;
  }

  /**
   * Execute one rule against the current scope. Resolves all sources, then
   * dispatches to either `execArrayRule` (when the primary source is an
   * array AND we have something to iterate with) or `execScalarRule`.
   *
   * Per FML semantics, the rule is skipped if any source is absent. A FHIR
   * primitive with only a `_field` companion is present even though its bare
   * value is undefined.
   */
  function execRule(rule, scope) {
    // No-op rules (source-only lines like `src.field;`) are skipped.
    if (rule.noop) return;

    const { sources } = rule;

    // Resolve every source clause. Bail out (silently) if any is absent.
    const bindings = [];
    for (const srcSpec of sources) {
      const {
        ctx,
        value,
        companion,
        present,
        polyName,
        polySuffix,
        sourceLeaf,
      } = readSource(srcSpec, scope, rule.trailingString);
      if (ctx == null)   return;
      if (!present) return;
      bindings.push({
        spec: srcSpec,
        ctx,
        value,
        companion,
        polyName,
        polySuffix,
        sourceLeaf,
      });
    }

    const primary = bindings[0];
    let primaryValue = primary.value;
    let primaryCompanion = primary.companion;

    // Apply list-mode filter to the primary source (first/last/etc.).
    if (Array.isArray(primaryValue) && primary.spec.listMode) {
      switch (primary.spec.listMode) {
        case 'first': {
          const companionCount = Array.isArray(primaryCompanion)
            ? primaryCompanion.length
            : 0;
          if (Math.max(primaryValue.length, companionCount) === 0) return;
          primaryValue = primaryValue[0];
          if (Array.isArray(primaryCompanion)) primaryCompanion = primaryCompanion[0];
          break;
        }
        case 'last': {
          const companionCount = Array.isArray(primaryCompanion)
            ? primaryCompanion.length
            : 0;
          if (Math.max(primaryValue.length, companionCount) === 0) return;
          primaryValue = primaryValue.at(-1);
          if (Array.isArray(primaryCompanion)) primaryCompanion = primaryCompanion.at(-1);
          break;
        }
        case 'not_first':
          primaryValue = primaryValue.slice(1);
          if (Array.isArray(primaryCompanion)) {
            primaryCompanion = primaryCompanion.slice(1);
          }
          break;
        case 'not_last':
          primaryValue = primaryValue.slice(0, -1);
          if (Array.isArray(primaryCompanion)) {
            primaryCompanion = primaryCompanion.slice(0, -1);
          }
          break;
        // `only_one` asserts the source list holds exactly one item and
        // collapses it to that single element. Per FML semantics more than
        // one item is an error condition; we warn and keep the first so the
        // rule still produces the single value the map author expects.
        case 'only_one': {
          const companionCount = Array.isArray(primaryCompanion)
            ? primaryCompanion.length
            : 0;
          const itemCount = Math.max(primaryValue.length, companionCount);
          if (itemCount === 0) return;
          if (itemCount > 1) {
            onWarning?.(`only_one: source "${primary.spec.context}${primary.spec.path ? '.' + primary.spec.path : ''}" has ${itemCount} items; using the first`);
          }
          primaryValue = primaryValue[0];
          if (Array.isArray(primaryCompanion)) primaryCompanion = primaryCompanion[0];
          break;
        }
      }
    }

    // Iterate only when there's something to iterate over (alias, then-clause).
    const isArray        = Array.isArray(primaryValue);
    const needsIteration = isArray && (primary.spec.alias || rule.thenGroup || rule.thenRules);

    if (needsIteration) {
      execArrayRule(rule, primary, primaryValue, primaryCompanion, bindings, scope);
    } else {
      const scalarPrimary = {
        ...primary,
        value: primaryValue,
        companion: primaryCompanion,
      };
      const scalarBindings = [
        scalarPrimary,
        ...bindings.slice(1),
      ];
      execScalarRule(rule, scalarPrimary, primaryValue, scalarBindings, scope);
    }

    onRuleExec?.({ rule, srcVal: primary.value });
  }

  /**
   * Compute the polymorphic-aware write path for a target slot in a
   * then-clause. Mirrors the suffix logic in `writeTarget`: if the matched
   * source binding carries a polymorphic suffix AND the target leaf either
   * equals the source leaf or is itself polymorphic in the target version,
   * append the suffix to the target leaf.
   *
   * Returns the (possibly rewritten) path. If the input path is null/empty,
   * returns it unchanged.
   *
   * @param {Target} tgtSpec   The target clause.
   * @param {Object} primary   The primary source binding.
   * @param {Array}  bindings  All source bindings (for alias matching).
   * @param {Object} tctx      Target context used to compose the schema path.
   * @returns {string|null}
   */
  function resolveWritePath(tgtSpec, primary, bindings, tctx) {
    if (!tgtSpec.path) return tgtSpec.path;

    let polySuffix = null, sourceLeaf = null;
    // If target has an alias and that alias matches a source binding,
    // use that source's polymorphic info. Otherwise (target-only alias
    // like `create('X') as vt`, or no alias) fall back to the primary
    // source's polymorphic info.
    let matched = false;
    if (tgtSpec.alias) {
      const m = bindings.find(b => b.spec.alias === tgtSpec.alias);
      if (m) { polySuffix = m.polySuffix; sourceLeaf = m.sourceLeaf; matched = true; }
    }
    if (!matched) {
      polySuffix = primary.polySuffix;
      sourceLeaf = primary.sourceLeaf;
    }
    if (!polySuffix) return tgtSpec.path;

    const segs       = tgtSpec.path.split('.');
    const targetLeaf = segs[segs.length - 1];
    const targetAbsPath = composeChildPath(tctx, tgtSpec.path);
    const tgtIsPoly = targetAbsPath
      ? tgtPolyTypeLists.has(targetAbsPath)
      : false;
    // Append the source's polymorphic suffix only when the TARGET leaf is
    // itself polymorphic in the target version. A matching leaf name alone is
    // not enough: a fixed target field that merely shares its name with a
    // polymorphic source (e.g. R4 GuidanceResponse.module[x] -> R3 fixed
    // GuidanceResponse.module) must keep its bare path. Without target poly
    // metadata (defs-less unit tests) fall back to the leaf-name heuristic.
    const sameLeaf = sourceLeaf && targetLeaf === sourceLeaf;
    if (tgtIsPoly || (!hasTgtPolyInfo && sameLeaf)) {
      segs[segs.length - 1] = targetLeaf + polySuffix;
      return segs.join('.');
    }
    return tgtSpec.path;
  }

  /**
   * Apply one intermediate target clause of a multi-target `then` rule.
   *
   * A rule like
   *   `src.X as s -> tgt.A as t, t.B as tc then Group(s, tc);`
   * has a primary target (`tgt.A as t`, handled by the caller) followed by
   * one or more intermediate targets (`t.B as tc`) that build nested
   * structure and bind aliases the `then`-clause depends on. Historically
   * only the primary target was processed, leaving intermediate aliases
   * (`tc`) unbound so the `then` group ran with `undefined` arguments.
   *
   * This helper handles the three intermediate-target shapes seen in the
   * cross-version maps:
   *   - `t.B as tc`                      -> create a fresh child under
   *                                         `t.B`, bind `tc` to it.
   *   - `ucc.system = 'http://...'`      -> evaluate the transform and
   *                                         write it into `ucc.system`.
   *   - `create('boolean') as firstV`    -> evaluate the bare transform and
   *                                         bind `firstV` (no write; the
   *                                         value only feeds the group).
   *
   * The alias is bound to the *same* object reference that is written into
   * the target tree (including array pushes), so a `then` group that fills
   * the bound alias mutates the in-tree object.
   *
   * @param {Target} tgtSpec  An intermediate target clause.
   * @param {Scope}  scope    The rule/iteration scope (mutated: aliases bound).
   * @param {string|null} [writePath=tgtSpec.path] Resolved target write path.
   * @returns {*} The value produced and optionally bound by this target.
   */
  function applyIntermediateTarget(tgtSpec, scope, writePath = tgtSpec.path) {
    // Determine the value this clause contributes.
    let value;
    if (tgtSpec.transform) {
      value = evalTransform(tgtSpec.transform, scope);
    } else if (tgtSpec.fhirpathExpr) {
      // Parenthesized FHIRPath intermediate target, e.g.
      //   `(vs.system.resolve()) as cs then codeSystem(cs, vt)`.
      value = evalFhirpath(tgtSpec.fhirpathExpr, scope, 'intermediate-target');
    } else if (tgtSpec.path) {
      value = {}; // fresh nested container to be filled by the then-clause
    } else {
      value = undefined;
    }

    // Write into context.path when both are present (skip bare-transform
    // targets like `create('boolean') as firstV`, whose context is null).
    if (tgtSpec.context && writePath) {
      const tctx = scope.get(tgtSpec.context);
      if (tctx == null) {
        onWarning?.(`Intermediate target: context "${tgtSpec.context}" not in scope`);
      } else {
        const absPath = composeChildPath(tctx, writePath);
        if (isObject(value)) setObjectPath(value, absPath);
        const { parent, key } = ensurePath(tctx, writePath);
        writeToSlot(parent, key, value, absPath);
      }
    }

    if (tgtSpec.alias && value !== undefined) {
      scope.set(tgtSpec.alias, value);
    }

    return value;
  }

  /**
   * Modes already emitted, so we warn at most once per mode per conversion
   * (array rules would otherwise warn once per iterated item).
   * @type {Set<string>}
   */
  const _listModeWarned = new Set();

  /**
   * Warn (once per mode) when a target carries a list mode. Target list modes
   * are parsed, but their ordering, sharing, and collation semantics are not
   * yet faithfully implemented. The provisional fallback appends every
   * produced value in ordinary rule-execution order so it does not invent
   * sharing relationships or silently discard source occurrences.
   * The only known bundled case is HealthcareService R3 -> R2, where the
   * fallback may create a serviceType without its required type for each
   * specialty.
   *
   * @param {Target} tgtSpec
   */
  function warnProvisionalTargetListMode(tgtSpec) {
    const m = tgtSpec?.listMode;
    if (!m || _listModeWarned.has(m)) return;
    _listModeWarned.add(m);

    let detail = 'provisional fallback appends every produced value; target ordering is not honored';
    if (m === 'single' || m === 'share') {
      detail = 'provisional fallback appends every produced value; target ordering and instance sharing are not honored';
    } else if (m === 'collate') {
      detail = 'provisional fallback appends every produced value; target ordering and collation are not honored';
    }

    if (m === 'single') {
      detail += '; produced values are not truncated; output may exceed target cardinality';
    }

    onWarning?.(`target list mode "${m}" is parsed but not faithfully implemented; ${detail}`);
  }

  /**
   * Evaluate a source `log (...)` clause and emit its value as an info-level
   * diagnostic. Per the FML spec `log` is purely diagnostic: it produces a
   * message and has no effect on the transformation output. A no-op when no
   * `onInfo` sink is wired, so it costs nothing in production paths.
   *
   * @param {GuardExpr} logExpr  Parsed `log` expression (fhirpath or dot-path).
   * @param {Scope}     scope    Current rule/iteration scope.
   */
  function emitLog(logExpr, scope) {
    if (!logExpr || !onInfo) return;
    let val;
    if (logExpr.fhirpath) {
      val = evalFhirpath(logExpr.fhirpath, scope, 'log');
    } else if (logExpr.left) {
      const segs = logExpr.left.split('.');
      const head = segs[0];
      if (scope.has(head)) {
        const base = scope.get(head);
        val = segs.length > 1 ? getPath(base, segs.slice(1).join('.')) : base;
      } else if (scope.has('$this')) {
        val = getPath(scope.get('$this'), logExpr.left);
      }
    }
    const text = (val !== null && typeof val === 'object') ? JSON.stringify(val) : String(val);
    onInfo(`log: ${text}`);
  }

  /**
   * Return whether a primitive `then` rule is the standard identity-wrapper
   * idiom that can be serialized directly without executing its group.
   *
   * The shortcut is deliberately narrow: the target must create a FHIR
   * primitive, and the invoked `<<type+>>` group must have that same primitive
   * name. All other named groups execute normally because they may perform a
   * structural conversion or custom transformation.
   *
   * @param {Target} tgtSpec Primary target clause.
   * @param {Object|null} thenGroup Parsed group invocation.
   * @returns {boolean}
   */
  function isPrimitiveIdentityWrapper(tgtSpec, thenGroup) {
    if (!thenGroup || tgtSpec.transform?.fn !== 'create') return false;
    const primitiveType = tgtSpec.transform.args?.[0]?.value;
    if (!FHIR_PRIMITIVES.has(primitiveType) || thenGroup.name !== primitiveType) {
      return false;
    }
    return groups.get(thenGroup.name)?.annotations?.includes('type+') === true;
  }

  /**
   * Apply a rule to a single (non-iterated) source value.
   *
   * Three sub-modes, in priority order:
   *   1. `then GroupName(args)` - invoke a group on the source object.
   *   2. `then { rules }`       - execute inline sub-rules with the source
   *                               and a fresh target child in scope.
   *   3. Plain assignment       - apply each target's transform / implicit
   *                               copy, writing into the parent target.
   *
   * Inline then-rules on non-object source values warn and skip. Named
   * primitive groups are supported by expanding JSON primitives first.
   */
  function execScalarRule(rule, primary, primaryValue, bindings, scope) {
    const { targets, thenGroup, thenRules } = rule;

    // Build a rule-local scope binding all source aliases to their values.
    const ruleScope = scope.child();
    // Bind $this to the primary source value so FHIRPath guards and
    // transforms whose head is a field of the source (e.g.
    // `where (system='X')`) have an iteration-context-like root even
    // outside array iteration.
    ruleScope.set('$this', primaryValue);
    for (const b of bindings) {
      if (b.spec.alias) ruleScope.set(b.spec.alias, b.value);
    }

    if (!evalGuard(primary.spec.where, ruleScope)) return;
    if (primary.spec.check && !evalGuard(primary.spec.check, ruleScope)) {
      onWarning?.(`check failed (${primary.spec.alias || primary.spec.path})`);
    }
    if (primary.spec.log) emitLog(primary.spec.log, ruleScope);

    for (const target of targets) {
      warnProvisionalTargetListMode(target);
    }

    if (thenGroup || thenRules) {
      // Category 3: source-level then without targets (e.g. `src.field as v then Group(v, tgt)`)
      if (targets.length === 0) {
        if (thenGroup) {
          // execGroup() wraps primitive source args as {value: <prim>},
          // so we can dispatch even when primaryValue is a JS primitive
          // (e.g. a Reference's `reference` URL string being handed off
          // to a uri-conversion group).
          const fallbackSource = primary.companion != null
            ? expandPrimitive(primaryValue, primary.companion)
            : primaryValue;
          const argValues = resolveInvocationArgs(
            thenGroup,
            ruleScope,
            [fallbackSource],
            bindings,
          );
          execGroup(thenGroup.name, argValues, ruleScope);
        } else if (thenRules) {
          if (!isObject(primaryValue)) {
            onWarning?.(`then-clause inline rules invoked on non-object source value (type=${typeof primaryValue}); skipping`);
            return;
          }
          const subScope = ruleScope.child();
          for (const sr of thenRules) execRule(sr, subScope);
        }
        return;
      }

      const tgtSpec = targets[0];
      const tctx    = ruleScope.get(tgtSpec.context);
      if (tctx == null) {
        onWarning?.(`then-clause: target context "${tgtSpec.context}" not in scope`);
        return;
      }

      // Resolve target write path, honoring polymorphic suffix derived
      // from the source binding (so `tgt.answer = create('Coding') as vt
      // then Coding(vs, vt) "answerCoding"` writes to `tgt.answerCoding`
      // rather than `tgt.answer`).
      const writePath = resolveWritePath(tgtSpec, primary, bindings, tctx);

      // A transformed primary in a multi-target rule is an ordinary target
      // assignment, not the child object filled by the then-clause. Evaluate
      // and write it first, bind every remaining target, then invoke the
      // clause with those real values. This covers rules such as
      // `tgt.example = true, tgt.exampleFor as ref then Group(src, ref)`.
      if (targets.length > 1 && tgtSpec.transform) {
        const primaryTargetValue = applyIntermediateTarget(
          tgtSpec,
          ruleScope,
          writePath,
        );
        for (let i = 1; i < targets.length; i++) {
          applyIntermediateTarget(targets[i], ruleScope);
        }

        if (thenGroup) {
          const fallbackSource = primary.companion != null
            ? expandPrimitive(primaryValue, primary.companion)
            : primaryValue;
          const argValues = resolveInvocationArgs(
            thenGroup,
            ruleScope,
            [fallbackSource, primaryTargetValue],
            bindings,
          );
          execGroup(thenGroup.name, argValues, ruleScope);
        } else {
          const subScope = ruleScope.child();
          for (const sr of thenRules) execRule(sr, subScope);
        }
        return;
      }

      // Primitive source: the FML idiom
      //   `tgt.X = create('primType') as vt then primType(vs, vt) "polyName"`
      // is a primitive copy. The `create(...) as vt then primType(vs, vt)`
      // wrapper does not add value when the source is a raw JS primitive with
      // no Element metadata, so retain the existing direct-write shortcut in
      // that case. When a companion exists, invoke the group with the expanded
      // primitive so its Element rules can copy id/extension.
      //
      // Apply this optimization only to the exact identity-wrapper shape.
      // Every other named group must execute faithfully.
      const isIdentityWrapper = isPrimitiveIdentityWrapper(tgtSpec, thenGroup);
      if (targets.length === 1 &&
          !isObject(primaryValue) && primary.companion == null &&
          isIdentityWrapper) {
        if (writePath) {
          const { parent, key } = ensurePath(tctx, writePath);
          writeToSlot(parent, key, primaryValue, composeChildPath(tctx, writePath));
        } else {
          onWarning?.(`then-clause: cannot assign primitive source to bare context "${tgtSpec.context}"`);
        }
        return;
      }

      // Target list modes currently use the same provisional append fallback:
      // build a fresh child for every rule execution and preserve it.
      const child = tgtSpec.transform?.fn === 'create'
        ? evalTransform(tgtSpec.transform, ruleScope)
        : {};
      // Record the child's absolute FHIR path so deeper writes (and the
      // final slot write below) can consult target-version cardinality.
      setObjectPath(child, composeChildPath(tctx, writePath));
      if (tgtSpec.alias) ruleScope.set(tgtSpec.alias, child);

      // Multi-target then-rule: intermediate targets (targets[1..]) build
      // nested structure and bind aliases the then-clause relies on
      // (e.g. `tgt.A as t, t.B as tc then Group(s, tc)`). Apply them
      // before running the then-clause so their aliases are in scope.
      for (let i = 1; i < targets.length; i++) {
        applyIntermediateTarget(targets[i], ruleScope);
      }

      if (thenGroup) {
        const fallbackSource = primary.companion != null
          ? expandPrimitive(primaryValue, primary.companion)
          : primaryValue;
        const argValues = resolveInvocationArgs(
          thenGroup,
          ruleScope,
          [fallbackSource, child],
          bindings,
        );
        execGroup(thenGroup.name, argValues, ruleScope);
      } else {
        // Inline `then { ... }`: shadow the parent's target context with
        // the fresh child so sub-rules write into it.
        const subScope = ruleScope.child();
        subScope.set(tgtSpec.context, child);
        for (const sr of thenRules) execRule(sr, subScope);
      }

      if (writePath) {
        const { parent, key } = ensurePath(tctx, writePath);
        writeToSlot(parent, key, child, composeChildPath(tctx, writePath));
      } else {
        Object.assign(tctx, child);
      }
      return;
    }

    // Inline multi-target with target alias:
    //   `tgt.X as t, t.Y = ..., t.Z = ...`
    // is FML shorthand for
    //   `tgt.X as t then { t.Y = ...; t.Z = ...; }`
    // The engine's then-clause path (above) handles the latter; for the
    // inline form we lift: create a child object, bind the alias, execute
    // any subsequent targets that write into the alias, then assign the
    // child to the first target's path.
    if (targets.length > 1 && targets[0].alias) {
      const aliasName     = targets[0].alias;
      const subsRefsAlias = targets.slice(1).some(t => t.context === aliasName);
      if (subsRefsAlias) {
        const firstTgt = targets[0];
        const tctx     = ruleScope.get(firstTgt.context);
        if (tctx == null) {
          onWarning?.(`Inline multi-target: context "${firstTgt.context}" not in scope`);
          return;
        }
        const child      = {};
        // Record the child's absolute FHIR path so writes into it know
        // their own absolute paths (needed for cardinality decisions).
        setObjectPath(child, composeChildPath(tctx, firstTgt.path));
        const childScope = ruleScope.child();
        childScope.set(aliasName, child);

        // Run each subsequent target; those whose context is the alias
        // write into the child, others write into their own scope context.
        for (let i = 1; i < targets.length; i++) {
          applyTarget(targets[i], primary, bindings, childScope);
        }

        if (firstTgt.path) {
          const { parent, key } = ensurePath(tctx, firstTgt.path);
          writeToSlot(parent, key, child, composeChildPath(tctx, firstTgt.path));
        } else {
          Object.assign(tctx, child);
        }
        return;
      }
    }

    for (const tgt of targets) applyTarget(tgt, primary, bindings, ruleScope);
  }

  /**
   * Apply a rule that iterates over an array primary source.
   *
   * For each item: build an iteration scope binding the alias, evaluate
   * `where`/`check` guards, then either invoke the then-clause (collecting
   * a child object per item) or compute a scalar target value per item.
   * Results are collected into an array and assigned to the target path.
   *
   * If zero items pass the guard, no assignment is made (the target field
   * is left absent rather than set to an empty array, matching FHIR's
   * "absent = unknown" semantics).
   */
  function execArrayRule(rule, primary, items, itemCompanions, bindings, scope) {
    const { targets, thenGroup, thenRules } = rule;

    // Category 3: source-level then without targets in array context
    if (targets.length === 0) {
      for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
        const item = items[itemIndex];
        const itemCompanion = Array.isArray(itemCompanions)
          ? itemCompanions[itemIndex]
          : undefined;
        const iterationPrimary = {
          ...primary,
          value: item,
          companion: itemCompanion,
        };
        const iterationBindings = [
          iterationPrimary,
          ...bindings.slice(1),
        ];
        const iterScope = scope.child();
        iterScope.set('$this', item); // Bind iteration context for unqualified guard references
        if (primary.spec.alias) iterScope.set(primary.spec.alias, item);
        for (let i = 1; i < bindings.length; i++) {
          const b = bindings[i];
          if (b.spec.alias) iterScope.set(b.spec.alias, b.value);
        }
        if (!evalGuard(primary.spec.where, iterScope)) continue;
        if (thenGroup) {
          const fallbackSource = itemCompanion != null
            ? expandPrimitive(item, itemCompanion)
            : item;
          const argValues = resolveInvocationArgs(
            thenGroup,
            iterScope,
            [fallbackSource],
            iterationBindings,
          );
          execGroup(thenGroup.name, argValues, iterScope);
        } else if (thenRules) {
          if (!isObject(item)) continue;
          const subScope = iterScope.child();
          for (const sr of thenRules) execRule(sr, subScope);
        }
      }
      return;
    }

    const tgtSpec = targets[0];
    const tctx    = scope.get(tgtSpec.context);
    if (tctx == null) {
      onWarning?.(`Array rule: target context "${tgtSpec.context}" not in scope`);
      return;
    }

    for (const target of targets) {
      warnProvisionalTargetListMode(target);
    }

    const results = [];
    const resultCompanions = [];
    let defaultPolySuffix = null;
    const inlineTargetAlias = !thenGroup && !thenRules &&
      targets.length > 1 && tgtSpec.alias &&
      targets.slice(1).some(target => target.context === tgtSpec.alias)
      ? tgtSpec.alias
      : null;
    for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
      const item = items[itemIndex];
      const itemCompanion = Array.isArray(itemCompanions)
        ? itemCompanions[itemIndex]
        : undefined;
      const iterationPrimary = {
        ...primary,
        value: item,
        companion: itemCompanion,
      };
      const iterationBindings = [
        iterationPrimary,
        ...bindings.slice(1),
      ];
      const iterScope = scope.child();
      iterScope.set('$this', item); // Bind iteration context for unqualified guard references
      if (primary.spec.alias) iterScope.set(primary.spec.alias, item);
      // Also bind any non-primary source aliases (multi-source rules).
      for (let i = 1; i < bindings.length; i++) {
        const b = bindings[i];
        if (b.spec.alias) iterScope.set(b.spec.alias, b.value);
      }

      if (!evalGuard(primary.spec.where, iterScope)) continue;
      if (primary.spec.check && !evalGuard(primary.spec.check, iterScope)) {
        onWarning?.(`check failed in iteration (${primary.spec.alias})`);
      }
      if (primary.spec.log) emitLog(primary.spec.log, iterScope);

      // Array counterpart of scalar inline-target lifting:
      //   src.items as s -> tgt.parts as p, p.value = s
      // creates and fills one aliased child per source item.
      if (inlineTargetAlias) {
        const writePath = resolveWritePath(
          tgtSpec,
          iterationPrimary,
          iterationBindings,
          tctx,
        );
        const child = tgtSpec.transform?.fn === 'create'
          ? evalTransform(tgtSpec.transform, iterScope)
          : {};
        setObjectPath(child, composeChildPath(tctx, writePath));

        const childScope = iterScope.child();
        childScope.set(inlineTargetAlias, child);
        for (let i = 1; i < targets.length; i++) {
          applyTarget(targets[i], iterationPrimary, iterationBindings, childScope);
        }

        results.push(child);
        resultCompanions.push(null);
        continue;
      }

      if (thenGroup || thenRules) {
        if (thenRules && !isObject(item)) {
          onWarning?.(`Array iteration: then-clause on non-object item (type=${typeof item}); skipping element`);
          continue;
        }

        // A transformed primary in a multi-target array rule is an ordinary
        // per-iteration assignment (e.g. `tgt.flag = true, tgt.out as o then
        // G`), not the child object filled by the then-clause. Mirror
        // execScalarRule: write it, bind the remaining targets, then run the
        // clause. `create(...)` transforms build the then-container itself and
        // are handled by the child path below, so they are excluded here.
        if (targets.length > 1 && tgtSpec.transform && tgtSpec.transform.fn !== 'create') {
          const transformWritePath = resolveWritePath(
            tgtSpec,
            iterationPrimary,
            iterationBindings,
            tctx,
          );
          const primaryTargetValue = applyIntermediateTarget(tgtSpec, iterScope, transformWritePath);
          for (let i = 1; i < targets.length; i++) {
            applyIntermediateTarget(targets[i], iterScope);
          }
          if (thenGroup) {
            const fallbackSource = itemCompanion != null
              ? expandPrimitive(item, itemCompanion)
              : item;
            const argValues = resolveInvocationArgs(
              thenGroup,
              iterScope,
              [fallbackSource, primaryTargetValue],
              iterationBindings,
            );
            execGroup(thenGroup.name, argValues, iterScope);
          } else {
            const subScope = iterScope.child();
            for (const sr of thenRules) execRule(sr, subScope);
          }
          continue;
        }

        const child = tgtSpec.transform?.fn === 'create'
          ? evalTransform(tgtSpec.transform, iterScope)
          : {};
        // Record the child's absolute FHIR path so writes into it (and
        // any group invoked on it) can consult target-version cardinality.
        // FHIR paths are array-blind: an item at index i still has the
        // parent path (no [i] segment).
        const writePath = resolveWritePath(
          tgtSpec,
          iterationPrimary,
          iterationBindings,
          tctx,
        );
        setObjectPath(child, composeChildPath(tctx, writePath));
        if (tgtSpec.alias) iterScope.set(tgtSpec.alias, child);

        // Multi-target then-rule (array context): apply intermediate
        // targets (targets[1..]) so their aliases are bound before the
        // then-clause runs, mirroring execScalarRule.
        for (let i = 1; i < targets.length; i++) {
          applyIntermediateTarget(targets[i], iterScope);
        }

        if (thenGroup) {
          const fallbackSource = itemCompanion != null
            ? expandPrimitive(item, itemCompanion)
            : item;
          const argValues = resolveInvocationArgs(
            thenGroup,
            iterScope,
            [fallbackSource, child],
            iterationBindings,
          );
          execGroup(thenGroup.name, argValues, iterScope);
        } else {
          const subScope = iterScope.child();
          subScope.set(tgtSpec.context, child);
          for (const sr of thenRules) execRule(sr, subScope);
        }
        results.push(child);
        resultCompanions.push(null);
      } else {
        // No then-clause: each iteration produces one value. Apply the
        // applicable default group just as applyTarget() does for a scalar
        // rule; an alias should affect scope, not dispatch semantics.
        const defaultResult = tryDefaultGroup(tgtSpec, iterationPrimary, iterScope);
        const value = defaultResult !== undefined
          ? defaultResult.value
          : computeTargetValue(
            tgtSpec,
            iterationPrimary,
            iterationBindings,
            iterScope,
            item,
          );
        if (defaultResult?.polySuffix) defaultPolySuffix = defaultResult.polySuffix;
        const provenance = defaultResult === undefined
          ? targetSourceBinding(
            tgtSpec,
            iterationPrimary,
            iterationBindings,
          )
          : null;
        const resultCompanion = provenance?.companion;
        if (value !== undefined || resultCompanion != null) {
          results.push(value);
          resultCompanions.push(resultCompanion ?? null);
        }
      }
    }

    if (results.length === 0) return;
    let targetPath = resolveWritePath(tgtSpec, primary, bindings, tctx);
    if (defaultPolySuffix && tgtSpec.path && targetPolyTypes(
      composeChildPath(tctx, tgtSpec.path),
    )) {
      const segs = tgtSpec.path.split('.');
      segs[segs.length - 1] += defaultPolySuffix;
      targetPath = segs.join('.');
    }
    if (!targetPath) {
      onWarning?.(`Array rule: no target path; cannot write ${results.length} item(s)`);
      return;
    }
    const { parent, key } = ensurePath(tctx, targetPath);
    // Route through writeToSlot for consistency with the rest of the
    // write paths: it preserves the array contents on a fresh slot and
    // concatenates into an existing array when two rules feed the same
    // target field.
    writeToSlot(
      parent,
      key,
      results,
      composeChildPath(tctx, targetPath),
      resultCompanions,
    );
  }

  /** Return whether a value is a nested FHIR resource instance. */
  function isResourceInstance(value) {
    return isObject(value) && typeof value.resourceType === 'string';
  }

  /**
   * Resolve the source type represented by one rule binding.
   *
   * @param {Object} primary Source binding.
   * @param {string} srcAbsPath Absolute source path.
   * @returns {string|null} Canonical FHIR type code.
   */
  function sourceBindingType(primary, srcAbsPath) {
    if (primary.spec.typeHint) return primary.spec.typeHint;

    const fixedType = sourceElementType(srcAbsPath);
    if (fixedType) return fixedType;

    const choices = sourcePolyTypes(srcAbsPath);
    if (!choices || !primary.polySuffix) return null;
    return choices.find(type => cap(type) === primary.polySuffix) || null;
  }

  /**
   * Attempt FML default-group dispatch for an implicit simple target.
   * Exact source/target pairs may use either `<<types>>` or `<<type+>>`;
   * polymorphic targets select a compatible `<<type+>>` group by source type.
   *
   * Nested resource instances deliberately remain plain copies until recursive
   * contained/Bundle conversion is supported by the public conversion pipeline.
   *
   * @param {Target} tgt The target clause being written to.
   * @param {Object} primary The primary source binding.
   * @param {Scope} scope The current rule scope.
   * @returns {{value: *, polySuffix: string|null}|undefined} Default-group
   *   output and optional polymorphic suffix, or undefined for plain copy.
   */
  function tryDefaultGroup(tgt, primary, scope) {
    if (defaultGroupsByPair.size === 0 && typePlusBySource.size === 0) return undefined;
    if (tgt.transform) return undefined;
    if (primary.value == null && primary.companion == null) return undefined;

    const sourceValues = Array.isArray(primary.value) ? primary.value : [primary.value];
    if (sourceValues.some(isResourceInstance)) return undefined;

    const srcCtx = scope.get(primary.spec.context);
    const tctx   = scope.get(tgt.context);
    if (srcCtx == null || tctx == null) return undefined;

    const srcAbsPath = primary.spec.path
      ? composeChildPath(srcCtx, primary.spec.path)
      : getObjectPath(srcCtx);
    const tgtAbsPath = tgt.path
      ? composeChildPath(tctx, tgt.path)
      : getObjectPath(tctx);
    if (!srcAbsPath || !tgtAbsPath) return undefined;

    const srcType = sourceBindingType(primary, srcAbsPath);
    const fixedTargetType = targetElementType(tgtAbsPath);
    const targetChoices = targetPolyTypes(tgtAbsPath);
    if (!srcType || (!fixedTargetType && !targetChoices)) return undefined;

    let groupName = null;
    let selectedTargetType = fixedTargetType;
    let polySuffix = null;

    if (fixedTargetType) {
      groupName = defaultGroupsByPair.get(`${srcType}::${fixedTargetType}`) || null;
    } else {
      const candidates = (typePlusBySource.get(srcType) || [])
        .filter(candidate => targetChoices.includes(candidate.targetType));
      if (candidates.length === 1) {
        groupName = candidates[0].groupName;
        selectedTargetType = candidates[0].targetType;
        polySuffix = cap(selectedTargetType);
      } else if (candidates.length > 1) {
        const ambiguityKey =
          `ambiguous:${srcType}:${srcAbsPath}->${tgtAbsPath}`;
        if (!reportedTypeMismatches.has(ambiguityKey)) {
          reportedTypeMismatches.add(ambiguityKey);
          onWarning?.(
            `ambiguous <<type+>> default for ${srcType} at ${srcAbsPath} -> ` +
            `${tgtAbsPath}: ${candidates.map(candidate => candidate.targetType).join(', ')}`,
          );
        }
        return undefined;
      }
    }

    if (!groupName) {
      if (fixedTargetType && srcType !== fixedTargetType) {
        const mismatchKey =
          `${srcType}->${fixedTargetType}:${srcAbsPath}->${tgtAbsPath}`;
        if (!reportedTypeMismatches.has(mismatchKey)) {
          reportedTypeMismatches.add(mismatchKey);
          onInfo?.(
            `type mismatch ${srcType}->${fixedTargetType} at ${srcAbsPath} -> ` +
            `${tgtAbsPath}; no default group, plain copy`,
          );
        }
      }
      return undefined;
    }

    const targetValuePath = polySuffix
      ? tgtAbsPath.replace(/([^.]+)$/, `$1${polySuffix}`)
      : tgtAbsPath;

    /**
     * Map one source value with its aligned primitive companion.
     *
     * @param {*} value One source field value.
     * @param {*} companion Primitive metadata aligned with the value.
     * @returns {Object} Expanded target value produced by the default group.
     */
    function mapValue(value, companion) {
      const wrapped = isObject(value)
        ? value
        : expandPrimitive(value, companion);
      const child = {};
      setObjectPath(child, targetValuePath);
      execGroup(groupName, [wrapped, child], scope);
      return child;
    }

    if (Array.isArray(primary.value)) {
      const companions = Array.isArray(primary.companion)
        ? primary.companion
        : [];
      return {
        value: primary.value.map((value, index) =>
          mapValue(value, companions[index])),
        polySuffix,
      };
    }

    // Keep primitive results expanded. writeToSlot() is the single
    // serialization boundary that splits {value, id, extension} into the
    // target field and `_field` companion.
    return {
      value: mapValue(primary.value, primary.companion),
      polySuffix,
    };
  }

  /**
   * Find the source binding whose primitive metadata belongs to a target.
   *
   * Implicit copies use the primary (or explicitly matched) binding. Explicit
   * transforms carry metadata only when they reference exactly one source
   * alias; literal/create transforms do not inherit unrelated metadata.
   *
   * @param {Target} tgt Target clause.
   * @param {Object} primary Primary source binding.
   * @param {Object[]} bindings All source bindings.
   * @returns {Object|null} Provenance binding.
   */
  function targetSourceBinding(tgt, primary, bindings) {
    if (!tgt.transform) {
      if (tgt.alias) {
        return bindings.find(binding => binding.spec.alias === tgt.alias) || primary;
      }
      return primary;
    }

    const transform = tgt.transform;
    if (transform.fn === 'literal' || transform.fn === 'create') return null;

    const referencedNames = [];
    if (transform.fn === 'varRef') {
      referencedNames.push(transform.args[0]);
    } else if (transform.fn === 'fhirpath') {
      const head = transform.args[0]?.match(FHIRPATH_HEAD_RE)?.[1];
      if (head) referencedNames.push(head);
    } else {
      for (const arg of transform.args) {
        if (arg?.kind === 'ident') referencedNames.push(arg.value);
      }
    }

    const referencedBindings = [...new Set(
      referencedNames
        .map(name => bindings.find(binding => binding.spec.alias === name))
        .filter(Boolean),
    )];
    return referencedBindings.length === 1 ? referencedBindings[0] : null;
  }

  /**
   * Apply one target clause within a scalar rule: compute the value, find
   * the right polymorphic suffix (if any), and write it.
   *
   * polySuffix/sourceLeaf selection, in priority order:
   *   1. Target has an alias matching a source binding -> inherit that
   *      source's polymorphic info (`src.X : Type as v -> tgt.Y = v`).
   *   2. Otherwise inherit from the primary source's polymorphic info.
   *   3. If still none AND the target leaf is polymorphic in the target
   *      FHIR version AND the source path has a known scalar type in
   *      `srcElementTypes` AND that type is one of the target poly
   *      field's allowed variants -> use cap(srcType) as the suffix.
   *      This is the FML-spec "auto-pick variant from value's type"
   *      behavior generalised via the element-type table, so strings
   *      and complex types (Coding/Reference/Quantity/...) get the
   *      right variant -- not just primitives.
   *   4. Failing all of the above, writeTarget itself falls back to a
   *      JS-type-based inference for unambiguous primitives (boolean,
   *      integer, decimal).
   *
   * writeTarget then decides whether the suffix is actually applied to
   * the target path (see writeTarget docs).
   */
  function applyTarget(tgt, primary, bindings, scope) {
    warnProvisionalTargetListMode(tgt);
    // FML simple rules invoke the applicable <<types>> / <<type+>> default
    // group instead of copying the source value directly.
    const defaultResult = tryDefaultGroup(tgt, primary, scope);
    if (defaultResult !== undefined) {
      writeTarget(tgt, defaultResult.value, scope, defaultResult.polySuffix, null);
      return;
    }

    const value = computeTargetValue(tgt, primary, bindings, scope, primary.value);
    const provenance = targetSourceBinding(tgt, primary, bindings);
    const companion = provenance?.companion;
    if (value === undefined && companion == null) return;

    let polySuffix = null, sourceLeaf = null;
    if (tgt.alias) {
      const m = bindings.find(b => b.spec.alias === tgt.alias);
      if (m) { polySuffix = m.polySuffix; sourceLeaf = m.sourceLeaf; }
    } else {
      polySuffix = primary.polySuffix;
      sourceLeaf = primary.sourceLeaf;
    }

    // Source-element-type fallback for polymorphic targets.
    // Only triggers when the absolute target path is confirmed
    // polymorphic in the target version (not just sharing a leaf name
    // with some unrelated poly field elsewhere -- e.g. `code` is a poly
    // leaf in `Composition.code[x]` but NOT in `Questionnaire.item.code`,
    // so we must check the full path, not the leaf alone).
    if (!polySuffix && tgt.path && primary.spec.path) {
      const tctx = scope.get(tgt.context);
      const tgtAbsPath = tctx ? composeChildPath(tctx, tgt.path) : null;
      const allowed = tgtAbsPath ? targetPolyTypes(tgtAbsPath) : null;
      if (allowed) {
        const srcCtx = scope.get(primary.spec.context);
        const srcAbsPath = srcCtx ? composeChildPath(srcCtx, primary.spec.path) : null;
        if (srcAbsPath) {
          const srcType = sourceElementType(srcAbsPath);
          if (srcType && allowed.includes(srcType)) {
            polySuffix = cap(srcType);
          }
        }
      }
    }

    writeTarget(tgt, value, scope, polySuffix, sourceLeaf, companion);
  }

  /**
   * Compute the value a single target clause should receive.
   *
   * Resolution order:
   *   1. Explicit `transform` on the target -> run it.
   *   2. Target has an alias that matches a source binding -> deep-clone
   *      that source's value (named-binding copy).
   *   3. Otherwise -> deep-clone `iterValue` (implicit copy from the
   *      primary source; in array iteration this is the current item).
   *
   * @param {Target} tgt
   * @param {Object} primary    The primary source binding.
   * @param {Array}  bindings   All source bindings (for alias matching).
   * @param {Scope}  scope      Current scope (for transform / varRef).
   * @param {*}      iterValue  Per-iteration source value (or primary.value).
   */
  function computeTargetValue(tgt, primary, bindings, scope, iterValue) {
    if (tgt.transform) return evalTransform(tgt.transform, scope);
    if (tgt.alias) {
      const match = bindings.find(b => b.spec.alias === tgt.alias);
      if (match) {
        const cloned = deepClone(match.value);
        // Preserve the source's absolute FHIR path on the clone so that
        // downstream default-group dispatch (which keys off srcElementTypes
        // via getObjectPath) keeps working after the value has been
        // cloned into a target slot.
        const srcPath = getObjectPath(match.value);
        if (srcPath) setObjectPath(cloned, srcPath);
        return cloned;
      }
    }
    const cloned = deepClone(iterValue);
    const srcPath = getObjectPath(iterValue);
    if (srcPath) setObjectPath(cloned, srcPath);
    return cloned;
  }

  /**
   * Convert a FHIR resource using the compiled mappings.
   *
   * @param {Object} opts
   * @param {Object} opts.input        Source FHIR resource (JSON).
   * @param {string} [opts.entryGroup] Group name to start execution at;
   *                                   defaults to `input.resourceType`.
   * @returns {{resource: Object, spinOffResources?: Object[]}} Conversion
   *   result containing the converted resource and any optional spin-offs.
   * @throws {Error} If `input` is not an object or has no `resourceType`
   *                 and `entryGroup` is not provided.
   */

  // --- meta.profile version helpers ---

  /**
   * Matches HL7 FHIR base StructureDefinition URLs in their two seen
   * forms:
   *   - numeric:  http://hl7.org/fhir/4.0/StructureDefinition/...
   *   - aliased:  http://hl7.org/fhir/stu3/StructureDefinition/...
   * The version segment captures both `[\d.]+` and the textual aliases
   * `stu3` and `dstu2` (older HL7 publications use those labels).
   */
  const FHIR_BASE_PROFILE_RE =
    /^http:\/\/hl7\.org\/fhir\/(?:[\d.]+|stu3|dstu2)\/StructureDefinition\/.+$/i;

  /** Version label -> FHIR version number used in profile URLs. */
  const VER_TO_FHIR = { R2: '1.0', R3: '3.0', R4: '4.0', R4B: '4.3', R5: '5.0' };

  /**
   * Source-version URL segment aliases that also identify a profile as
   * belonging to the source FHIR version. Lower-cased; matched case-
   * insensitively. Empty for versions with no known alias.
   */
  const VER_URL_ALIASES = { R2: ['dstu2'], R3: ['stu3'], R4: [], R4B: [], R5: [] };

  const srcVerNum = VER_TO_FHIR[fromVer];
  const tgtVerNum = VER_TO_FHIR[toVer];
  const srcVerAliases = (VER_URL_ALIASES[fromVer] || []).map(a => a.toLowerCase());

  function isSourceVersionProfile(url) {
    if (!srcVerNum) return false;
    if (url.includes(`/fhir/${srcVerNum}/StructureDefinition/`)) return true;
    const lc = url.toLowerCase();
    return srcVerAliases.some(a => lc.includes(`/fhir/${a}/structuredefinition/`));
  }

  function toTargetVersionProfile(url) {
    if (!tgtVerNum) return url;
    // Try the numeric source segment first; fall back to each known
    // alias (case-insensitive replace) so `stu3` / `dstu2` URLs are
    // rewritten to the target's numeric form.
    if (url.includes(`/fhir/${srcVerNum}/`)) {
      return url.replace(`/fhir/${srcVerNum}/`, `/fhir/${tgtVerNum}/`);
    }
    for (const alias of srcVerAliases) {
      const re = new RegExp(`/fhir/${alias}/`, 'i');
      if (re.test(url)) return url.replace(re, `/fhir/${tgtVerNum}/`);
    }
    return url;
  }

  /**
   * Rewrite `meta.profile` values while keeping `_profile` primitive metadata
   * at the same indexes. Rewritten duplicates are removed only when their
   * companion metadata is also identical; distinct metadata must remain
   * attached to distinct primitive entries.
   *
   * @param {Object} meta Resource metadata containing a profile array.
   * @param {string|null} declaredTargetProfile Mapping-declared target profile.
   * @returns {void}
   */
  function rewriteMetaProfiles(meta, declaredTargetProfile) {
    const profiles = meta.profile;
    const hasCompanions = Array.isArray(meta._profile);
    const companions = hasCompanions ? meta._profile : [];
    const entryCount = Math.max(profiles.length, companions.length);
    const updatedProfiles = [];
    const updatedCompanions = [];
    const seenRewrittenPairs = new Set();

    for (let index = 0; index < entryCount; index++) {
      const url = profiles[index] ?? null;
      const companion = companions[index] ?? null;
      let updatedUrl = url;
      let rewritten = false;

      if (typeof url === 'string' && isSourceVersionProfile(url)) {
        updatedUrl = declaredTargetProfile || toTargetVersionProfile(url);
        rewritten = true;
      } else if (typeof url === 'string' && FHIR_BASE_PROFILE_RE.test(url)) {
        // Drop standard FHIR profiles belonging to a different version.
        continue;
      }

      if (rewritten) {
        const pairKey = JSON.stringify([updatedUrl, companion]);
        if (seenRewrittenPairs.has(pairKey)) continue;
        seenRewrittenPairs.add(pairKey);
      }

      updatedProfiles.push(updatedUrl);
      if (hasCompanions) updatedCompanions.push(companion);
    }

    if (updatedProfiles.length) {
      meta.profile = updatedProfiles;
    } else {
      delete meta.profile;
    }

    if (hasCompanions && updatedCompanions.some(value => value !== null)) {
      meta._profile = updatedCompanions;
    } else {
      delete meta._profile;
    }
  }

  function convert({ input, entryGroup } = {}) {
    reportedTypeMismatches.clear();
    _listModeWarned.clear();
    if (!isObject(input)) throw new Error('Input must be a JSON object');
    const group = entryGroup || mapping?.entryGroup || input.resourceType;
    if (!group) throw new Error('entryGroup is required when input has no resourceType');

    const sourceResourceType =
      mapping?.sourceResourceType || input.resourceType || group;
    const targetResourceType =
      mapping?.targetResourceType || input.resourceType || group;
    if (mapping && input.resourceType !== sourceResourceType) {
      throw new Error(
        `Input resourceType "${input.resourceType}" does not match FML source ` +
        `resource type "${sourceResourceType}"`,
      );
    }

    const out = {};
    if (targetResourceType) out.resourceType = targetResourceType;

    // Seed the absolute FHIR path of the root target object so that
    // every subsequent child write can build its path by descent.
    setObjectPath(out, targetResourceType);

    // Seed the source root path too, so write-time default-group dispatch can
    // look up source element types via composeChildPath(srcCtx, path).
    setObjectPath(input, sourceResourceType);

    execGroup(group, [input, out]);

    // Update meta.profile: replace standard FHIR base profile URLs matching
    // the source version with the target version. Non-standard profiles are
    // left untouched. If no profile existed, add the target version's base profile.
    if (fromVer && toVer && tgtVerNum && targetResourceType) {
      const declaredTargetProfile = mapping?.targetProfile || null;
      if (Array.isArray(out.meta?.profile)) {
        rewriteMetaProfiles(out.meta, declaredTargetProfile);
        if (Object.keys(out.meta).length === 0) delete out.meta;
      } else {
        // No profile on source -- add the target version's base profile.
        if (!out.meta) out.meta = {};
        const targetProfile = declaredTargetProfile ||
          `http://hl7.org/fhir/${tgtVerNum}/StructureDefinition/${targetResourceType}`;
        const companions = Array.isArray(out.meta._profile) ? out.meta._profile : [];

        out.meta.profile = [targetProfile];
        if (companions.some(value => value !== null)) {
          out.meta.profile.push(...companions.map(() => null));
          out.meta._profile = [null, ...companions.map(value => value ?? null)];
        } else {
          delete out.meta._profile;
        }
      }
    }

    return {
      resource: out,
    };
  }


  return {
    metadata: ast.metadata,
    uses:     ast.uses,
    groups:   [...groups.keys()],
    convert,
  };
}
