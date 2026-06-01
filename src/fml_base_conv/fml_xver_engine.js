/**
 * @fileoverview FHIR Mapping Language (FML) cross-version conversion engine.
 *
 * Compiles FML source text + optional ConceptMap resources into an executable
 * converter for FHIR JSON resources. Targets the subset of FML used by the
 * official HL7 cross-version mappings at https://hl7.org/fhir/uv/xver/.
 *
 *   +------------------------------------------------------------------+
 *   |  Pipeline:                                                       |
 *   |    tokenize(text) -> tokens                                      |
 *   |    parse(tokens)  -> AST { metadata, uses, groups }              |
 *   |    compile(ast)   -> engine bound to translator + diagnostics    |
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
 * ----- AST shape (produced by parseFml) -----------------------------------
 *
 * @typedef {Object} Ast
 * @property {Object<string,string>} metadata  /// key = value declarations
 * @property {UsesDecl[]}            uses      uses declarations
 * @property {Map<string,Group>}     groups    group name -> Group node
 *
 * @typedef {Object} UsesDecl
 * @property {string}      url    Canonical URL of source/target structure.
 * @property {string|null} alias  Alias name from `alias X`.
 * @property {string|null} mode   'source' | 'target' | null.
 *
 * @typedef {Object} Group
 * @property {string}      name         Group name.
 * @property {Param[]}     params       Declared parameters in order.
 * @property {string|null} extendsType  Parent group or base-type name, or null.
 * @property {Rule[]}      rules        Rules in declaration order.
 *
 * @typedef {Object} Param
 * @property {'source'|'target'} mode   Parameter direction.
 * @property {string}            alias  Bound name inside the group body.
 * @property {string|null}       type   Declared type name or null.
 *
 * @typedef {Object} Rule
 * @property {Source[]}        sources         Left-hand side of `->`.
 * @property {Target[]}        targets         Right-hand side of `->`.
 * @property {Invocation|null} thenGroup       `then GroupName(args)` clause.
 * @property {Rule[]|null}     thenRules       Inline `then { ... }` block.
 * @property {string|null}     trailingString  Trailing string literal,
 *                                             usually a polymorphic variant
 *                                             name like "valueBoolean".
 *
 * @typedef {Object} Source
 * @property {string}         context   Variable name in scope (e.g. 'src').
 * @property {string|null}    path      Dot-path from context (e.g. 'item.linkId').
 * @property {string|null}    alias     Bound name from `as X`.
 * @property {string|null}    typeHint  Polymorphic type from `: Type`.
 * @property {GuardExpr|null} where     `where (...)` guard.
 * @property {GuardExpr|null} check     `check (...)` guard. Warning only;
 *                                      does not short-circuit the rule.
 * @property {'first'|'last'|'not_first'|'not_last'|null} listMode
 *
 * @typedef {Object} Target
 * @property {string}         context    Variable name in scope (e.g. 'tgt').
 * @property {string|null}    path       Dot-path on context.
 * @property {string|null}    alias      Bound name from `as X`.
 * @property {Transform|null} transform  RHS expression after `=`, if any.
 *
 * @typedef {Object} Transform
 * @property {string}              fn     Transform function name.
 * @property {TransformArg[]|any[]} args  Arguments (literal first-arg from
 *                                        a bare string shortcut may be a raw
 *                                        string rather than a TransformArg).
 *
 * @typedef {Object} TransformArg
 * @property {'literal'|'ident'} kind   Literal string or identifier reference.
 * @property {string}            value  The literal text or identifier name.
 *
 * @typedef {Object} GuardExpr
 * @property {string}        left   Dot-path; the first segment must be in scope.
 * @property {'='|'!='|null} op     Comparison operator, or null for existence.
 * @property {string|null}   right  Literal RHS (used when op !== null).
 *
 * @typedef {Object} Invocation
 * @property {string}   name  Group name to invoke.
 * @property {string[]} args  Arg names to look up in the calling scope.
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
 * @module sonnet/fml_xver_engine
 */

import fhirpathLib from 'fhirpath';

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
    'related-to', 'relatedto',
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

// ----- Tokeniser ----------------------------------------------------------

/**
 * Token kinds produced by the tokeniser. The parser switches on `kind`.
 * @enum {string}
 */
const TK = Object.freeze({
  WORD: 'WORD', STRING: 'STRING', ARROW: 'ARROW',
  SEMI: 'SEMI', COMMA: 'COMMA', COLON: 'COLON', DOT: 'DOT',
  LPAREN: 'LPAREN', RPAREN: 'RPAREN', LBRACE: 'LBRACE', RBRACE: 'RBRACE',
  EQ: 'EQ', NEQ: 'NEQ', META: 'META', EOF: 'EOF', PIPE: 'PIPE',
});

/** Map from single-character punctuation to its token kind. */
const SINGLE_CHAR = {
  ';': TK.SEMI, ',': TK.COMMA, ':': TK.COLON, '.': TK.DOT,
  '(': TK.LPAREN, ')': TK.RPAREN, '{': TK.LBRACE, '}': TK.RBRACE, '=': TK.EQ,
  '|': TK.PIPE,
};

/**
 * Tokenise FML source text into a stream of `{kind, value, line}` tokens.
 *
 * Handles three kinds of comments: `//` line comments, block comments
 * delimited by slash-star and star-slash, and `///` triple-slash metadata
 * comments. Strips type-annotation noise like `<<type+>>` which we don't
 * need for execution.
 *
 * Tokeniser failures (unrecognised characters, unterminated strings) emit
 * warnings rather than throwing, so a malformed file still produces a
 * stream the parser can attempt; this makes it easier to localise where
 * the real problem is.
 *
 * @param {string}   text
 * @param {Function} [onWarning]
 * @returns {Array<{kind: string, value: string, line: number}>}
 */
function tokenise(text, onWarning) {
  const tokens = [];
  let i = 0, line = 1;
  const push = (kind, value) => tokens.push({ kind, value, line });

  while (i < text.length) {
    const c = text[i], c2 = text[i + 1], c3 = text[i + 2];

    // --- Whitespace ---
    if (c === '\n')                 { line++; i++; continue; }
    if (c === '\r' || /\s/.test(c)) { i++; continue; }

    // --- /// metadata comment ---
    if (c === '/' && c2 === '/' && c3 === '/') {
      i += 3;
      let s = '';
      while (i < text.length && text[i] !== '\n') s += text[i++];
      push(TK.META, s.trim());
      continue;
    }
    // --- // line comment ---
    if (c === '/' && c2 === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    // --- block comment (slash-star ... star-slash) ---
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') line++;
        i++;
      }
      i += 2;
      continue;
    }

    // --- Multi-char operators ---
    if (c === '-' && c2 === '>') { push(TK.ARROW, '->'); i += 2; continue; }
    if (c === '!' && c2 === '=') { push(TK.NEQ, '!=');  i += 2; continue; }
    if (c === '<' && c2 === '<') { i += 2; continue; }  // type annotation open
    if (c === '>' && c2 === '>') { i += 2; continue; }  // type annotation close

    // --- Single-char tokens ---
    if (SINGLE_CHAR[c]) { push(SINGLE_CHAR[c], c); i++; continue; }

    // Type-annotation noise (we already skipped `<<`/`>>` above)
    if (c === '<' || c === '>' || c === '+') { i++; continue; }

    // --- Quoted strings (single or double) ---
    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      let s = '';
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') { i++; s += text[i++] ?? ''; continue; }
        if (text[i] === '\n') line++;
        s += text[i++];
      }
      if (i >= text.length) {
        onWarning?.(`Tokenizer: unterminated string literal starting near line ${line}`);
      }
      i++;
      push(TK.STRING, s);
      continue;
    }

    // --- Numeric literal (captured as WORD for uniform handling) ---
    if (/[0-9]/.test(c)) {
      let n = '';
      while (i < text.length && /[0-9.]/.test(text[i])) n += text[i++];
      push(TK.WORD, n);
      continue;
    }

    // --- Identifier (letters, digits, underscore; embedded hyphens allowed
    //     when not followed by `>`, so `source-is-narrower-than-target` is
    //     one token but `src->tgt` still tokenises correctly) ---
    if (/[a-zA-Z_$%]/.test(c)) {
      let w = '';
      while (i < text.length && /[a-zA-Z0-9_$%]/.test(text[i])) w += text[i++];
      while (i < text.length && text[i] === '-' && text[i + 1] !== '>') {
        w += text[i++];
        while (i < text.length && /[a-zA-Z0-9_$%]/.test(text[i])) w += text[i++];
      }
      push(TK.WORD, w);
      continue;
    }

    onWarning?.(`Tokenizer: skipping unrecognised character ${JSON.stringify(c)} at line ${line}`);
    i++;
  }
  push(TK.EOF, '');
  return tokens;
}

// ----- Parser (recursive descent -> AST) ----------------------------------

/**
 * Parse FML source text into a structured AST. See the @fileoverview block
 * for the full AST type definitions.
 *
 * The parser is permissive at the top level (warns and skips unknown
 * tokens), but strict inside rules and groups; malformed rules silently
 * mis-executing is worse than a clear parse failure with a line number.
 *
 * @param {string}   fmlText
 * @param {Function} [onWarning]
 * @returns {Ast}
 * @throws {SyntaxError} On malformed rule, group, or guard syntax.
 */
function parseFml(fmlText, onWarning) {
  const tokens = tokenise(fmlText, onWarning);
  let pos = 0;

  const peek    = ()    => tokens[pos];
  const advance = ()    => tokens[pos++];
  const at      = (k,v) => peek().kind === k && (v === undefined || peek().value === v);
  const atWord  = (w)   => at(TK.WORD, w);

  /** Consume the next token if it matches; else throw a clear error. */
  function expect(kind, value) {
    const t = peek();
    if (t.kind !== kind || (value !== undefined && t.value !== value)) {
      throw new SyntaxError(
        `FML parse error at line ${t.line}: expected ${kind}${value ? ` '${value}'` : ''}, ` +
        `got ${t.kind} '${t.value}'`
      );
    }
    return advance();
  }

  // --- Top-level dispatch loop ---
  const metadata = {};
  const uses     = [];
  const groups   = new Map();

  while (!at(TK.EOF)) {
    if (at(TK.META)) {
      const m = advance().value.match(/^(\w+)\s*=\s*(.+)$/);
      if (m) {
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        metadata[m[1]] = v;
      }
    } else if (atWord('uses')) {
      uses.push(parseUses());
    } else if (atWord('group')) {
      const g = parseGroup();
      groups.set(g.name, g);
    } else if (atWord('imports') || atWord('map')) {
      // `map "url" = "name"` and `imports "url"`: not executed, just consumed.
      advance();
      while (!at(TK.SEMI) && !at(TK.EOF) &&
             !atWord('group') && !atWord('uses') && !atWord('imports') && !atWord('map')) {
        advance();
      }
      if (at(TK.SEMI)) advance();
    } else {
      onWarning?.(`Parser: unexpected token ${peek().kind} '${peek().value}' at line ${peek().line}, skipping`);
      advance();
    }
  }

  return { metadata, uses, groups };

  // --- Sub-parsers (hoisted) ---

  /** Parse `uses "url" [alias X] [as source|target] ;`. */
  function parseUses() {
    expect(TK.WORD, 'uses');
    const url = expect(TK.STRING).value;
    let alias = null, mode = null;
    if (atWord('alias')) { advance(); alias = expect(TK.WORD).value; }
    if (atWord('as'))    { advance(); mode  = expect(TK.WORD).value; }
    if (at(TK.SEMI)) advance();
    return { url, alias, mode };
  }

  /** Parse `group Name(params) [extends Y] { rules }`. */
  function parseGroup() {
    expect(TK.WORD, 'group');
    const name = expect(TK.WORD).value;
    expect(TK.LPAREN);
    const params = parseParamList();
    expect(TK.RPAREN);

    let extendsType = null;
    if (atWord('extends')) { advance(); extendsType = expect(TK.WORD).value; }

    // Skip remaining annotation words until `{`.
    while (at(TK.WORD) && peek().kind !== TK.LBRACE) advance();

    expect(TK.LBRACE);
    const rules = [];
    while (!at(TK.RBRACE) && !at(TK.EOF)) rules.push(parseRule());
    expect(TK.RBRACE);

    return { name, params, extendsType, rules };
  }

  /** Parse a comma-separated parameter list inside group `(...)`. */
  function parseParamList() {
    const params = [];
    while (!at(TK.RPAREN) && !at(TK.EOF)) {
      const mode  = expect(TK.WORD).value;
      const alias = expect(TK.WORD).value;
      let type = null;
      if (at(TK.COLON)) { advance(); type = expect(TK.WORD).value; }
      params.push({ mode, alias, type });
      if (at(TK.COMMA)) advance();
    }
    return params;
  }

  /** Parse one rule: `sources -> targets [then ...] ["polyName"] ;`. */
  function parseRule() {
    const sources = parseSources();

    // Category 4: no-op source-only lines like `src.field;`
    if (at(TK.SEMI)) {
      advance();
      return { sources, targets: [], thenGroup: null, thenRules: null, trailingString: null, noop: true };
    }

    // Category 3: source-level `then` without `->` (e.g. `src.field as v then { ... }`)
    if (atWord('then')) {
      advance();
      let thenGroup = null, thenRules = null;
      if (at(TK.LBRACE)) {
        advance();
        thenRules = [];
        while (!at(TK.RBRACE) && !at(TK.EOF)) thenRules.push(parseRule());
        expect(TK.RBRACE);
      } else {
        thenGroup = parseInvocation();
      }
      let trailingString = null;
      if (at(TK.STRING)) trailingString = advance().value;
      if (at(TK.SEMI)) advance();
      return { sources, targets: [], thenGroup, thenRules, trailingString };
    }

    expect(TK.ARROW);
    const targets = parseTargets();

    let thenGroup = null, thenRules = null;
    if (atWord('then')) {
      advance();
      if (at(TK.LBRACE)) {
        // Inline sub-rule block.
        advance();
        thenRules = [];
        while (!at(TK.RBRACE) && !at(TK.EOF)) thenRules.push(parseRule());
        expect(TK.RBRACE);
      } else {
        // Group invocation like `then ItemMap(item, titem)`.
        thenGroup = parseInvocation();
      }
    }

    // Trailing string is usually a polymorphic variant name like "valueBoolean".
    let trailingString = null;
    if (at(TK.STRING)) trailingString = advance().value;

    if (at(TK.SEMI)) advance();
    return { sources, targets, thenGroup, thenRules, trailingString };
  }

  /** Parse a comma-separated list of source clauses. */
  function parseSources() {
    const out = [parseOneSource()];
    while (at(TK.COMMA)) {
      advance();
      if (at(TK.ARROW)) break;
      out.push(parseOneSource());
    }
    return out;
  }

  /**
   * Parse one source clause:
   *   context [. dotPath] [: TypeHint] [listMode] [as alias] [where (...)] [check (...)]
   */
  function parseOneSource() {
    const src = {
      context: expect(TK.WORD).value,
      path: null, alias: null, typeHint: null,
      where: null, check: null, listMode: null,
    };
    if (at(TK.DOT))    { advance(); src.path     = parseDotPath(); }
    if (at(TK.COLON))  { advance(); src.typeHint = expect(TK.WORD).value; }
    // Cardinality annotations like `0..1` -- skip
    if (at(TK.WORD) && /^\d+\.\.\d+$/.test(peek().value)) { advance(); }
    if (atWord('first') || atWord('last') || atWord('not_first') || atWord('not_last') || atWord('only_one')) {
      src.listMode = advance().value;
    }
    // `default "value"` -- a default value for when source is absent
    if (atWord('default')) { advance(); src.defaultValue = at(TK.STRING) ? advance().value : expect(TK.WORD).value; }
    if (atWord('as'))    { advance(); src.alias = expect(TK.WORD).value; }
    if (atWord('where')) { advance(); src.where = parseGuardExpr(); }
    if (atWord('check')) { advance(); src.check = parseGuardExpr(); }
    return src;
  }

  /** Parse a dot-separated identifier chain like `item.enableWhen.question`. */
  function parseDotPath() {
    let p = expect(TK.WORD).value;
    while (at(TK.DOT)) { advance(); p += '.' + expect(TK.WORD).value; }
    return p;
  }

  /**
   * Parse a guard expression: `(fhirpath-expr)` or a bare `path`.
   * For simple cases like `(linkId = 'foo')`, returns { left, op, right }.
   * For complex FHIRPath expressions, captures the raw text as { fhirpath }.
   * A bare path like `linkId` returns { left, op: null, right: null }.
   */
  function parseGuardExpr() {
    if (at(TK.LPAREN)) {
      // Try simple form first: (dotPath [op value])
      const startPos = pos;
      advance(); // consume LPAREN

      // Check if this is a simple `dotPath [= | !=] value` form
      if (at(TK.WORD)) {
        const savedPos = pos;
        let left = advance().value;
        while (at(TK.DOT)) { advance(); left += '.' + expect(TK.WORD).value; }
        const op = at(TK.EQ) ? '=' : at(TK.NEQ) ? '!=' : null;
        if (op && !left.includes('(')) {
          advance();
          if (at(TK.STRING)) {
            let right = advance().value;
            if (at(TK.RPAREN)) { advance(); return { left, op, right }; }
          } else if (at(TK.WORD)) {
            let right = advance().value;
            if (at(TK.RPAREN)) { advance(); return { left, op, right }; }
          }
          // Complex RHS -- fall through to balanced-paren extraction
        } else if (at(TK.RPAREN) && !left.includes('(')) {
          advance();
          return { left, op: null, right: null };
        }
        // Fall through to balanced-paren extraction
        pos = startPos;
      } else {
        pos = startPos;
      }

      // Complex expression: extract balanced parens as raw FHIRPath text
      advance(); // consume LPAREN again
      let depth = 1;
      let exprParts = [];
      while (depth > 0 && !at(TK.EOF)) {
        if (at(TK.LPAREN)) depth++;
        if (at(TK.RPAREN)) { depth--; if (depth === 0) break; }
        const tk = advance();
        // Reconstruct text from tokens
        if (tk.kind === TK.STRING) exprParts.push("'" + tk.value + "'");
        else if (tk.kind === TK.DOT) exprParts.push('.');
        else if (tk.kind === TK.COMMA) exprParts.push(', ');
        else if (tk.kind === TK.COLON) exprParts.push(':');
        else if (tk.kind === TK.EQ) exprParts.push(' = ');
        else if (tk.kind === TK.NEQ) exprParts.push(' != ');
        else if (tk.kind === TK.LPAREN) exprParts.push('(');
        else if (tk.kind === TK.RPAREN) exprParts.push(')');
        else if (tk.kind === TK.SEMI) exprParts.push(';');
        else if (tk.kind === TK.PIPE) exprParts.push(' | ');
        else exprParts.push(tk.value);
      }
      expect(TK.RPAREN); // consume closing paren
      const fhirpathExpr = exprParts.join('').trim();
      return { fhirpath: fhirpathExpr };
    }
    let left = expect(TK.WORD).value;
    while (at(TK.DOT)) { advance(); left += '.' + expect(TK.WORD).value; }
    return { left, op: null, right: null };
  }

  /** Parse a comma-separated list of target clauses. */
  function parseTargets() {
    const out = [parseOneTarget()];
    while (at(TK.COMMA) && !atWord('then') && !at(TK.SEMI) && !at(TK.STRING) && !at(TK.EOF)) {
      advance();
      if (atWord('then') || at(TK.SEMI) || at(TK.STRING)) break;
      out.push(parseOneTarget());
    }
    return out;
  }

  /** Parse one target clause: `context [. dotPath] [= transform] [as alias]` or `(expr) as alias`. */
  function parseOneTarget() {
    // Parenthesized FHIRPath expression as target: `(expr) as alias`
    if (at(TK.LPAREN)) {
      advance();
      let depth = 1;
      let exprParts = [];
      while (depth > 0 && !at(TK.EOF)) {
        if (at(TK.LPAREN)) depth++;
        if (at(TK.RPAREN)) { depth--; if (depth === 0) break; }
        const tk = advance();
        if (tk.kind === TK.STRING) exprParts.push("'" + tk.value + "'");
        else if (tk.kind === TK.DOT) exprParts.push('.');
        else if (tk.kind === TK.COMMA) exprParts.push(', ');
        else if (tk.kind === TK.COLON) exprParts.push(':');
        else if (tk.kind === TK.EQ) exprParts.push(' = ');
        else if (tk.kind === TK.NEQ) exprParts.push(' != ');
        else if (tk.kind === TK.LPAREN) exprParts.push('(');
        else if (tk.kind === TK.RPAREN) exprParts.push(')');
        else if (tk.kind === TK.PIPE) exprParts.push(' | ');
        else exprParts.push(tk.value);
      }
      expect(TK.RPAREN);
      const tgt = { context: null, path: null, alias: null, transform: null, fhirpathExpr: exprParts.join('').trim() };
      if (atWord('as')) { advance(); tgt.alias = expect(TK.WORD).value; }
      return tgt;
    }

    const tgt = { context: expect(TK.WORD).value, path: null, alias: null, transform: null };
    // Bare transform call as target: `create('CareTeam') as vt0`
    if (at(TK.LPAREN)) {
      tgt.transform = parseTransformFromName(tgt.context);
      tgt.context = null;
      if (atWord('as')) { advance(); tgt.alias = expect(TK.WORD).value; }
      return tgt;
    }
    if (at(TK.DOT))   { advance(); tgt.path = parseDotPath(); }
    if (at(TK.EQ))    { advance(); tgt.transform = parseTransform(); }
    if (atWord('as')) { advance(); tgt.alias = expect(TK.WORD).value; }
    return tgt;
  }

  /**
   * Parse a transform expression on the RHS of a target `=`:
   *   - `'literal'`           -> { fn: 'literal', args: ['literal'] }
   *   - `varName`             -> { fn: 'varRef',  args: ['varName'] }
   *   - `funcName(arg1, ...)` -> { fn: 'funcName', args: [TransformArg...] }
   *
   * Args are tagged with `kind: 'literal' | 'ident'` so the runtime can
   * tell quoted strings from variable references without re-parsing.
   */
  function parseTransform() {
    if (at(TK.STRING)) return { fn: 'literal', args: [advance().value] };

    // Parenthesized FHIRPath expression as transform value: `(expr)`
    if (at(TK.LPAREN)) {
      advance();
      let depth = 1;
      let exprParts = [];
      while (depth > 0 && !at(TK.EOF)) {
        if (at(TK.LPAREN)) depth++;
        if (at(TK.RPAREN)) { depth--; if (depth === 0) break; }
        const tk = advance();
        if (tk.kind === TK.STRING) exprParts.push("'" + tk.value + "'");
        else if (tk.kind === TK.DOT) exprParts.push('.');
        else if (tk.kind === TK.COMMA) exprParts.push(', ');
        else if (tk.kind === TK.COLON) exprParts.push(':');
        else if (tk.kind === TK.EQ) exprParts.push(' = ');
        else if (tk.kind === TK.NEQ) exprParts.push(' != ');
        else if (tk.kind === TK.LPAREN) exprParts.push('(');
        else if (tk.kind === TK.RPAREN) exprParts.push(')');
        else if (tk.kind === TK.SEMI) exprParts.push(';');
        else if (tk.kind === TK.PIPE) exprParts.push(' | ');
        else exprParts.push(tk.value);
      }
      expect(TK.RPAREN);
      return { fn: 'fhirpath', args: [exprParts.join('').trim()] };
    }

    const name = expect(TK.WORD).value;
    if (!at(TK.LPAREN)) return { fn: 'varRef', args: [name] };
    advance();
    const args = [];
    while (!at(TK.RPAREN) && !at(TK.EOF)) {
      if (at(TK.STRING))    args.push({ kind: 'literal', value: advance().value });
      else if (at(TK.WORD)) args.push({ kind: 'ident',   value: advance().value });
      if (at(TK.COMMA)) advance();
    }
    expect(TK.RPAREN);
    return { fn: name, args };
  }

  /** Parse a transform when the function name has already been consumed. */
  function parseTransformFromName(name) {
    advance(); // consume LPAREN
    const args = [];
    while (!at(TK.RPAREN) && !at(TK.EOF)) {
      if (at(TK.STRING))    args.push({ kind: 'literal', value: advance().value });
      else if (at(TK.WORD)) args.push({ kind: 'ident',   value: advance().value });
      if (at(TK.COMMA)) advance();
    }
    expect(TK.RPAREN);
    return { fn: name, args };
  }

  /** Parse `GroupName(arg1, arg2, ...)` used in `then` clauses. */
  function parseInvocation() {
    const name = expect(TK.WORD).value;
    expect(TK.LPAREN);
    const args = [];
    while (!at(TK.RPAREN) && !at(TK.EOF)) {
      args.push(expect(TK.WORD).value);
      if (at(TK.COMMA)) advance();
    }
    expect(TK.RPAREN);
    return { name, args };
  }
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
  strict          = false,
  fromVer         = null,
  toVer           = null,
  onWarning       = null,
  onInfo          = null,
  onRuleExec      = null,
} = {}) {
  const ast        = parseFml(fmlText, onWarning);
  const groups     = ast.groups;
  const translator = makeTranslator(conceptMaps, { strict: strict || false, onWarning, onInfo });

  /**
   * Resolve one TransformArg against the current scope.
   *   - `kind: 'literal'` -> return the literal string.
   *   - `kind: 'ident'`   -> look up in scope; if absent, warn and fall
   *                          back to the bare word.
   */
  function resolveArg(arg, scope) {
    if (arg.kind === 'literal') return arg.value;
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
        if (scope.has(name)) return deepClone(scope.get(name));
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
        try {
          // Build context from scope -- use the first source alias if available
          const context = scope.has('src') ? scope.get('src') : {};
          // Replace %varName references with scope values in a simple env
          const env = {};
          const result = fhirpathLib.evaluate(context, expr, env);
          if (Array.isArray(result) && result.length === 1) return result[0];
          if (Array.isArray(result) && result.length === 0) return undefined;
          return result;
        } catch (e) {
          onWarning?.(`FHIRPath transform evaluation failed for "${expr}": ${e.message}`);
          return undefined;
        }
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
      try {
        // Resolve context: try the primary source alias or $this
        let context = null;
        if (scope.has('$this')) context = scope.get('$this');
        // Build environment with all scope variables
        const env = {};
        // fhirpath.js supports $this via the context parameter
        if (context == null) context = {};
        const result = fhirpathLib.evaluate(context, guard.fhirpath, env);
        // FHIRPath truthy: non-empty collection, not [false]
        if (Array.isArray(result)) {
          if (result.length === 0) return false;
          if (result.length === 1 && result[0] === false) return false;
          return true;
        }
        return result != null && result !== false;
      } catch (e) {
        onWarning?.(`FHIRPath evaluation failed for guard "${guard.fhirpath}": ${e.message}; treating as true`);
        return true;
      }
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
   * Returns `{ctx, value, polyName}`; `polyName` flows through to
   * `writeTarget` so the corresponding typed variant on the target is
   * written instead of the bare path.
   */
  function readSource(srcSpec, scope, trailingString) {
    const ctx = scope.get(srcSpec.context);
    if (ctx == null) return { ctx: null, value: undefined, polyName: null };

    if (!srcSpec.path) return { ctx, value: ctx, polyName: null };

    if (srcSpec.typeHint) {
      const segs   = srcSpec.path.split('.');
      const parent = segs.length > 1 ? getPath(ctx, segs.slice(0, -1).join('.')) : ctx;
      const root   = segs[segs.length - 1];
      const polyName = trailingString || (root + cap(srcSpec.typeHint));
      const value  = parent ? parent[polyName] : undefined;
      if (parent != null && value === undefined) {
        onInfo?.(`readSource: polymorphic field "${polyName}" not present (typeHint=${srcSpec.typeHint})`);
      }
      return { ctx, value, polyName };
    }

    return { ctx, value: getPath(ctx, srcSpec.path), polyName: null };
  }

  /**
   * Write a value into the target context at `tgtSpec.path`.
   *
   * If `polyName` is provided (because the matched source was polymorphic),
   * the last path segment is replaced by `polyName`; so `tgt.value` with
   * polyName `valueBoolean` writes to `tgt.valueBoolean`.
   *
   * Warns when the target context is missing or when a non-object value
   * would be assigned to a bare context (no path); both indicate a likely
   * FML/data mismatch.
   */
  function writeTarget(tgtSpec, value, scope, polyName) {
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
    if (polyName) {
      const segs = path.split('.');
      segs[segs.length - 1] = polyName;
      path = segs.join('.');
    }

    const { parent, key } = ensurePath(tctx, path);
    parent[key] = value;
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

    // Run extends-base copier first (for inheritance chains).
    if (g.extendsType) {
      const srcObj = paramValues[0];
      const tgtObj = paramValues[1];
      if (BASE_COPIERS[g.extendsType]) {
        if (isObject(srcObj) && isObject(tgtObj)) {
          BASE_COPIERS[g.extendsType](srcObj, tgtObj);
        } else {
          onWarning?.(`Group "${groupName}" extends ${g.extendsType} but src/tgt are not both objects; skipping base copy`);
        }
      } else if (groups.has(g.extendsType)) {
        execGroup(g.extendsType, paramValues, parentScope);
      } else {
        onWarning?.(`Group "${groupName}" extends unknown type "${g.extendsType}"`);
      }
    }

    const scope = parentScope ? parentScope.child() : new Scope();
    for (let i = 0; i < g.params.length; i++) {
      scope.set(g.params[i].alias, paramValues[i]);
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
      const { ctx, value, polyName } = readSource(srcSpec, scope, rule.trailingString);
      if (ctx == null)   return;
      if (value == null) return;
      bindings.push({ spec: srcSpec, ctx, value, polyName });
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
    for (const b of bindings) {
      if (b.spec.alias) ruleScope.set(b.spec.alias, b.value);
    }

    if (!evalGuard(primary.spec.where, ruleScope)) return;
    if (primary.spec.check && !evalGuard(primary.spec.check, ruleScope)) {
      onWarning?.(`check failed (${primary.spec.alias || primary.spec.path})`);
    }

    if (thenGroup || thenRules) {
      if (!isObject(primaryValue)) {
        onWarning?.(`then-clause invoked on non-object source value (type=${typeof primaryValue}); skipping`);
        return;
      }

      // Category 3: source-level then without targets (e.g. `src.field as v then Group(v, tgt)`)
      if (targets.length === 0) {
        if (thenGroup) {
          const argValues = resolveInvocationArgs(thenGroup, ruleScope, [primaryValue]);
          execGroup(thenGroup.name, argValues, ruleScope);
        } else if (thenRules) {
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

      const child = {};
      if (tgtSpec.alias) ruleScope.set(tgtSpec.alias, child);

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

      if (tgtSpec.path) {
        const { parent, key } = ensurePath(tctx, tgtSpec.path);
        parent[key] = child;
      } else {
        Object.assign(tctx, child);
      }
      return;
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
        const child = {};
        if (tgtSpec.alias) iterScope.set(tgtSpec.alias, child);

        if (thenGroup) {
          const argValues = resolveInvocationArgs(thenGroup, iterScope, [item, child]);
          execGroup(thenGroup.name, argValues, iterScope);
        } else {
          const subScope = iterScope.child();
          subScope.set(tgtSpec.context, child);
          for (const sr of thenRules) execRule(sr, subScope);
        }
        results.push(child);
      } else {
        // No then-clause: each iteration produces one scalar value.
        const v = computeTargetValue(tgtSpec, primary, bindings, iterScope, item);
        if (v !== undefined) results.push(v);
      }
    }

    if (results.length === 0) return;
    if (!tgtSpec.path) {
      onWarning?.(`Array rule: no target path; cannot write ${results.length} item(s)`);
      return;
    }
    const { parent, key } = ensurePath(tctx, tgtSpec.path);
    parent[key] = results;
  }

  /**
   * Apply one target clause within a scalar rule: compute the value, find
   * the right polymorphic variant name (if any), and write it.
   *
   * polyName selection: if the target has an alias matching a source alias,
   * use that source's polyName; otherwise inherit from the primary source.
   */
  function applyTarget(tgt, primary, bindings, scope) {
    const value = computeTargetValue(tgt, primary, bindings, scope, primary.value);
    if (value === undefined) return;

    let polyName = null;
    if (tgt.alias) {
      const m = bindings.find(b => b.spec.alias === tgt.alias);
      if (m) polyName = m.polyName;
    } else {
      polyName = primary.polyName;
    }

    writeTarget(tgt, value, scope, polyName);
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
      if (match) return deepClone(match.value);
    }
    return deepClone(iterValue);
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
  function convert({ input, entryGroup } = {}) {
    if (!isObject(input)) throw new Error('Input must be a JSON object');
    const group = entryGroup || input.resourceType;
    if (!group) throw new Error('entryGroup is required when input has no resourceType');

    const out = {};
    if (input.resourceType) out.resourceType = input.resourceType;

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

  // --- meta.profile version helpers ---

  /** Matches `http://hl7.org/fhir/X.Y/StructureDefinition/...` */
  const FHIR_BASE_PROFILE_RE = /^http:\/\/hl7\.org\/fhir\/[\d.]+\/StructureDefinition\/.+$/;

  /** Version label -> FHIR version number used in profile URLs. */
  const VER_TO_FHIR = { R2: '1.0', R3: '3.0', R4: '4.0', R4B: '4.3', R5: '5.0' };

  const srcVerNum = VER_TO_FHIR[fromVer];
  const tgtVerNum = VER_TO_FHIR[toVer];

  function isSourceVersionProfile(url) {
    return srcVerNum && url.includes(`/fhir/${srcVerNum}/StructureDefinition/`);
  }

  function toTargetVersionProfile(url) {
    if (!tgtVerNum) return url;
    return url.replace(`/fhir/${srcVerNum}/`, `/fhir/${tgtVerNum}/`);
  }

  return {
    metadata: ast.metadata,
    uses:     ast.uses,
    groups:   [...groups.keys()],
    convert,
  };
}

