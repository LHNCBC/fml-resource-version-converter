/**
 * @fileoverview CodeSystem postprocessors for the R3 <-> R4 version pair.
 *
 * R3 -> R4: the FML maps every STU3 CodeSystem element. R4 adds warning
 * invariant csd-0 for `name`; a conforming STU3 name may violate it, so the
 * postprocessor reports the condition without changing the identifier.
 *
 * R4 -> R3: the FML does not account for canonical version pins, R4
 * supplements, the R4-only `supplement` content code, or decimal concept
 * properties. The postprocessor repairs the target shape and preserves parsed
 * decimal values as strings where STU3 cannot preserve their numeric property
 * type. Identifier cardinality narrowing is enforced and reported by the FML
 * engine; the postprocessor keeps a defensive narrowing for direct calls.
 *
 * Neither direction implements inter-version extensions.
 *
 * @module postprocessors/R3_R4/CodeSystem
 */
import { COVERAGE } from '../../converter/coverage.js';
import {
  statusFromMessages,
  warningMessage,
} from '../../converter/diagnostics.js';
import {
  hasAnyContent,
  stripCanonicalVersion,
} from '../util/elements.js';
import { removeUnrepresentableUsageContexts } from './usageContext.js';

// R4 invariant csd-0 (severity: warning). STU3 imposes no equivalent rule.
const CSD_0_NAME = /^[A-Z][A-Za-z0-9_]{0,254}$/;

/**
 * Reduce R4's repeating identifier to STU3's single Identifier.
 *
 * This is a defensive repair, not the primary report. The FML engine already
 * honors the STU3 `0..1` cardinality while writing, and reports the dropped
 * identifiers itself, so in the normal pipeline this function finds a single
 * value and stays silent rather than duplicating that warning. It still
 * narrows and reports when it is handed a target that really does carry an
 * array, which is what happens when the postprocessor is invoked directly on a
 * hand-built resource.
 *
 * The message therefore describes only what this function did. Counting the
 * loss from the source instead would claim an identifier was retained even
 * when the target has none.
 *
 * @param {Object} target FML-converted STU3 CodeSystem, mutated in place.
 * @param {Array<Object>} messages Diagnostic messages to append.
 */
function narrowIdentifier(target, messages) {
  if (!Array.isArray(target?.identifier)) return;

  const identifiers = target.identifier;
  if (identifiers.length === 0) {
    delete target.identifier;
    return;
  }

  target.identifier = identifiers[0];
  if (identifiers.length === 1) return;

  messages.push(warningMessage(
    `CodeSystem.identifier has ${identifiers.length} entries in R4 but STU3 allows only one; `
    + 'the first identifier was retained and the additional identifiers were dropped',
  ));
}

/**
 * Remove an R4 canonical version pin from CodeSystem.valueSet.
 *
 * @param {Object} target FML-converted STU3 CodeSystem, mutated in place.
 * @param {Array<Object>} messages Diagnostic messages to append.
 */
function normalizeValueSet(target, messages) {
  const reference = target?.valueSet;
  if (typeof reference !== 'string' || !reference.includes('|')) return;

  const stripped = stripCanonicalVersion(reference);
  target.valueSet = stripped;
  messages.push(warningMessage(
    `CodeSystem.valueSet "${reference}" pins a canonical version, which STU3 cannot express; `
    + `the version was dropped, leaving "${stripped}"`,
  ));
}

/**
 * Approximate R4 decimal property declarations as STU3 string declarations.
 *
 * @param {Object} target FML-converted STU3 CodeSystem, mutated in place.
 * @param {Array<Object>} messages Diagnostic messages to append.
 */
function convertDecimalDeclarations(target, messages) {
  if (!Array.isArray(target?.property)) return;

  target.property.forEach((property, index) => {
    if (property?.type !== 'decimal') return;

    property.type = 'string';
    messages.push(warningMessage(
      `CodeSystem.property[${index}] (code "${property.code ?? 'unknown'}") declares the R4-only `
      + 'decimal property type; it was approximated as string for STU3, so consumers no longer '
      + 'have a numeric type declaration',
    ));
  });
}

/**
 * Copy one R4 decimal property value into the corresponding STU3 property as a
 * string, carrying any primitive companion under the new typed name.
 * Original JSON formatting (such as trailing zeros), and any precision already
 * lost when the decimal became a JavaScript number, cannot be recovered here.
 *
 * @param {Object} sourceProperty R4 concept property (read-only).
 * @param {Object} targetProperty Corresponding STU3 concept property, mutated.
 * @param {string} path Indexed path used in diagnostics.
 * @param {Array<Object>} messages Diagnostic messages to append.
 */
function convertDecimalValue(sourceProperty, targetProperty, path, messages) {
  if (!hasAnyContent(sourceProperty, ['valueDecimal', '_valueDecimal'])) return;

  if (Object.hasOwn(sourceProperty, 'valueDecimal')) {
    targetProperty.valueString = String(sourceProperty.valueDecimal);
  }
  if (Object.hasOwn(sourceProperty, '_valueDecimal')) {
    // The bare value is a JSON number and copies by value, but the `_`-companion
    // is an object; assigning it directly would leave the target sharing the
    // source's id/extension, so a later mutation of one would alter the other.
    targetProperty._valueString = structuredClone(sourceProperty._valueDecimal);
  }

  messages.push(warningMessage(
    `${path}.valueDecimal has no STU3 equivalent; it was approximated as valueString, `
    + 'preserving its parsed numeric value and primitive metadata but losing numeric typing',
  ));
}

/**
 * Convert decimal property values throughout the recursive concept tree.
 *
 * This relies on the bundled FML emitting one target concept/property for each
 * valid source occurrence, in source order. The required property code is
 * still mapped when an unsupported value[x] variant is omitted, so source and
 * target entries remain aligned by index.
 *
 * @param {Array<Object>|undefined} sourceConcepts R4 concepts (read-only).
 * @param {Array<Object>|undefined} targetConcepts STU3 concepts, mutated.
 * @param {Array<Object>} messages Diagnostic messages to append.
 * @param {string} [basePath='CodeSystem.concept'] Diagnostic path prefix.
 */
function convertDecimalConceptProperties(
  sourceConcepts,
  targetConcepts,
  messages,
  basePath = 'CodeSystem.concept',
) {
  if (!Array.isArray(sourceConcepts) || !Array.isArray(targetConcepts)) return;

  sourceConcepts.forEach((sourceConcept, conceptIndex) => {
    const targetConcept = targetConcepts[conceptIndex];
    if (!targetConcept || typeof targetConcept !== 'object') return;

    const conceptPath = `${basePath}[${conceptIndex}]`;
    const sourceProperties = sourceConcept?.property;
    const targetProperties = targetConcept.property;

    if (Array.isArray(sourceProperties) && Array.isArray(targetProperties)) {
      sourceProperties.forEach((sourceProperty, propertyIndex) => {
        const targetProperty = targetProperties[propertyIndex];
        if (!targetProperty || typeof targetProperty !== 'object') return;

        convertDecimalValue(
          sourceProperty,
          targetProperty,
          `${conceptPath}.property[${propertyIndex}]`,
          messages,
        );
      });
    }

    convertDecimalConceptProperties(
      sourceConcept?.concept,
      targetConcept.concept,
      messages,
      `${conceptPath}.concept`,
    );
  });
}

/**
 * Report R4 supplements content that the STU3 target cannot carry.
 *
 * @param {Object|undefined} source R4 CodeSystem source (read-only).
 * @param {Array<Object>} messages Diagnostic messages to append.
 */
function reportSupplements(source, messages) {
  if (!hasAnyContent(source, ['supplements', '_supplements'])) return;

  messages.push(warningMessage(
    'CodeSystem.supplements has no STU3 equivalent and was dropped; the converted resource '
    + 'cannot identify the code system it supplements',
  ));
}

/**
 * Replace R4's supplement content code with the least-strong STU3 code that
 * can retain a populated concept tree.
 *
 * @param {Object} target FML-converted STU3 CodeSystem, mutated in place.
 * @param {Array<Object>} messages Diagnostic messages to append.
 */
function normalizeContent(target, messages) {
  if (target?.content !== 'supplement') return;

  target.content = 'fragment';
  messages.push(warningMessage(
    'CodeSystem.content "supplement" has no STU3 equivalent and was approximated as '
    + '"fragment" so retained concepts remain valid; supplement semantics were lost',
  ));
}

/**
 * R3 -> R4 CodeSystem postprocessor descriptor.
 */
export const conv_R3_to_R4 = {
  name: 'CodeSystem_R3_to_R4',
  coverage: COVERAGE.COMPLETE,
  description:
    'Reports STU3 names that do not satisfy R4 warning invariant csd-0 without rewriting '
    + 'the resource identifier. Does not handle inter-version extensions.',

  /**
   * @param {Object} target FML-converted R4 CodeSystem, mutated in place.
   * @param {Object} ctx Hop context with sourceResource, fromVer, and toVer.
   * @returns {{resource: Object, status: string, messages: Array<Object>}} Result.
   */
  execute(target, ctx) {
    const messages = [];
    const name = target?.name;
    const targetVersion = ctx?.toVer || 'R4';

    if (typeof name === 'string' && !CSD_0_NAME.test(name)) {
      messages.push(warningMessage(
        `CodeSystem.name "${name}" does not satisfy ${targetVersion} invariant csd-0 `
        + '(name should be usable as an identifier for machine processing); STU3 does not '
        + 'impose this rule. The name was left unchanged because it identifies the resource',
      ));
    }

    return { resource: target, status: statusFromMessages(messages), messages };
  },
};

/**
 * R4 -> R3 CodeSystem postprocessor descriptor.
 */
export const conv_R4_to_R3 = {
  name: 'CodeSystem_R4_to_R3',
  coverage: COVERAGE.BEST_EFFORT,
  description:
    'Removes canonical version pins, reports dropped supplements, approximates supplement '
    + 'content as fragment, and preserves decimal property values as strings with warnings. '
    + 'Removes Reference-valued UsageContext entries that STU3 cannot represent. '
    + 'Also narrows identifier cardinality defensively; the FML engine normally enforces and '
    + 'reports that narrowing already. Does not handle inter-version extensions.',

  /**
   * @param {Object} target FML-converted STU3 CodeSystem, mutated in place.
   * @param {Object} ctx Hop context with sourceResource, fromVer, and toVer.
   * @returns {{resource: Object, status: string, messages: Array<Object>}} Result.
   */
  execute(target, ctx) {
    const messages = [];
    const source = ctx?.sourceResource || {};

    removeUnrepresentableUsageContexts(target, source, messages);
    narrowIdentifier(target, messages);
    normalizeValueSet(target, messages);
    reportSupplements(source, messages);
    normalizeContent(target, messages);
    convertDecimalDeclarations(target, messages);
    convertDecimalConceptProperties(source.concept, target?.concept, messages);

    return { resource: target, status: statusFromMessages(messages), messages };
  },
};
