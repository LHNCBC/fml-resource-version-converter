/**
 * @fileoverview In-memory FML engine factory backed by runtime data.
 *
 * This module consumes validated decoded artifacts and has no filesystem or
 * Node built-in dependencies. Each createEngine call compiles exactly one FML
 * engine from the shared runtime payloads.
 *
 * @module fml_base_conv/runtime_engine_factory
 */

import { compileFmlXver } from './fml_xver_engine.js';
import { createMappingCatalog } from './mapping_catalog_core.js';
import { indexRuntimeDataSelection } from '../runtime/assembler.js';

const TABLE_VERSION = Object.freeze({
  R2: 'DSTU2',
  R3: 'STU3',
  R4: 'R4',
  R4B: 'R4B',
  R5: 'R5',
});

/**
 * @typedef {Object} RuntimeEngineOptions
 * @property {boolean} [strict=false] Treat translation gaps as hard errors.
 * @property {string} [targetResourceType] Target for an ambiguous mapping.
 * @property {Function} [onWarning] Warning callback.
 * @property {Function} [onInfo] Informational callback.
 * @property {Function} [onRuleExec] Per-rule tracing callback.
 */

/**
 * @typedef {Object} RuntimeFmlEngineFactory
 * @property {Function} hasDirection Test whether a direction is selected.
 * @property {Function} hasMapping Test whether a source type is mapped.
 * @property {Function} resolveMapping Resolve one resource mapping.
 * @property {Function} createEngine Compile one single-hop engine.
 */

/**
 * Whether FML source declares a wildcard StructureMap import.
 *
 * @param {string} fmlText FML source text.
 * @returns {boolean} True when a wildcard import is declared.
 */
function hasWildcardImport(fmlText) {
  const importPattern = /imports\s+['"]([^'"]+)['"]/g;
  let match;

  while ((match = importPattern.exec(fmlText)) !== null) {
    const finalSegment = match[1].split('/').pop();
    if (finalSegment?.startsWith('*')) return true;
  }

  return false;
}

/**
 * Load imported sibling FML texts from a virtual file map.
 *
 * @param {Object<string, string>} files Virtual FML files.
 * @param {string} mainFile Main virtual filename.
 * @param {string} fmlText Main FML source.
 * @returns {string[]} Imported FML texts in lexical filename order.
 */
function importedFmlTexts(files, mainFile, fmlText) {
  if (!hasWildcardImport(fmlText)) return [];

  const separator = mainFile.lastIndexOf('/');
  const directoryPrefix = separator === -1 ? '' : mainFile.slice(0, separator + 1);

  return Object.keys(files)
    .filter(file => file !== mainFile && file.startsWith(directoryPrefix) && file.endsWith('.fml'))
    .sort()
    .map(file => files[file]);
}

/**
 * Expand one compact generated ConceptMap to the shape consumed by the engine.
 *
 * @param {Object} conceptMap Compact runtime ConceptMap.
 * @returns {Object} Engine ConceptMap shape.
 */
function expandConceptMap(conceptMap) {
  return {
    url: conceptMap.url,
    group: conceptMap.groups.map(group => ({
      source: group.source,
      target: group.target,
      unmapped: group.unmapped,
      element: group.elements.map(element => ({
        code: element.code,
        noMap: element.noMap,
        target: element.targets.map(target => ({
          code: target.code,
          display: target.display,
          relationship: target.relationship,
        })),
      })),
    })),
  };
}

/**
 * Build a source-resource index for one mapping payload.
 *
 * @param {Object} payload Decoded FML mappings payload.
 * @returns {Map<string, Array<Object>>} Mapping candidates by source type.
 */
function indexMappings(payload) {
  const bySource = new Map();

  for (const mapping of payload.mappings) {
    const descriptor = Object.freeze({ ...mapping });
    const candidates = bySource.get(descriptor.sourceResourceType) || [];
    candidates.push(descriptor);
    bySource.set(descriptor.sourceResourceType, candidates);
  }

  for (const [sourceType, candidates] of bySource) {
    candidates.sort((left, right) =>
      left.targetResourceType.localeCompare(right.targetResourceType) ||
      left.structureMapName.localeCompare(right.structureMapName));
    bySource.set(sourceType, Object.freeze(candidates));
  }

  return bySource;
}

/**
 * Create an FML engine factory bound to one runtime-data selection.
 *
 * @param {Object|Object[]} selection Runtime data module or module array.
 * @returns {RuntimeFmlEngineFactory} Frozen runtime-bound engine factory.
 * @throws {Error} If the selection is empty, malformed, or conflicting.
 */
export function createRuntimeFmlEngineFactory(selection) {
  const indexes = indexRuntimeDataSelection(selection);
  const directionStates = new Map();

  /**
   * Resolve and lazily prepare one selected direction.
   *
   * @param {string} fromVer Source version.
   * @param {string} toVer Target version.
   * @returns {Object|null} Prepared direction, or null when unselected.
   */
  function getDirectionState(fromVer, toVer) {
    const key = `${fromVer}->${toVer}`;
    if (directionStates.has(key)) return directionStates.get(key);

    const payload = indexes.mappingsByDirection.get(key);
    if (!payload) {
      directionStates.set(key, null);

      return null;
    }

    const state = Object.freeze({
      payload,
      mappingsBySource: indexMappings(payload),
      conceptMaps: Object.freeze(payload.conceptMaps.map(expandConceptMap)),
    });
    directionStates.set(key, state);

    return state;
  }

  const mappingCatalog = createMappingCatalog(
    (fromVer, toVer) => getDirectionState(fromVer, toVer)?.mappingsBySource || new Map(),
  );

  return Object.freeze({
    /**
     * Whether this runtime selection includes a version direction.
     *
     * @param {string} fromVer Source version.
     * @param {string} toVer Target version.
     * @returns {boolean} True when the direction is selected.
     */
    hasDirection(fromVer, toVer) {
      return indexes.mappingsByDirection.has(`${fromVer}->${toVer}`);
    },

    /**
     * Whether a selected direction maps the source resource type.
     *
     * @param {string} resourceType Source resource type.
     * @param {string} fromVer Source version.
     * @param {string} toVer Target version.
     * @returns {boolean} True when the mapping is selected.
     */
    hasMapping(resourceType, fromVer, toVer) {
      return mappingCatalog.hasMapping(resourceType, fromVer, toVer);
    },

    /**
     * Resolve a selected resource mapping.
     *
     * @param {string} resourceType Source resource type.
     * @param {string} fromVer Source version.
     * @param {string} toVer Target version.
     * @param {Object} [options] Mapping selection options.
     * @param {string} [options.targetResourceType] Intended target resource type.
     * @returns {Object} Selected immutable mapping descriptor.
     * @throws {Error} If no mapping exists or target selection is ambiguous.
     */
    resolveMapping(resourceType, fromVer, toVer, options = {}) {
      return mappingCatalog.resolveMapping(resourceType, fromVer, toVer, options);
    },

    /**
     * Compile one selected resource mapping into an engine.
     *
     * @param {string} resourceType Source resource type.
     * @param {string} fromVer Source version.
     * @param {string} toVer Target version.
     * @param {RuntimeEngineOptions} [options] Engine and diagnostic options.
     * @returns {{convert: Function}} Single-hop conversion engine.
     * @throws {Error} If the mapping is unavailable or FML compilation fails.
     */
    createEngine(resourceType, fromVer, toVer, options = {}) {
      const mapping = mappingCatalog.resolveMapping(resourceType, fromVer, toVer, options);
      const state = getDirectionState(fromVer, toVer);
      const fmlText = state.payload.files[mapping.virtualFile];
      const sourceTable = indexes.tablesByVersion.get(TABLE_VERSION[fromVer]);
      const targetTable = indexes.tablesByVersion.get(TABLE_VERSION[toVer]);
      const fhirPathModel = indexes.modelsBySourceVersion.get(fromVer);
      const engine = compileFmlXver({
        fmlText,
        conceptMaps: state.conceptMaps,
        importedFmlTexts: importedFmlTexts(state.payload.files, mapping.virtualFile, fmlText),
        strict: options.strict ?? false,
        fromVer,
        toVer,
        mapping,
        srcDefs: sourceTable,
        tgtDefs: targetTable,
        fhirPathModel,
        onWarning: options.onWarning,
        onInfo: options.onInfo,
        onRuleExec: options.onRuleExec,
      });

      return Object.freeze({ convert: engine.convert });
    },
  });
}
