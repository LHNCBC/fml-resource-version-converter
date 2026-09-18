/**
 * @fileoverview Shared R4 -> R3 Meta and Extension validity repair.
 *
 * The local R4 -> R3 Extension FML mapping preserves the shared valueMeta
 * choice. R4 Meta.source has no STU3 equivalent, however, so an Extension
 * whose valueMeta contains only source content would otherwise become a
 * URL-only Extension and violate ext-1. This release-scoped utility reports
 * the lost Meta.source content and removes such invalid Extensions.
 *
 * It is called by each reviewed R4 -> R3 resource postprocessor. A resource
 * type without such a postprocessor therefore keeps any URL-only Extension the
 * hop produced; those types are `not_reviewed` and make no validity claim. A
 * future direction-level facility - registry-supplied defaults for a hop, or an
 * engine hook invoked at each Meta and Extension group - should apply this
 * policy to every type and replace this repeated wiring.
 *
 * @module postprocessors/R3_R4/metaExtensions
 */
import { warningMessage } from '../../converter/diagnostics.js';
import {
  hasAnyContent,
  hasPrimitiveValueOrExtension,
} from '../util/elements.js';

/**
 * Return whether a value carries concrete FHIR JSON content.
 *
 * Element.id identifies an element but does not satisfy ele-1 by itself. A
 * complex value containing only that property is therefore not a usable
 * Extension value[x] remainder.
 *
 * @param {*} value Candidate JSON value.
 * @returns {boolean} True when the value is non-null and nonempty.
 */
function hasConcreteContent(value) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).some(key => key !== 'id');
  return true;
}

/**
 * Return a dot-separated child path, with array indexes supplied separately.
 *
 * @param {string} path Parent path.
 * @param {string} key Child property name.
 * @returns {string} Child path.
 */
function childPath(path, key) {
  return path.length === 0 ? key : `${path}.${key}`;
}

/**
 * Return whether an Extension retains a concrete value[x] payload.
 *
 * @param {Object} extension FHIR Extension JSON object.
 * @returns {boolean} True when a value choice has concrete content.
 */
function hasExtensionValue(extension) {
  for (const key of Object.keys(extension)) {
    if (/^value[A-Z]/.test(key) && hasConcreteContent(extension[key])) return true;

    if (/^_value[A-Z]/.test(key) && hasPrimitiveValueOrExtension(extension, key.slice(1))) {
      return true;
    }
  }

  return false;
}

/**
 * Return whether an Extension satisfies ext-1 after conversion.
 *
 * @param {*} extension Candidate Extension JSON value.
 * @returns {boolean} True when nested extensions or value[x] content remains.
 */
function isValidExtension(extension) {
  if (!extension || typeof extension !== 'object' || Array.isArray(extension)) return false;

  return (Array.isArray(extension.extension) && extension.extension.length > 0)
    || hasExtensionValue(extension);
}

/**
 * Report unsupported R4 Meta.source content on root or Extension.valueMeta.
 *
 * @param {*} value Source value to visit.
 * @param {string} path FHIR JSON path for diagnostics.
 * @param {Array<Object>} messages Diagnostic messages to append.
 * @param {WeakSet<Object>} visited Cycle guard.
 * @returns {void}
 */
function reportNestedMetaSourceLoss(value, path, messages, visited) {
  if (value == null || typeof value !== 'object') return;
  if (visited.has(value)) return;
  visited.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      reportNestedMetaSourceLoss(item, `${path}[${index}]`, messages, visited);
    });
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const nextPath = childPath(path, key);

    if ((key === 'extension' || key === 'modifierExtension') && Array.isArray(child)) {
      child.forEach((extension, index) => {
        const extensionPath = `${nextPath}[${index}]`;
        if (hasAnyContent(extension?.valueMeta, ['source', '_source'])) {
          messages.push(warningMessage(
            `R4 ${extensionPath}.valueMeta.source and any primitive metadata were dropped `
            + 'because STU3 Meta has no equivalent',
          ));
        }
        reportNestedMetaSourceLoss(extension, extensionPath, messages, visited);
      });
      continue;
    }

    reportNestedMetaSourceLoss(child, nextPath, messages, visited);
  }
}

/**
 * Remove target Extensions that have neither a nested Extension nor value[x].
 *
 * @param {*} value Target value to visit and repair.
 * @param {string} path FHIR JSON path for diagnostics.
 * @param {Array<Object>} messages Diagnostic messages to append.
 * @param {WeakSet<Object>} visited Cycle guard.
 * @returns {void}
 */
function removeInvalidExtensions(value, path, messages, visited) {
  if (value == null || typeof value !== 'object') return;
  if (visited.has(value)) return;
  visited.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      removeInvalidExtensions(item, `${path}[${index}]`, messages, visited);
    });
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const nextPath = childPath(path, key);

    if ((key === 'extension' || key === 'modifierExtension') && Array.isArray(child)) {
      const retained = [];

      child.forEach((extension, index) => {
        const extensionPath = `${nextPath}[${index}]`;
        removeInvalidExtensions(extension, extensionPath, messages, visited);

        if (isValidExtension(extension)) {
          retained.push(extension);
          return;
        }

        messages.push(warningMessage(
          `Removed ${extensionPath} because R4 -> R3 conversion left it with neither `
          + 'a value[x] nor nested extensions; retaining it would violate STU3 invariant ext-1',
        ));
      });

      if (retained.length > 0) value[key] = retained;
      else delete value[key];
      continue;
    }

    removeInvalidExtensions(child, nextPath, messages, visited);
  }
}

/**
 * Report R4 Meta.source loss and remove invalid R3 Extension results.
 *
 * @param {Object} target FML-converted STU3 resource, mutated in place.
 * @param {Object|undefined} source R4 source resource, read-only.
 * @param {Array<Object>} messages Diagnostic messages to append.
 * @returns {void}
 */
export function repairR4ToR3MetaAndExtensions(target, source, messages) {
  if (hasAnyContent(source?.meta, ['source', '_source'])) {
    messages.push(warningMessage(
      'R4 meta.source and any primitive metadata were dropped because STU3 Meta has no equivalent',
    ));
  }

  reportNestedMetaSourceLoss(source, '', messages, new WeakSet());
  removeInvalidExtensions(target, '', messages, new WeakSet());
}
