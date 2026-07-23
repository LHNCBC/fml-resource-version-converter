/**
 * @fileoverview FHIR Mapping Language (FML) front-end: tokeniser + parser.
 *
 * Pure text-to-AST module with no runtime state. Given FML source text,
 * `parseFml(text, onWarning?)` returns a structured AST that the engine
 * (`fml_xver_engine.js`) consumes. Splitting the front-end from the
 * runtime keeps each side focused: this module handles syntax; the
 * engine handles semantics and execution.
 *
 *   tokenise(text) -> Token[]
 *   parseFml(text) -> Ast { metadata, uses, groups }
 *
 * Diagnostics: tokeniser failures (unrecognised characters, unterminated
 * strings) emit warnings rather than throwing, so a malformed file still
 * produces a stream the parser can attempt. The parser is permissive at
 * the top level (warns and skips unknown tokens) but strict inside rules
 * and groups -- a malformed rule silently mis-executing later is worse
 * than a clear parse failure with a line number.
 *
 * ----- AST shape ----------------------------------------------------------
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
 * @property {string[]}    annotations  FML group annotations captured from
 *                                      `<<...>>` (e.g. `['types']`,
 *                                      `['type+']`). Empty array when none.
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
 * @property {GuardExpr|null} log       `log (...)` clause. Diagnostic only:
 *                                      per the FML spec its evaluated result
 *                                      is a log message; it does not affect
 *                                      the transformation. Parsed and stored
 *                                      but not executed.
 * @property {'first'|'last'|'not_first'|'not_last'|'only_one'|null} listMode
 *
 * @typedef {Object} Target
 * @property {string}         context    Variable name in scope (e.g. 'tgt').
 * @property {string|null}    path       Dot-path on context.
 * @property {string|null}    alias      Bound name from `as X`.
 * @property {Transform|null} transform  RHS expression after `=`, if any.
 * @property {'first'|'last'|'single'|'share'|'collate'} [listMode]  Target
 *                                       list mode from the FML grammar's
 *                                       targetListMode (e.g. `tgt.x as t first`).
 * @property {string} [shareVar]         Variable name captured for `share`
 *                                       mode (`... share var`).
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
 * @module fml_base_conv/fml_parser
 */

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
  TYPE_ANNOT: 'TYPE_ANNOT',
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
 * comments. Captures `<<...>>` annotations (e.g. `<<types>>`, `<<type+>>`)
 * as TYPE_ANNOT tokens with the inner content trimmed; the parser
 * attaches these to their owning group.
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
export function tokenise(text, onWarning) {
  const tokens = [];
  let i = 0, line = 1;
  // `start` captures the character offset (in `text`) of the first
  // character of the next token to be emitted. Parser consumers use
  // these offsets to recover the original source substring for
  // FHIRPath expressions, where lossy token-level reconstruction has
  // historically dropped escapes and whitespace around word operators.
  let start = 0;
  const push = (kind, value) => tokens.push({ kind, value, line, start, end: i });

  while (i < text.length) {
    const c = text[i], c2 = text[i + 1], c3 = text[i + 2];

    // --- Whitespace ---
    if (c === '\n')                 { line++; i++; start = i; continue; }
    if (c === '\r' || /\s/.test(c)) { i++; start = i; continue; }

    // --- /// metadata comment ---
    if (c === '/' && c2 === '/' && c3 === '/') {
      i += 3;
      let s = '';
      while (i < text.length && text[i] !== '\n') s += text[i++];
      push(TK.META, s.trim());
      start = i;
      continue;
    }
    // --- // line comment ---
    if (c === '/' && c2 === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      start = i;
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
      start = i;
      continue;
    }

    // --- Multi-char operators ---
    if (c === '-' && c2 === '>') { i += 2; push(TK.ARROW, '->'); start = i; continue; }
    if (c === '!' && c2 === '=') { i += 2; push(TK.NEQ, '!=');  start = i; continue; }

    // --- <<...>> type annotation: capture inner content as TYPE_ANNOT ---
    if (c === '<' && c2 === '<') {
      i += 2;
      let s = '';
      while (i < text.length && !(text[i] === '>' && text[i + 1] === '>')) {
        if (text[i] === '\n') line++;
        s += text[i++];
      }
      if (i >= text.length) {
        onWarning?.(`Tokenizer: unterminated <<...>> annotation starting near line ${line}`);
      } else {
        i += 2; // consume closing >>
      }
      push(TK.TYPE_ANNOT, s.trim());
      start = i;
      continue;
    }

    // --- Single-char tokens ---
    if (SINGLE_CHAR[c]) { i++; push(SINGLE_CHAR[c], c); start = i; continue; }

    // Stray annotation noise like '+' (used as `<<type+>>` inner content,
    // already handled above; left in for safety on malformed files).
    if (c === '<' || c === '>' || c === '+') { i++; start = i; continue; }

    // --- Backtick-delimited identifier (FHIRPath): `div`, `where`, ... ---
    // FHIRPath (and thus FML paths) allow an identifier that collides with a
    // reserved word or contains special characters to be delimited with
    // backticks. We emit the inner text as a plain WORD so downstream path
    // navigation sees the real field name. (Backticks inside parenthesised
    // FHIRPath expressions are already preserved verbatim and handed to
    // fhirpath.js; this covers the bare-path case.)
    if (c === '`') {
      i++;
      let s = '';
      while (i < text.length && text[i] !== '`') {
        if (text[i] === '\\') { i++; s += text[i++] ?? ''; continue; }
        if (text[i] === '\n') line++;
        s += text[i++];
      }
      if (i >= text.length) {
        onWarning?.(`Tokenizer: unterminated backtick identifier starting near line ${line}`);
      }
      i++; // consume closing backtick
      push(TK.WORD, s);
      start = i;
      continue;
    }

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
      start = i;
      continue;
    }

    // --- Numeric literal (captured as WORD for uniform handling) ---
    if (/[0-9]/.test(c)) {
      let n = '';
      while (i < text.length && /[0-9.]/.test(text[i])) n += text[i++];
      push(TK.WORD, n);
      start = i;
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
      start = i;
      continue;
    }

    onWarning?.(`Tokenizer: skipping unrecognised character ${JSON.stringify(c)} at line ${line}`);
    i++;
    start = i;
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
export function parseFml(fmlText, onWarning) {
  const text   = fmlText;
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

  /**
   * Parse `group Name(params) [extends Y] [<<annot>>...] { rules }`.
   * Captures any number of `<<...>>` annotations (e.g. `<<types>>`,
   * `<<type+>>`) into the Group's `annotations` array.
   */
  function parseGroup() {
    expect(TK.WORD, 'group');
    const name = expect(TK.WORD).value;
    expect(TK.LPAREN);
    const params = parseParamList();
    expect(TK.RPAREN);

    let extendsType = null;
    if (atWord('extends')) { advance(); extendsType = expect(TK.WORD).value; }

    // Collect <<...>> annotations and skip any other stray annotation words
    // until the opening `{`.
    const annotations = [];
    while (!at(TK.LBRACE) && !at(TK.EOF)) {
      if (at(TK.TYPE_ANNOT)) {
        annotations.push(advance().value);
      } else if (at(TK.WORD)) {
        advance();
      } else {
        break;
      }
    }

    expect(TK.LBRACE);
    const rules = [];
    while (!at(TK.RBRACE) && !at(TK.EOF)) rules.push(parseRule());
    expect(TK.RBRACE);

    return { name, params, extendsType, rules, annotations };
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
   *   context [. dotPath] [: TypeHint] [listMode] [as alias] [where (...)] [check (...)] [log (...)]
   */
  function parseOneSource() {
    const src = {
      context: expect(TK.WORD).value,
      path: null, alias: null, typeHint: null,
      where: null, check: null, log: null, listMode: null,
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
    // `log (...)` -- diagnostic only per the FML spec; parsed so it does not
    // mis-terminate the source clause, but not executed (no output effect).
    if (atWord('log'))   { advance(); src.log = parseGuardExpr(); }
    return src;
  }

  /** Parse a dot-separated identifier chain like `item.enableWhen.question`. */
  function parseDotPath() {
    let p = expect(TK.WORD).value;
    while (at(TK.DOT)) { advance(); p += '.' + expect(TK.WORD).value; }
    return p;
  }

  /**
   * Consume a balanced parenthesised expression starting at the current
   * `(` token and return the original FML source substring inside it
   * (trimmed, without the outer parens). The exact bytes are preserved
   * - whitespace, string escapes, and word-operator spacing - which is
   * essential when handing the substring to fhirpath.js: lossy token-
   * level reconstruction historically dropped backslash escapes
   * (`'\n'` -> `'n'`) and merged adjacent identifiers across word
   * operators (`vs in (...)` -> `vsin(...)`).
   *
   * Assumes `peek().kind === TK.LPAREN`. Consumes the matching closing
   * `)` on success.
   */
  function captureBalancedParenText() {
    const openTok = advance(); // consume opening LPAREN
    const startOffset = openTok.end;
    let depth = 1;
    while (depth > 0 && !at(TK.EOF)) {
      const t = peek();
      if (t.kind === TK.LPAREN) depth++;
      else if (t.kind === TK.RPAREN) {
        depth--;
        if (depth === 0) {
          const endOffset = t.start;
          advance(); // consume closing RPAREN
          return text.slice(startOffset, endOffset).trim();
        }
      }
      advance();
    }
    // Unbalanced; return what we have so the caller can still continue.
    return text.slice(startOffset).trim();
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

      // Complex expression: capture original source text byte-for-byte.
      return { fhirpath: captureBalancedParenText() };
    }
    // Bare string literal as the whole expression (valid FHIRPath), e.g.
    // `log 'message'` or `check 'note'`. Re-wrap it as a FHIRPath string
    // literal so where/check/log evaluate it consistently instead of the
    // parser throwing on the unexpected STRING token.
    if (at(TK.STRING)) {
      const s = advance().value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      return { fhirpath: `'${s}'` };
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

  /** Parse one target clause: `context [. dotPath] [= transform] [as alias] [listMode]` or `(expr) as alias`. */
  function parseOneTarget() {
    // Parenthesized FHIRPath expression as target: `(expr) as alias`
    if (at(TK.LPAREN)) {
      const fhirpathExpr = captureBalancedParenText();
      const tgt = { context: null, path: null, alias: null, transform: null, fhirpathExpr };
      if (atWord('as')) { advance(); tgt.alias = expect(TK.WORD).value; }
      return parseTargetListMode(tgt);
    }

    const tgt = { context: expect(TK.WORD).value, path: null, alias: null, transform: null };
    // Bare transform call as target: `create('CareTeam') as vt0`
    if (at(TK.LPAREN)) {
      tgt.transform = parseTransformFromName(tgt.context);
      tgt.context = null;
      if (atWord('as')) { advance(); tgt.alias = expect(TK.WORD).value; }
      return parseTargetListMode(tgt);
    }
    if (at(TK.DOT))   { advance(); tgt.path = parseDotPath(); }
    if (at(TK.EQ))    { advance(); tgt.transform = parseTransform(); }
    if (atWord('as')) { advance(); tgt.alias = expect(TK.WORD).value; }
    return parseTargetListMode(tgt);
  }

  /**
   * Capture an optional target list mode keyword following a target clause,
   * per the FML grammar's targetListMode: `first | last | single | share |
   * collate`. `share` is followed by a variable name. Recognising these
   * keeps the parser from mis-reading `tgt.x as t first, ...` (where the
   * bare `first` token previously terminated the target list and was then
   * mis-consumed as the next rule's source context). Stores the mode on
   * `tgt.listMode` (and the variable on `tgt.shareVar` for `share`).
   *
   * @param {Object} tgt  The target node being built.
   * @returns {Object}    The same target node, for chaining.
   */
  function parseTargetListMode(tgt) {
    if (atWord('first') || atWord('last') || atWord('single') ||
        atWord('share') || atWord('collate')) {
      tgt.listMode = advance().value;
      if (tgt.listMode === 'share' && at(TK.WORD)) tgt.shareVar = advance().value;
    }
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
      return { fn: 'fhirpath', args: [captureBalancedParenText()] };
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

