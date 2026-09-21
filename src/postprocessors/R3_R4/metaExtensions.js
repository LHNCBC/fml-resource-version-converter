/**
 * @fileoverview Shared R4 -> R3 Meta and Extension validity repair.
 *
 * The local R4 -> R3 Extension FML mapping preserves the shared valueMeta
 * choice. R4 Meta.source has no STU3 equivalent, however, so an Extension
 * whose valueMeta contains only source content would otherwise become a
 * URL-only Extension and violate ext-1. This release-scoped utility reports
 * the lost Meta.source content, strips it if source-based reconstruction copied
 * it back, and removes such invalid Extensions. Enclosing elements emptied by
 * that removal are marked absent rather than left in violation of ele-1.
 * This is not a general converter for source-version extension payloads.
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
  DATA_ABSENT_REASON_URL,
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
  // Contained and other embedded resources are carried through unconverted.
  if (path && typeof value.resourceType === 'string') return;
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
 * Strip leftover Meta.source and remove Extensions with no remaining payload.
 * Preserve emptied enclosing elements with data-absent-reason: the helper has
 * no cardinality metadata and must not delete a potentially required occurrence.
 * Extension objects and their direct value[x] can instead disappear together.
 *
 * @param {*} value Target value to visit and repair.
 * @param {string} path FHIR JSON path for diagnostics.
 * @param {Array<Object>} messages Diagnostic messages to append.
 * @param {WeakSet<Object>} visited Cycle guard.
 * @param {Object} [options] Context for the current element.
 * @param {boolean} [options.isExtension=false] Current object is an Extension.
 * @param {boolean} [options.preserveEmpty=true] Keep an emptied element valid.
 * @returns {boolean} Whether an extension was removed from this element itself.
 */
function repairTargetExtensions(value, path, messages, visited, {
  isExtension = false,
  preserveEmpty = true,
} = {}) {
  if (value == null || typeof value !== 'object') return false;
  if (path && typeof value.resourceType === 'string') return false;
  if (visited.has(value)) return false;
  visited.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      repairTargetExtensions(item, `${path}[${index}]`, messages, visited);
    });
    return false;
  }

  if (isExtension && value.valueMeta && typeof value.valueMeta === 'object') {
    // Loss is reported from the original source, whose paths may differ after
    // reconstruction (for example Library.author -> Library.contributor).
    delete value.valueMeta.source;
    delete value.valueMeta._source;
  }

  let removedOwnExtensions = false;
  for (const [key, child] of Object.entries(value)) {
    const nextPath = childPath(path, key);

    if ((key === 'extension' || key === 'modifierExtension') && Array.isArray(child)) {
      const retained = [];

      child.forEach((extension, index) => {
        const extensionPath = `${nextPath}[${index}]`;
        repairTargetExtensions(extension, extensionPath, messages, visited, {
          isExtension: true,
          preserveEmpty: false,
        });

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
      removedOwnExtensions ||= retained.length < child.length;
      continue;
    }

    const isExtensionValue = isExtension && /^_?value[A-Z]/.test(key);
    if (key.startsWith('_') && child && typeof child === 'object') {
      const bare = value[key.slice(1)];
      if (Array.isArray(child)) {
        let changed = false;
        child.forEach((companion, index) => {
          const removed = repairTargetExtensions(
            companion, `${nextPath}[${index}]`, messages, visited,
            { preserveEmpty: !isExtensionValue && bare?.[index] == null },
          );
          if (removed && Object.keys(companion).length === 0) {
            child[index] = null;
            changed = true;
          }
        });
        // Keep indexes aligned; omit the companion array only if all are gone.
        if (changed && child.every(companion => companion == null)) delete value[key];
      } else {
        const removed = repairTargetExtensions(child, nextPath, messages, visited, {
          preserveEmpty: !isExtensionValue && bare == null,
        });
        if (removed && Object.keys(child).length === 0) delete value[key];
      }
    } else {
      repairTargetExtensions(child, nextPath, messages, visited, {
        preserveEmpty: !isExtensionValue,
      });
    }
  }

  if (removedOwnExtensions && preserveEmpty && !hasConcreteContent(value)) {
    // STU3 permits data-absent-reason on all datatypes, including primitives.
    value.extension = [{ url: DATA_ABSENT_REASON_URL, valueCode: 'unsupported' }];
    messages.push(warningMessage(
      `${path} became empty after extension removal; data-absent-reason "unsupported" `
      + 'was added to preserve the occurrence without violating STU3 invariant ele-1',
    ));
  }

  return removedOwnExtensions;
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

  reportNestedMetaSourceLoss(source ?? target, '', messages, new WeakSet());
  repairTargetExtensions(target, '', messages, new WeakSet());
}
