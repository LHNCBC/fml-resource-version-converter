/**
 * @fileoverview ValueSet postprocessors for the R3 <-> R4 version pair.
 *
 * STU3 and R4 share every ValueSet element except STU3's `ValueSet.extensible`,
 * and both bind `compose.include.filter.op` to the same nine FilterOperator
 * codes. The remaining differences are narrow but real, and the FML carries
 * most of them through without a diagnostic.
 *
 * R3 -> R4 (report only):
 * - `ValueSet.extensible` has no native R4 representation. The FML does not
 *   discard it outright: it stores it as the inter-version extension
 *   `http://hl7.org/fhir/3.0/StructureDefinition/extension-ValueSet.extensible`.
 *   General R4 tools are not required to understand inter-version extensions,
 *   though, so a value that survives only there counts as lost and is reported
 *   as such. The extension is left in place for consumers that do read it.
 * - R4 adds the warning-severity invariant `vsd-0` (name must be usable as a
 *   machine-processing identifier); STU3 has no such rule, so an STU3-valid
 *   name can trip it. Reported, never rewritten: `name` identifies the
 *   resource and changing it would break references to it.
 *
 * R4 -> R3 (repair + report):
 * - `compose.include.filter.value` narrows from R4 `string` to STU3 `code`, so
 *   whitespace is normalized. A whitespace-only value cannot become a code at
 *   all; since `filter.value` is 1..1, the whole filter is removed so the
 *   output stays valid STU3.
 * - `compose.include.valueSet` narrows from R4 `canonical` to STU3 `uri`. A
 *   `|version` suffix would not resolve in STU3 and is stripped, preserving any
 *   `#fragment` that follows it.
 * - `expansion.identifier` is 0..1 in R4 but 1..1 in STU3, so a missing one is
 *   generated to keep the expansion valid.
 * - `expansion.parameter.valueDateTime` has no STU3 equivalent (STU3 omits
 *   `dateTime` from the `value[x]` type set, and the mapping comments the rule
 *   out). The FML drops the value and keeps the rest of the parameter (`name`,
 *   plus any `id`/`extension`); since `value[x]` is 0..1 in STU3 that remains
 *   valid, so the loss is reported without further mutation.
 * - STU3's `vsd-5` requires a compose or an expansion; R4 has no such rule. A
 *   metadata-only R4 ValueSet is therefore valid input that would convert to
 *   invalid STU3, so an empty expansion is generated and the approximation of
 *   undefined membership as empty is reported.
 *
 * Inter-version extensions are otherwise out of scope.
 *
 * @module postprocessors/R3_R4/ValueSet
 */
import { randomUUID } from 'node:crypto';
import { COVERAGE } from '../../converter/coverage.js';
import {
  statusFromMessages,
  warningMessage,
} from '../../converter/diagnostics.js';
import {
  hasAnyContent,
  stripCanonicalVersion,
} from '../util/elements.js';

// STU3 defines `code` as "a string which has at least one character and no
// leading or trailing whitespace and where there is no whitespace other than
// single spaces in the contents". The published regex ([^\s]+([\s]?[^\s]+)*) is
// looser than that prose - it would admit a tab as a separator - so this
// follows the stricter definition: any whitespace run becomes a single space.
const VALID_CODE = /^[^\s]+( [^\s]+)*$/;

// R4 invariant vsd-0 (severity: warning):
// name.matches('[A-Z]([A-Za-z0-9_]){0,254}'). STU3 imposes no such rule.
const VSD_0_NAME = /^[A-Z][A-Za-z0-9_]{0,254}$/;

// Where the FML parks STU3's extensible flag on the R4 side. Named in the
// diagnostic so a caller that does read inter-version extensions can find it.
const EXTENSIBLE_IVE =
  'http://hl7.org/fhir/3.0/StructureDefinition/extension-ValueSet.extensible';

/**
 * Collect every compose include/exclude entry present on a ValueSet.
 *
 * @param {Object|undefined} valueSet ValueSet whose compose entries are wanted.
 * @returns {Array<[string, number, Object]>} [branch, index, entry] triples.
 */
function composeEntries(valueSet) {
  const entries = [];

  for (const branch of ['include', 'exclude']) {
    const branchEntries = valueSet?.compose?.[branch];
    if (!Array.isArray(branchEntries)) continue;
    for (const [index, entry] of branchEntries.entries()) {
      if (entry && typeof entry === 'object') entries.push([branch, index, entry]);
    }
  }

  return entries;
}

/**
 * Normalize one compose entry's filter values into lexically valid STU3 codes.
 *
 * Collapsing whitespace is the smallest edit that yields a valid `code` while
 * preserving the tokens the filter matches on. A value that is only whitespace
 * has no tokens to keep, and `filter.value` is 1..1, so the filter itself is
 * removed rather than left invalid.
 *
 * @param {Object} entry Target compose include/exclude entry, mutated in place.
 * @param {string} branch Compose branch containing the entry.
 * @param {number} entryIndex Entry index within the branch.
 * @param {Array<Object>} messages Diagnostic messages to append.
 */
function normalizeFilterValues(entry, branch, entryIndex, messages) {
  if (!Array.isArray(entry.filter)) return;

  const kept = [];

  for (const [filterIndex, filter] of entry.filter.entries()) {
    const original = filter?.value;
    if (typeof original !== 'string' || VALID_CODE.test(original)) {
      kept.push(filter);
      continue;
    }

    const path =
      `ValueSet.compose.${branch}[${entryIndex}].filter[${filterIndex}].value`;
    const normalized = original.trim().replace(/\s+/g, ' ');

    if (normalized === '') {
      messages.push(warningMessage(
        `${path} is empty or whitespace-only and cannot be represented as an `
        + 'STU3 code; the filter was removed to keep the output valid, so the '
        + `converted ValueSet may ${branch === 'include' ? 'include' : 'exclude'} `
        + 'additional concepts',
      ));
      continue;
    }

    filter.value = normalized;
    kept.push(filter);
    messages.push(warningMessage(
      `${path} "${original}" is valid as an R4 string but not as an STU3 code; `
      + `whitespace was normalized to "${normalized}"`,
    ));
  }

  if (kept.length === entry.filter.length) return;
  if (kept.length === 0) delete entry.filter;
  else entry.filter = kept;
}

/**
 * Strip canonical `|version` suffixes from one compose entry's valueSet refs.
 *
 * STU3 types this element as `uri` and has no canonical-version concept, so a
 * pinned reference would not resolve. Dropping the suffix yields a resolvable
 * reference at the cost of the version pin.
 *
 * @param {Object} entry Target compose include/exclude entry, mutated in place.
 * @param {string} branch Compose branch containing the entry.
 * @param {number} entryIndex Entry index within the branch.
 * @param {Array<Object>} messages Diagnostic messages to append.
 */
function stripValueSetVersions(entry, branch, entryIndex, messages) {
  if (!Array.isArray(entry.valueSet)) return;

  for (const [refIndex, reference] of entry.valueSet.entries()) {
    if (typeof reference !== 'string' || !reference.includes('|')) continue;

    const stripped = stripCanonicalVersion(reference);
    entry.valueSet[refIndex] = stripped;
    messages.push(warningMessage(
      `ValueSet.compose.${branch}[${entryIndex}].valueSet[${refIndex}] `
      + `"${reference}" pins a canonical version, which STU3 cannot express; `
      + `the version was dropped, leaving "${stripped}"`,
    ));
  }
}

/**
 * Give the converted expansion the identifier STU3 requires.
 *
 * R4 types `expansion.identifier` as 0..1 but STU3 as 1..1, so an expansion
 * that arrived without one would be invalid. The identifier only labels this
 * expansion instance, so generating one loses nothing.
 *
 * @param {Object} target FML-converted STU3 ValueSet, mutated in place.
 * @param {Array<Object>} messages Diagnostic messages to append.
 */
function ensureExpansionIdentifier(target, messages) {
  const expansion = target?.expansion;
  if (!expansion || typeof expansion !== 'object' || Array.isArray(expansion)) return;
  if (hasAnyContent(expansion, ['identifier', '_identifier'])) return;

  const generated = `urn:uuid:${randomUUID()}`;
  expansion.identifier = generated;
  messages.push(warningMessage(
    'ValueSet.expansion.identifier is optional in R4 but required in STU3; '
    + `the source had none, so "${generated}" was generated to keep the `
    + 'expansion valid',
  ));
}

/**
 * Report R4 expansion parameters whose dateTime value STU3 cannot carry.
 *
 * @param {Object|undefined} source R4 ValueSet source (read-only).
 * @param {Array<Object>} messages Diagnostic messages to append.
 */
function reportDateTimeParameters(source, messages) {
  const parameters = source?.expansion?.parameter;
  if (!Array.isArray(parameters)) return;

  for (const [index, parameter] of parameters.entries()) {
    if (!hasAnyContent(parameter, ['valueDateTime', '_valueDateTime'])) continue;

    const name = parameter?.name ?? '(unnamed)';
    messages.push(warningMessage(
      `ValueSet.expansion.parameter[${index}] "${name}" carries valueDateTime, `
      + 'which STU3 has no equivalent for; the value was dropped and the '
      + 'parameter is retained without a value',
    ));
  }
}

/**
 * Give the converted ValueSet the compose or expansion STU3 requires (vsd-5).
 *
 * R4 imposes no such rule, so a metadata-only R4 ValueSet is valid input that
 * would otherwise convert to invalid STU3. A compose cannot be synthesized
 * (STU3 `compose.include` is 1..*, and any include would invent membership
 * criteria), but an expansion carrying only its two required elements is valid
 * and states the least: the value set expanded to no concepts. That is an
 * approximation of undefined membership, so it is reported.
 *
 * @param {Object} target FML-converted STU3 ValueSet, mutated in place.
 * @param {Array<Object>} messages Diagnostic messages to append.
 */
function ensureComposeOrExpansion(target, messages) {
  if (hasAnyContent(target, ['compose', 'expansion'])) return;

  const identifier = `urn:uuid:${randomUUID()}`;
  target.expansion = { identifier, timestamp: new Date().toISOString() };
  messages.push(warningMessage(
    'STU3 requires a ValueSet to carry a compose or an expansion (vsd-5) but '
    + 'the R4 source has neither; an empty expansion was generated to keep the '
    + `output valid (identifier "${identifier}"), which approximates the value `
    + 'set\'s undefined membership as empty',
  ));
}

/*
 * FML limitations reported (R3 -> R4):
 * - ValueSet.extensible has no native R4 element. The mapping relegates it to
 *   an inter-version extension without any diagnostic; since general R4 tools
 *   need not understand those, the value is reported as lost.
 * - R4's warning-severity vsd-0 invariant has no STU3 counterpart, so an
 *   STU3-valid name may trip it. Reported, not rewritten.
 */

/**
 * R3 -> R4 ValueSet postprocessor descriptor.
 *
 * Report-only. `extensible` cannot be carried into R4 in any form a general
 * tool must understand, so the conversion is BEST_EFFORT rather than complete.
 */
export const conv_R3_to_R4 = {
  name: 'ValueSet_R3_to_R4',
  coverage: COVERAGE.BEST_EFFORT,
  description:
    'Reports STU3 ValueSet.extensible, which R4 can hold only as an '
    + 'inter-version extension and which general R4 tools are therefore not '
    + 'required to understand, and reports a name that does not satisfy R4\'s '
    + 'warning-severity vsd-0 invariant. Makes no changes.',

  /**
   * @param {Object} target FML-converted R4 ValueSet (not mutated).
   * @param {Object} ctx Hop context with sourceResource, fromVer, and toVer.
   * @returns {{resource: Object, status: string, messages: Array<Object>}} Result.
   */
  execute(target, ctx) {
    const messages = [];
    const sourceVersion = ctx?.fromVer || 'R3';
    const targetVersion = ctx?.toVer || 'R4';
    const name = target?.name;

    if (hasAnyContent(ctx?.sourceResource, ['extensible', '_extensible'])) {
      messages.push(warningMessage(
        `${sourceVersion}-only ValueSet content has no native ${targetVersion} `
        + 'representation and should be treated as lost: ValueSet.extensible. '
        + `The FML kept it as the inter-version extension ${EXTENSIBLE_IVE}, `
        + `which general ${targetVersion} tools are not required to understand`,
      ));
    }

    if (typeof name === 'string' && !VSD_0_NAME.test(name)) {
      messages.push(warningMessage(
        `ValueSet.name "${name}" does not satisfy ${targetVersion} invariant `
        + 'vsd-0 (name should be usable as an identifier for machine '
        + 'processing); STU3 does not impose this rule. The name was left '
        + 'unchanged because it identifies the resource',
      ));
    }

    return { resource: target, status: statusFromMessages(messages), messages };
  },
};

/*
 * FML limitations reported (R4 -> R3):
 * - compose.include.filter.value (string -> code) and compose.include.valueSet
 *   (canonical -> uri) are copied verbatim, so an R4-valid value can land in
 *   STU3 as an invalid code or an unresolvable reference. Both are corrected.
 * - expansion.identifier is not supplied when the source omits it, although
 *   STU3 requires it. One is generated.
 * - expansion.parameter.valueDateTime has no STU3 type; the mapping comments
 *   the rule out, so the value is dropped and the loss is reported.
 * - A source with neither compose nor expansion violates STU3 vsd-5; an empty
 *   expansion is generated so the output is valid, and the approximation is
 *   reported.
 */

/**
 * R4 -> R3 ValueSet postprocessor descriptor.
 *
 * Repairs the narrowings that would otherwise yield invalid or unresolvable
 * STU3, and reports what STU3 cannot represent.
 */
export const conv_R4_to_R3 = {
  name: 'ValueSet_R4_to_R3',
  coverage: COVERAGE.BEST_EFFORT,
  description:
    'Normalizes compose filter values into valid STU3 codes (removing a filter '
    + 'whose value cannot be one), strips canonical version suffixes from '
    + 'compose valueSet references, generates the expansion identifier STU3 '
    + 'requires, generates an empty expansion when the source satisfies neither '
    + 'half of vsd-5, and reports expansion parameter dateTime values that STU3 '
    + 'cannot represent. Does not handle inter-version extensions.',

  /**
   * @param {Object} target FML-converted STU3 ValueSet, mutated in place.
   * @param {Object} ctx Hop context with sourceResource, fromVer, and toVer.
   * @returns {{resource: Object, status: string, messages: Array<Object>}} Result.
   */
  execute(target, ctx) {
    const messages = [];

    for (const [branch, index, entry] of composeEntries(target)) {
      normalizeFilterValues(entry, branch, index, messages);
      stripValueSetVersions(entry, branch, index, messages);
    }

    // Synthesize the expansion before topping up its identifier, so a generated
    // expansion is reported once rather than twice.
    ensureComposeOrExpansion(target, messages);
    ensureExpansionIdentifier(target, messages);
    reportDateTimeParameters(ctx?.sourceResource, messages);

    return { resource: target, status: statusFromMessages(messages), messages };
  },
};

