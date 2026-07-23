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
 *   |    engine.convert({ input }) -> output FHIR JSON                 |
 *   +------------------------------------------------------------------+
 *
 * Public API:
 *   compileFmlXver({ fmlText, conceptMaps, ...opts }) -> engine
 *   engine.convert({ input, entryGroup? }) -> output JSON resource
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
    if (src.meta !== undefined)          tgt.meta          = deepClone(src.meta);
    if (src.implicitRules !== undefined) tgt.implicitRules = src.implicitRules;
    if (src.language !== undefined)      tgt.language      = src.language;
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
 * for O(1) lookup. Group ordering is preserved so the translator can try
 * later groups as fallbacks for the same source code.
 *
 * Supports both R4 (`equivalence`) and R5 (`relationship`) target fields;
 * either is normalised to lowercase under the `rel` key.
 *
 * @param {Object} cm  A FHIR ConceptMap resource (R4 or R5 shape).
 * @returns {{url: string, groupCount: number, lookup: Map<string, Array>, unmapped: Map<number, Object>}}
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
      lookup.set(`${gi}::${el.code}`, targets);
    }
  }
  return { url, groupCount: groups.length, lookup, unmapped };
}

/**
 * Create a code translator backed by a set of ConceptMaps.
 *
 * The returned `translate(code, mapUrl)` function looks up the source code
 * in the named ConceptMap and returns the best target code, choosing among
 * available targets in this priority order:
 *
 *   1. `equivalent` / `equal`         - exact semantic match (silent)
 *   2. `source-is-narrower-than-target` / `wider` - safe widening (INFO)
 *   3. `source-is-broader-than-target` / `narrower` /
 *      `related-to`                    - lossy match (WARNS)
 *   4. `not-related-to`                - unrelated mapping used as last
 *                                        resort (WARNS)
 *   5. First listed target             - unrecognized relationship (WARNS)
 *   6. `unmapped.mode = fixed`         - group-level fallback code (INFO)
 *   7. `unmapped.mode = provided`      - return source code unchanged (INFO)
 *   8. Otherwise: return source code unchanged (WARNS), or throw if strict.
 *
 * @param {Object[]} conceptMaps                Indexed at construction time.
 * @param {Object}   opts
 * @param {boolean}  [opts.strict=false]        Throw on missing map / unmappable.
 * @param {Function} [opts.onWarning]
 * @param {Function} [opts.onInfo]
 * @returns {{translate: (code: string, mapUrl: string) => string}}
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
    if (exact) return exact.code;

    // Widening (source narrower than target) is safe -- emit info, not warning.
    const safe = targets.find(t => SAFE.has(t.rel));
    if (safe) {
      onInfo?.(`translate("${code}", ${mapUrl}): widening "${safe.rel}" -> "${safe.code}"`);
      return safe.code;
    }

    const lossy = targets.find(t => LOSSY.has(t.rel));
    if (lossy) {
      onWarning?.(`translate("${code}", ${mapUrl}): using lossy relationship "${lossy.rel}" -> "${lossy.code}"`);
      return lossy.code;
    }

    const nrt = targets.find(t => t.rel === 'not-related-to');
    if (nrt) {
      onWarning?.(`translate("${code}", ${mapUrl}): only "not-related-to" mapping available, using "${nrt.code}" anyway`);
      return nrt.code;
    }

    onWarning?.(`translate("${code}", ${mapUrl}): unrecognised relationship "${targets[0].rel}", falling back to first target "${targets[0].code}"`);
    return targets[0].code;
  }

  function translate(code, mapUrl) {
    if (code == null) return code;
    const idx = byUrl.get(mapUrl);
    if (!idx) {
      if (strict) throw new Error(`Missing ConceptMap: ${mapUrl}`);
      onWarning?.(`translate: ConceptMap not found - ${mapUrl}; returning "${code}" unchanged`);
      return code;
    }
    // Try each group in declaration order; earlier groups win.
    for (let gi = 0; gi < idx.groupCount; gi++) {
      const ts = idx.lookup.get(`${gi}::${code}`);
      if (ts) {
        const out = pickTarget(ts, code, mapUrl);
        if (out !== undefined) return out;
      }
    }
    // No explicit mapping; try group-level `unmapped` fallbacks.
    for (let gi = 0; gi < idx.groupCount; gi++) {
      const um = idx.unmapped.get(gi);
      if (um?.mode === 'fixed' && um.code) {
        onInfo?.(`translate("${code}", ${mapUrl}): no explicit mapping, using fixed unmapped code "${um.code}"`);
        return um.code;
      }
      if (um?.mode === 'provided') {
        onInfo?.(`translate("${code}", ${mapUrl}): no explicit mapping, returning source code unchanged (unmapped.mode=provided)`);
        return code;
      }
    }
    if (strict) throw new Error(`No mapping for "${code}" in ${mapUrl}`);
    onWarning?.(`translate: no mapping for "${code}" in ${mapUrl}; returning unchanged`);
    return code;
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
  // The imported ASTs are also kept so buildTypesIndex can find <<types>>
  // conversion groups declared in them (e.g. Reference.fml's canonical2Reference).
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
   * Polymorphic-leaf sets for the source and target FHIR versions.
   * - srcPolyLeaves: used by readSource() to decide whether a bare-path
   *   miss is a candidate for variant expansion ("initial" -> "initialString").
   * - tgtPolyLeaves: used by writeTarget() to decide whether a target
   *   leaf that differs from the source root is itself polymorphic and
   *   should receive the typed suffix ("value" + "String" -> "valueString").
   */
  const srcPolyLeaves = buildPolyLeaves(srcDefs);
  const tgtPolyLeaves = buildPolyLeaves(tgtDefs);

  /**
   * Set of absolute dotted paths whose target field is an array
   * (`max > 1`) in the target FHIR version. Consumed by writeToSlot()
   * (called from every write site) to decide whether to push (or
   * initialize an array) rather than overwrite a slot.
   */
  const tgtArrayPaths = new Set(tgtDefs?.arrayPaths || []);

  /**
   * Maps of absolute FHIR dotted paths to their single concrete type
   * code (e.g. "canonical", "Reference", "Identifier") for non-poly
   * scalar elements in the source and target FHIR versions. These power
   * future type-aware coercion: when a source path's type differs from
   * the target path's type and a `<<types>>` conversion group matches,
   * the engine can auto-invoke that group instead of plain copying.
   */
  const srcElementTypes = new Map(Object.entries(srcDefs?.elementTypes || {}));
  const tgtElementTypes = new Map(Object.entries(tgtDefs?.elementTypes || {}));

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

  /**
   * Build an index of FML `<<types>>` conversion groups across the main
   * FML AST and all imported FML ASTs. Keyed by `${srcType}::${tgtType}`
   * (canonical FHIR type codes, after resolving local `uses ... alias X`
   * declarations back to the URL's terminal segment, e.g. ReferenceR3 ->
   * Reference, codeR3 -> code).
   *
   * Used at write time: when a source field's type differs from the
   * target field's type and a matching entry exists here, the engine
   * invokes that group on a wrapped source object instead of plain
   * copying the value. This implements the FML-spec behavior in which
   * `<<types>>` groups are auto-applied to bridge cross-version type
   * differences (e.g. R4 canonical -> R3 Reference for
   * Questionnaire.item.answerValueSet -> Questionnaire.item.options).
   *
   * Reads directly from the parsed ASTs (the parser captures `<<types>>`
   * annotations into `Group.annotations` and resolves `uses` declarations
   * into `Ast.uses`), so no raw-text re-scan is needed.
   *
   * @param {Ast[]} asts  Parsed ASTs (main + imported).
   * @returns {Map<string,string>}  "srcType::tgtType" -> groupName.
   */
  function buildTypesIndex(asts) {
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

    // Pass 2: find groups annotated `<<types>>` and resolve their src/tgt
    // parameter types via the alias map. Skip malformed signatures.
    const idx = new Map();
    for (const a of asts) {
      for (const [name, g] of a.groups) {
        if (!g.annotations?.includes('types')) continue;
        if (g.params.length < 2) continue;
        const [srcParam, tgtParam] = g.params;
        if (srcParam.mode !== 'source' || tgtParam.mode !== 'target') continue;
        if (!srcParam.type || !tgtParam.type) continue;
        const srcType = aliases.get(srcParam.type) || srcParam.type;
        const tgtType = aliases.get(tgtParam.type) || tgtParam.type;
        const key = `${srcType}::${tgtType}`;
        if (!idx.has(key)) idx.set(key, name);
      }
    }
    return idx;
  }

  /**
   * Index of `(srcType, tgtType) -> conversionGroupName` built from all
   * `<<types>>` groups in the main and imported FML ASTs. Empty when
   * no such groups are present.
   */
  const typesIndex = buildTypesIndex([ast, ...importedAsts]);

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
   * Entries are needed only on target-side objects; source paths are
   * not consulted by the engine today.
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
   * Write `value` to `parent[key]`, honoring target-version cardinality
   * AND FHIR primitive unwrapping:
   *
   *   - If `absolutePath` is known to be an array field, push or initialize
   *     an array; otherwise assign scalar.
   *   - If `value` is a `{value: X, id?, extension?}` wrapper object and
   *     `absolutePath` resolves to a FHIR primitive type in the target
   *     version, unwrap to the bare `X`. This handles the FML idiom
   *     `tgt.X as t, t.value = ...` (and similar nested forms) which
   *     produce a wrapper object that must be collapsed back to the
   *     bare value for JSON FHIR's primitive encoding. id/extension are
   *     currently dropped; a full implementation would write them to a
   *     sibling `_field` slot.
   *
   * Used at all engine write sites: the general writeTarget() path and
   * the child-container creation sites (then-clause and inline-multi-
   * target lift). Routing every write through this helper ensures
   * target-version array cardinality is always honored.
   */
  function writeToSlot(parent, key, value, absolutePath) {
    if (absolutePath && isObject(value) && 'value' in value) {
      const tgtType = tgtElementTypes.get(absolutePath);
      if (tgtType && FHIR_PRIMITIVES.has(tgtType)) {
        const keys = Object.keys(value);
        if (keys.every(k => k === 'value' || k === 'id' || k === 'extension')) {
          value = value.value;
        }
      }
    }

    if (absolutePath && tgtArrayPaths.has(absolutePath)) {
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
        const code   = resolveArg(args[0], scope);
        const mapUrl = args[1].value;  // always a literal in valid FML
        return translator.translate(code, mapUrl);
      }

      case 'copy': {
        const v = resolveArg(args[0], scope);
        return deepClone(v);
      }

      case 'create':
        return args[0]?.value ? { resourceType: args[0].value } : {};

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
   * Returns `{ctx, value, polyName, polySuffix, sourceLeaf}` where:
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
      return { ctx: null, value: undefined, polyName: null, polySuffix: null, sourceLeaf: null };
    }
    const ctx = scope.get(srcSpec.context);

    if (!srcSpec.path) {
      return { ctx, value: ctx, polyName: null, polySuffix: null, sourceLeaf: null };
    }

    /**
     * Tag a source value with its absolute FHIR path so write-time type
     * coercion can look up its element type. For arrays, also tag each
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

    if (srcSpec.typeHint) {
      const segs   = srcSpec.path.split('.');
      const parent = segs.length > 1 ? getPath(ctx, segs.slice(0, -1).join('.')) : ctx;
      const root   = segs[segs.length - 1];
      const polyName   = trailingString || (root + cap(srcSpec.typeHint));
      const polySuffix = cap(srcSpec.typeHint);
      const value      = parent ? parent[polyName] : undefined;
      if (parent != null && value === undefined) {
        onInfo?.(`readSource: polymorphic field "${polyName}" not present (typeHint=${srcSpec.typeHint})`);
      }
      tagSourcePath(value, composeChildPath(ctx, srcSpec.path));
      return { ctx, value, polyName, polySuffix, sourceLeaf: root };
    }

    const directValue = getPath(ctx, srcSpec.path);
    if (directValue !== undefined) {
      tagSourcePath(directValue, composeChildPath(ctx, srcSpec.path));
      return { ctx, value: directValue, polyName: null, polySuffix: null, sourceLeaf: null };
    }

    // Source-clause `default "value"`: when the source path is absent,
    // substitute the literal default the FML author declared so the rule
    // still fires. Parsed by parseOneSource into srcSpec.defaultValue.
    if (srcSpec.defaultValue !== undefined) {
      return {
        ctx,
        value: srcSpec.defaultValue,
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
          const matches = Object.keys(parent).filter(k => re.test(k));
          if (matches.length === 1) {
            const polyName   = matches[0];
            const polySuffix = polyName.slice(leaf.length);
            onInfo?.(`readSource: expanded bare polymorphic ref "${srcSpec.path}" to "${polyName}"`);
            // Tag with the bare-leaf path (matches srcElementTypes keys,
            // though poly fields wouldn't have a scalar type entry anyway).
            tagSourcePath(parent[polyName], composeChildPath(ctx, srcSpec.path));
            return { ctx, value: parent[polyName], polyName, polySuffix, sourceLeaf: leaf };
          }
          if (matches.length > 1) {
            onWarning?.(`readSource: ambiguous polymorphic expansion for "${srcSpec.path}": found ${matches.join(', ')}; not expanding`);
          }
        }
      }
    }

    return { ctx, value: undefined, polyName: null, polySuffix: null, sourceLeaf: null };
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
   */
  function writeTarget(tgtSpec, value, scope, polySuffix, sourceLeaf) {
    if (value === undefined) return;
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
    const tgtIsPolyByLeaf = tgtPolyLeaves.has(targetLeaf);

    if (polySuffix) {
      const sameLeaf = sourceLeaf && targetLeaf === sourceLeaf;
      if (sameLeaf || tgtIsPolyByLeaf) {
        segs[segs.length - 1] = targetLeaf + polySuffix;
        path = segs.join('.');
      }
      // Else: source carries a polymorphic suffix but the target leaf
      // isn't polymorphic in the target version; write to the bare path.
    } else if (tgtIsPolyByLeaf) {
      // JS-type fallback for unambiguous primitives. Validate against
      // the absolute target path's allowed variants (when known) so we
      // don't fire on paths that merely share a leaf name with an
      // unrelated poly field elsewhere.
      const inferred = inferPolySuffixFromValue(value);
      if (inferred) {
        const tgtAbsPath = composeChildPath(tctx, path);
        const allowed = tgtAbsPath ? tgtPolyTypeLists.get(tgtAbsPath) : null;
        const inferredType = inferred.toLowerCase();  // "Boolean" -> "boolean"
        if (!allowed || allowed.includes(inferredType)) {
          segs[segs.length - 1] = targetLeaf + inferred;
          path = segs.join('.');
        }
      }
    }

    const { parent, key } = ensurePath(tctx, path);
    writeToSlot(parent, key, value, composeChildPath(tctx, path));
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
   * Missing args warn and are passed as `undefined`; the called group will
   * also warn (e.g. base-copier non-object check).
   */
  function resolveInvocationArgs(invocation, scope, fallback) {
    if (!invocation.args || invocation.args.length === 0) return fallback;
    const out = [];
    for (const name of invocation.args) {
      if (!scope.has(name)) {
        onWarning?.(`Group invocation "${invocation.name}": arg "${name}" not in scope`);
        out.push(undefined);
      } else {
        out.push(scope.get(name));
      }
    }
    return out;
  }

  /**
   * Execute one rule against the current scope. Resolves all sources, then
   * dispatches to either `execArrayRule` (when the primary source is an
   * array AND we have something to iterate with) or `execScalarRule`.
   *
   * Per FML semantics, if any source resolves to `null`/`undefined`, the
   * whole rule is silently skipped; this is how FML expresses "only apply
   * this rule if the source field is present".
   */
  function execRule(rule, scope) {
    // No-op rules (source-only lines like `src.field;`) are skipped.
    if (rule.noop) return;

    const { sources } = rule;

    // Resolve every source clause. Bail out (silently) if any is absent.
    const bindings = [];
    for (const srcSpec of sources) {
      const { ctx, value, polyName, polySuffix, sourceLeaf } = readSource(srcSpec, scope, rule.trailingString);
      if (ctx == null)   return;
      if (value == null) return;
      bindings.push({ spec: srcSpec, ctx, value, polyName, polySuffix, sourceLeaf });
    }

    const primary = bindings[0];
    let primaryValue = primary.value;

    // Apply list-mode filter to the primary source (first/last/etc.).
    if (Array.isArray(primaryValue) && primary.spec.listMode) {
      switch (primary.spec.listMode) {
        case 'first':     primaryValue = primaryValue.length ? [primaryValue[0]]    : []; break;
        case 'last':      primaryValue = primaryValue.length ? [primaryValue.at(-1)] : []; break;
        case 'not_first': primaryValue = primaryValue.slice(1);     break;
        case 'not_last':  primaryValue = primaryValue.slice(0, -1); break;
        // `only_one` asserts the source list holds exactly one item and
        // collapses it to that single element. Per FML semantics more than
        // one item is an error condition; we warn and keep the first so the
        // rule still produces the single value the map author expects.
        case 'only_one':
          if (primaryValue.length > 1) {
            onWarning?.(`only_one: source "${primary.spec.context}${primary.spec.path ? '.' + primary.spec.path : ''}" has ${primaryValue.length} items; using the first`);
          }
          primaryValue = primaryValue.length ? [primaryValue[0]] : [];
          break;
      }
    }

    // Iterate only when there's something to iterate over (alias, then-clause).
    const isArray        = Array.isArray(primaryValue);
    const needsIteration = isArray && (primary.spec.alias || rule.thenGroup || rule.thenRules);

    if (needsIteration) {
      execArrayRule(rule, primary, primaryValue, bindings, scope);
    } else {
      execScalarRule(rule, primary, primaryValue, bindings, scope);
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
   * @returns {string|null}
   */
  function resolveWritePath(tgtSpec, primary, bindings) {
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
    const sameLeaf   = sourceLeaf && targetLeaf === sourceLeaf;
    const tgtIsPoly  = tgtPolyLeaves.has(targetLeaf);
    if (sameLeaf || tgtIsPoly) {
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
   */
  function applyIntermediateTarget(tgtSpec, scope) {
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
    if (tgtSpec.context && tgtSpec.path) {
      const tctx = scope.get(tgtSpec.context);
      if (tctx == null) {
        onWarning?.(`Intermediate target: context "${tgtSpec.context}" not in scope`);
      } else {
        const absPath = composeChildPath(tctx, tgtSpec.path);
        if (isObject(value)) setObjectPath(value, absPath);
        const { parent, key } = ensurePath(tctx, tgtSpec.path);
        writeToSlot(parent, key, value, absPath);
      }
    }

    if (tgtSpec.alias && value !== undefined) {
      scope.set(tgtSpec.alias, value);
    }
  }

  /**
   * Modes already emitted, so we warn at most once per mode per engine
   * (array rules would otherwise warn once per iterated item).
   * @type {Set<string>}
   */
  const _listModeWarned = new Set();

  /**
   * Warn (once per mode) when a target carries a list mode that the engine
   * recognises syntactically but does not yet apply. `first`/`last`/`single`
   * /`share`/`collate` currently fall through to the default behavior of
   * appending a fresh element rather than reusing an existing list slot, so
   * we surface that gap rather than silently diverging from FML semantics.
   *
   * @param {Target} tgtSpec
   */
  function warnUnhandledTargetListMode(tgtSpec) {
    const m = tgtSpec?.listMode;
    if (!m || _listModeWarned.has(m)) return;
    _listModeWarned.add(m);
    onWarning?.(`target list mode "${m}" is recognised but not yet applied; appending a new element instead`);
  }

  /**
   * Resolve the target list element that a `first` / `last` target list
   * mode refers to, so a `then`-rule reuses an existing element instead of
   * appending a new one.
   *
   * FML `first` / `last` mean "write into the first / last element already
   * present in the target list" (e.g. R3->R2 HealthcareService merges each
   * `specialty` into the first `serviceType` created from `type`, rather
   * than creating standalone `serviceType` entries that would be missing
   * the required `.type`). When the list is empty or absent, a fresh
   * element is created and appended so there is something to write into;
   * this preserves data when the reused-from rule produced nothing.
   *
   * @param {Object} tctx     Target context object holding the list.
   * @param {string} path     Dot-path of the list field on `tctx`.
   * @param {'first'|'last'} mode
   * @param {string|null} absPath  Absolute FHIR path to tag on a fresh element.
   * @returns {Object|null}   The reused element, or null when `path` is empty.
   */
  function resolveListModeSlot(tctx, path, mode, absPath) {
    if (!path) return null;
    const { parent, key } = ensurePath(tctx, path);
    let arr = parent[key];
    if (!Array.isArray(arr)) {
      arr = arr === undefined ? [] : [arr];
      parent[key] = arr;
    }
    if (arr.length === 0) {
      const fresh = {};
      setObjectPath(fresh, absPath);
      arr.push(fresh);
      return fresh;
    }
    return mode === 'last' ? arr[arr.length - 1] : arr[0];
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
   * Then-clauses on non-object source values warn and skip; they don't
   * make sense for primitives.
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

    if (thenGroup || thenRules) {
      // Category 3: source-level then without targets (e.g. `src.field as v then Group(v, tgt)`)
      if (targets.length === 0) {
        if (thenGroup) {
          // execGroup() wraps primitive source args as {value: <prim>},
          // so we can dispatch even when primaryValue is a JS primitive
          // (e.g. a Reference's `reference` URL string being handed off
          // to a uri-conversion group).
          const argValues = resolveInvocationArgs(thenGroup, ruleScope, [primaryValue]);
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
      const writePath = resolveWritePath(tgtSpec, primary, bindings);

      // Primitive source: the FML idiom
      //   `tgt.X = create('primType') as vt then primType(vs, vt) "polyName"`
      // is a primitive copy. The `create(...) as vt then primType(vs, vt)`
      // wrapper doesn't translate meaningfully when the source is a raw JS
      // primitive (no id/extension to copy), so we write the primitive
      // value directly to the target's polymorphic field.
      if (!isObject(primaryValue)) {
        if (writePath) {
          const { parent, key } = ensurePath(tctx, writePath);
          writeToSlot(parent, key, primaryValue, composeChildPath(tctx, writePath));
        } else {
          onWarning?.(`then-clause: cannot assign primitive source to bare context "${tgtSpec.context}"`);
        }
        return;
      }

      // Target list mode `first`/`last`: reuse an existing element of the
      // target list rather than appending a fresh child (see
      // resolveListModeSlot). Other modes are still only recognised, not
      // applied (warnUnhandledTargetListMode).
      const reuseSlot = tgtSpec.listMode === 'first' || tgtSpec.listMode === 'last';
      let child;
      if (reuseSlot && writePath) {
        child = resolveListModeSlot(tctx, writePath, tgtSpec.listMode, composeChildPath(tctx, writePath));
      } else {
        if (tgtSpec.listMode) warnUnhandledTargetListMode(tgtSpec);
        child = {};
        // Record the child's absolute FHIR path so deeper writes (and the
        // final slot write below) can consult target-version cardinality.
        setObjectPath(child, composeChildPath(tctx, writePath));
      }
      if (tgtSpec.alias) ruleScope.set(tgtSpec.alias, child);

      // Multi-target then-rule: intermediate targets (targets[1..]) build
      // nested structure and bind aliases the then-clause relies on
      // (e.g. `tgt.A as t, t.B as tc then Group(s, tc)`). Apply them
      // before running the then-clause so their aliases are in scope.
      for (let i = 1; i < targets.length; i++) {
        applyIntermediateTarget(targets[i], ruleScope);
      }

      if (thenGroup) {
        const argValues = resolveInvocationArgs(thenGroup, ruleScope, [primaryValue, child]);
        execGroup(thenGroup.name, argValues, ruleScope);
      } else {
        // Inline `then { ... }`: shadow the parent's target context with
        // the fresh child so sub-rules write into it.
        const subScope = ruleScope.child();
        subScope.set(tgtSpec.context, child);
        for (const sr of thenRules) execRule(sr, subScope);
      }

      // Reused slots are already in the target list; only fresh children
      // need to be written.
      if (!reuseSlot) {
        if (writePath) {
          const { parent, key } = ensurePath(tctx, writePath);
          writeToSlot(parent, key, child, composeChildPath(tctx, writePath));
        } else {
          Object.assign(tctx, child);
        }
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
  function execArrayRule(rule, primary, items, bindings, scope) {
    const { targets, thenGroup, thenRules } = rule;

    // Category 3: source-level then without targets in array context
    if (targets.length === 0) {
      for (const item of items) {
        const iterScope = scope.child();
        iterScope.set('$this', item); // Bind iteration context for unqualified guard references
        if (primary.spec.alias) iterScope.set(primary.spec.alias, item);
        for (let i = 1; i < bindings.length; i++) {
          const b = bindings[i];
          if (b.spec.alias) iterScope.set(b.spec.alias, b.value);
        }
        if (!evalGuard(primary.spec.where, iterScope)) continue;
        if (thenGroup) {
          if (!isObject(item)) continue;
          const argValues = resolveInvocationArgs(thenGroup, iterScope, [item]);
          execGroup(thenGroup.name, argValues, iterScope);
        } else if (thenRules) {
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

    // Target list mode `first`/`last`: every iterated item merges into the
    // same existing element of the target list (resolved once), rather than
    // each producing its own appended element. Only meaningful for
    // then-rules (which build child objects).
    const reuseSlot = (tgtSpec.listMode === 'first' || tgtSpec.listMode === 'last') &&
                      (thenGroup || thenRules) && !!tgtSpec.path;
    const sharedWritePath = reuseSlot ? resolveWritePath(tgtSpec, primary, bindings) : null;
    const sharedSlot = reuseSlot
      ? resolveListModeSlot(tctx, sharedWritePath, tgtSpec.listMode, composeChildPath(tctx, sharedWritePath))
      : null;
    if (!reuseSlot && tgtSpec.listMode) warnUnhandledTargetListMode(tgtSpec);

    const results = [];
    for (const item of items) {
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

      if (thenGroup || thenRules) {
        if (!isObject(item)) {
          onWarning?.(`Array iteration: then-clause on non-object item (type=${typeof item}); skipping element`);
          continue;
        }
        let child;
        if (reuseSlot && sharedSlot) {
          // Merge every item into the shared reused element.
          child = sharedSlot;
        } else {
          child = {};
          // Record the child's absolute FHIR path so writes into it (and
          // any group invoked on it) can consult target-version cardinality.
          // FHIR paths are array-blind: an item at index i still has the
          // parent path (no [i] segment).
          const writePath = resolveWritePath(tgtSpec, primary, bindings);
          setObjectPath(child, composeChildPath(tctx, writePath));
        }
        if (tgtSpec.alias) iterScope.set(tgtSpec.alias, child);

        // Multi-target then-rule (array context): apply intermediate
        // targets (targets[1..]) so their aliases are bound before the
        // then-clause runs, mirroring execScalarRule.
        for (let i = 1; i < targets.length; i++) {
          applyIntermediateTarget(targets[i], iterScope);
        }

        if (thenGroup) {
          const argValues = resolveInvocationArgs(thenGroup, iterScope, [item, child]);
          execGroup(thenGroup.name, argValues, iterScope);
        } else {
          const subScope = iterScope.child();
          subScope.set(tgtSpec.context, child);
          for (const sr of thenRules) execRule(sr, subScope);
        }
        // Reused slots are already in the target list; do not re-append.
        if (!reuseSlot) results.push(child);
      } else {
        // No then-clause: each iteration produces one scalar value.
        const v = computeTargetValue(tgtSpec, primary, bindings, iterScope, item);
        if (v !== undefined) results.push(v);
      }
    }

    // Reused-slot rules have already written into the existing list element.
    if (reuseSlot) return;
    if (results.length === 0) return;
    if (!tgtSpec.path) {
      onWarning?.(`Array rule: no target path; cannot write ${results.length} item(s)`);
      return;
    }
    const { parent, key } = ensurePath(tctx, tgtSpec.path);
    // Route through writeToSlot for consistency with the rest of the
    // write paths: it preserves the array contents on a fresh slot and
    // concatenates into an existing array when two rules feed the same
    // target field.
    writeToSlot(parent, key, results, composeChildPath(tctx, tgtSpec.path));
  }

  /**
   * Attempt FML-spec-style automatic type coercion for a plain-copy
   * target write. Returns the coerced value (an object produced by the
   * matching `<<types>>` conversion group) on success, or `undefined`
   * when no coercion applies and the caller should fall back to a plain
   * copy.
   *
   * Coercion is attempted only when:
   *   - typesIndex is non-empty (some `<<types>>` group exists), AND
   *   - the target has no explicit `transform` (the FML author hasn't
   *     opted in to a specific RHS expression), AND
   *   - the primary source value is not nullish, AND
   *   - both the source and target absolute paths are known and resolve
   *     to scalar types in their respective FHIR versions, AND
   *   - those scalar types differ, AND
   *   - a `<<types>>` group exists for `(srcType, tgtType)`.
   *
   * The source value is wrapped as `{value: <srcVal>}` when it is a
   * primitive (the FHIR JSON convention: a primitive's underlying value
   * is the value itself, while id/extension live in a sibling `_field`).
   * Object sources are passed through unchanged.
   *
   * Emits `onInfo` once per unresolvable type mismatch (types differ but
   * no conversion group available) so that gaps can be diagnosed.
   *
   * @param {Target} tgt       The target clause being written to.
   * @param {Object} primary   The primary source binding.
   * @param {Scope}  scope     The current rule scope (for execGroup).
   * @returns {*|undefined}    Coerced value, or undefined to fall back.
   */
  /**
   * Set of FHIR primitive type codes. Their JSON encoding is the bare
   * value (with optional sibling `_field` for id/extension). When the
   * target of a `<<types>>` coercion is one of these, the produced
   * wrapper object `{value, id?, extension?}` must be unwrapped back to
   * the bare value before being written; the optional id/extension are
   * left dropped for now (a full implementation would write them to a
   * `_field` sibling).
   */
  const FHIR_PRIMITIVES = new Set([
    'boolean', 'integer', 'decimal', 'string', 'uri', 'url', 'canonical',
    'base64Binary', 'instant', 'date', 'dateTime', 'time', 'code', 'oid',
    'id', 'markdown', 'unsignedInt', 'positiveInt', 'uuid', 'xhtml',
    'integer64',
  ]);

  function tryTypeCoercion(tgt, primary, scope) {
    if (typesIndex.size === 0) return undefined;
    if (tgt.transform) return undefined;
    if (primary.value == null) return undefined;

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

    const srcType = srcElementTypes.get(srcAbsPath);
    const tgtType = tgtElementTypes.get(tgtAbsPath);
    if (!srcType || !tgtType || srcType === tgtType) return undefined;

    const groupName = typesIndex.get(`${srcType}::${tgtType}`);
    if (!groupName) {
      onInfo?.(`type mismatch ${srcType}->${tgtType} at ${srcAbsPath} -> ${tgtAbsPath}; no <<types>> group, plain copy`);
      return undefined;
    }

    const wrapped = isObject(primary.value) ? primary.value : { value: primary.value };
    const child   = {};
    setObjectPath(child, tgtAbsPath);
    execGroup(groupName, [wrapped, child], scope);

    // Unwrap when the target is a FHIR primitive: the coerced wrapper
    // {value, ...} is collapsed back to the bare value. Extensions (id,
    // extension) are dropped for now; a full impl would write them to
    // the sibling `_field` slot.
    if (FHIR_PRIMITIVES.has(tgtType) && isObject(child) && 'value' in child) {
      return child.value;
    }
    return child;
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
    warnUnhandledTargetListMode(tgt);
    // FML-spec auto-coercion: when source and target element types
    // differ and a <<types>> conversion group is available, run that
    // group instead of plain copying.
    const coerced = tryTypeCoercion(tgt, primary, scope);
    if (coerced !== undefined) {
      writeTarget(tgt, coerced, scope, null, null);
      return;
    }

    const value = computeTargetValue(tgt, primary, bindings, scope, primary.value);
    if (value === undefined) return;

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
      const allowed = tgtAbsPath ? tgtPolyTypeLists.get(tgtAbsPath) : null;
      if (allowed) {
        const srcCtx = scope.get(primary.spec.context);
        const srcAbsPath = srcCtx ? composeChildPath(srcCtx, primary.spec.path) : null;
        if (srcAbsPath) {
          const srcType = srcElementTypes.get(srcAbsPath);
          if (srcType && allowed.includes(srcType)) {
            polySuffix = cap(srcType);
          }
        }
      }
    }

    writeTarget(tgt, value, scope, polySuffix, sourceLeaf);
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
        // downstream <<types>> coercion (which keys off srcElementTypes
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
   * @returns {Object} The converted resource (a new object).
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

  function convert({ input, entryGroup } = {}) {
    if (!isObject(input)) throw new Error('Input must be a JSON object');
    const group = entryGroup || input.resourceType;
    if (!group) throw new Error('entryGroup is required when input has no resourceType');

    const out = {};
    if (input.resourceType) out.resourceType = input.resourceType;

    // Seed the absolute FHIR path of the root target object so that
    // every subsequent child write can build its path by descent.
    // The entry group name is the resource type (e.g. "Questionnaire").
    setObjectPath(out, group);

    // Seed the source root path too, so write-time type coercion can
    // look up source element types via composeChildPath(srcCtx, path).
    setObjectPath(input, group);

    execGroup(group, [input, out]);

    // Update meta.profile: replace standard FHIR base profile URLs matching
    // the source version with the target version. Non-standard profiles are
    // left untouched. If no profile existed, add the target version's base profile.
    if (fromVer && toVer && tgtVerNum && input.resourceType) {
      if (Array.isArray(out.meta?.profile)) {
        const updated = [];
        for (const url of out.meta.profile) {
          if (isSourceVersionProfile(url)) {
            updated.push(toTargetVersionProfile(url));
          } else if (!FHIR_BASE_PROFILE_RE.test(url)) {
            // Non-standard profile -- keep as-is.
            updated.push(url);
          }
          // else: standard FHIR profile for a different version -- drop it.
        }
        out.meta.profile = updated.length ? updated : undefined;
        if (!out.meta.profile && Object.keys(out.meta).length === 0) {
          delete out.meta;
        }
      } else {
        // No profile on source -- add the target version's base profile.
        if (!out.meta) out.meta = {};
        out.meta.profile = [`http://hl7.org/fhir/${tgtVerNum}/StructureDefinition/${input.resourceType}`];
      }
    }

    return out;
  }


  return {
    metadata: ast.metadata,
    uses:     ast.uses,
    groups:   [...groups.keys()],
    convert,
  };
}

