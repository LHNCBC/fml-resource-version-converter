/**
 * @fileoverview FML resource-mapping discovery and route selection.
 *
 * FML filenames are not authoritative: a resource can be renamed between FHIR
 * versions, and one source resource can have more than one target mapping.
 * This module builds immutable mapping descriptors from each StructureMap's
 * source/target declarations and resource-level entry group.
 *
 * Catalogs are lazy and factory-scoped. A factory therefore scans each version
 * direction at most once, while a newly-created factory sees a fresh view of a
 * custom mapping root.
 *
 * @module fml_base_conv/fml_mapping_catalog
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseFml } from './fml_parser.js';

const KNOWN_VERSIONS = new Set(['R2', 'R3', 'R4', 'R4B', 'R5']);
const RESOURCE_BASE_GROUPS = new Set([
  'Resource',
  'DomainResource',
  'CanonicalResource',
  'MetadataResource',
]);
const RESOURCE_GROUP_ANNOTATIONS = new Set(['type+', 'types']);

/**
 * Return the StructureDefinition type named by a canonical URL.
 *
 * @param {string|null|undefined} url Canonical StructureDefinition URL.
 * @returns {string|null} Final type segment, or null for an unrelated URL.
 */
function structureType(url) {
  if (typeof url !== 'string') return null;
  const match = url.match(/\/StructureDefinition\/([^/]+)$/);
  return match ? match[1] : null;
}

/**
 * Resolve one typed group parameter to its matching uses declaration.
 *
 * @param {Array<Object>} uses Parsed FML uses declarations.
 * @param {Object} param Typed group parameter.
 * @returns {Object|null} Matching declaration, or null when none is present.
 */
function resolveParamUse(uses, param) {
  return uses.find(use => use.mode === param.mode && use.alias === param.type) || null;
}

/**
 * Whether a group is a top-level resource conversion candidate.
 *
 * Cross-version resource groups extend a resource base and carry either the
 * `<<type+>>` or `<<types>>` annotation. Requiring both conditions excludes
 * datatype and helper groups while retaining the bundled one-to-many resource
 * mappings.
 *
 * @param {Object} group Parsed FML group.
 * @returns {boolean} True for a resource conversion candidate.
 */
function isResourceMappingGroup(group) {
  return RESOURCE_BASE_GROUPS.has(group.extendsType) &&
    group.annotations.some(annotation => RESOURCE_GROUP_ANNOTATIONS.has(annotation));
}

/**
 * Build immutable route descriptors from one FML file.
 *
 * @param {string} filePath Absolute path to an FML file.
 * @returns {Array<Object>} Resource mapping descriptors declared by the file.
 */
function describeFmlFile(filePath) {
  const fmlText = fs.readFileSync(filePath, 'utf-8');
  const ast = parseFml(fmlText);
  const descriptors = [];

  for (const group of ast.groups.values()) {
    if (!isResourceMappingGroup(group)) continue;

    const sourceParams = group.params.filter(param => param.mode === 'source');
    const targetParams = group.params.filter(param => param.mode === 'target');
    if (sourceParams.length !== 1 || targetParams.length !== 1 ||
        !sourceParams[0].type || !targetParams[0].type) {
      throw new Error(
        `FML mapping catalog: resource group "${group.name}" in ${filePath} ` +
        'must declare exactly one typed source and one typed target parameter',
      );
    }

    const sourceUse = resolveParamUse(ast.uses, sourceParams[0]);
    const targetUse = resolveParamUse(ast.uses, targetParams[0]);
    const sourceResourceType = structureType(sourceUse?.url);
    const targetResourceType = structureType(targetUse?.url);
    if (!sourceUse || !targetUse || !sourceResourceType || !targetResourceType) {
      throw new Error(
        `FML mapping catalog: cannot resolve source/target declarations for ` +
        `resource group "${group.name}" in ${filePath}`,
      );
    }

    descriptors.push(Object.freeze({
      filePath,
      structureMapUrl: ast.metadata.url || null,
      structureMapName: ast.metadata.name || group.name,
      entryGroup: group.name,
      sourceResourceType,
      sourceProfile: sourceUse.url,
      targetResourceType,
      targetProfile: targetUse.url,
    }));
  }

  return descriptors;
}

/**
 * Create a lazy mapping catalog bound to one FML input root.
 *
 * @param {string} xverRoot Absolute FML mapping root.
 * @returns {{hasMapping: Function, resolveMapping: Function}} Catalog API.
 */
export function createFmlMappingCatalog(xverRoot) {
  /** @type {Map<string, Map<string, Array<Object>>>} */
  const directionCache = new Map();

  /**
   * Load and index one version direction.
   *
   * @param {string} fromVer Canonical source version.
   * @param {string} toVer Canonical target version.
   * @returns {Map<string, Array<Object>>} Source type to candidate descriptors.
   */
  function loadDirection(fromVer, toVer) {
    const cacheKey = `${fromVer}->${toVer}`;
    if (directionCache.has(cacheKey)) return directionCache.get(cacheKey);

    const bySource = new Map();
    directionCache.set(cacheKey, bySource);
    if (!KNOWN_VERSIONS.has(fromVer) || !KNOWN_VERSIONS.has(toVer)) return bySource;

    const directionDir = path.join(xverRoot, `${fromVer}to${toVer}`);
    let entries;
    try {
      entries = fs.readdirSync(directionDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return bySource;
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.fml')) continue;
      const filePath = path.join(directionDir, entry.name);
      let descriptors;
      try {
        descriptors = describeFmlFile(filePath);
      } catch (error) {
        throw new Error(
          `FML mapping catalog: failed to inspect ${filePath}: ${error.message}`,
          { cause: error },
        );
      }

      for (const descriptor of descriptors) {
        const candidates = bySource.get(descriptor.sourceResourceType) || [];
        candidates.push(descriptor);
        bySource.set(descriptor.sourceResourceType, candidates);
      }
    }

    for (const [sourceType, candidates] of bySource) {
      candidates.sort((a, b) =>
        a.targetResourceType.localeCompare(b.targetResourceType) ||
        a.structureMapName.localeCompare(b.structureMapName));
      bySource.set(sourceType, Object.freeze(candidates));
    }

    return bySource;
  }

  /**
   * Whether any mapping is declared for a source resource on a version hop.
   *
   * Ambiguity does not make a source unsupported; resolveMapping performs the
   * target selection and reports ambiguity when execution is requested.
   *
   * @param {string} sourceResourceType Source FHIR resource type.
   * @param {string} fromVer Canonical source version.
   * @param {string} toVer Canonical target version.
   * @returns {boolean} True when at least one candidate exists.
   */
  function hasMapping(sourceResourceType, fromVer, toVer) {
    const candidates = loadDirection(fromVer, toVer).get(sourceResourceType);
    return !!candidates?.length;
  }

  /**
   * Select exactly one mapping for a source resource and optional target.
   *
   * @param {string} sourceResourceType Source FHIR resource type.
   * @param {string} fromVer Canonical source version.
   * @param {string} toVer Canonical target version.
   * @param {Object} [opts]
   * @param {string} [opts.targetResourceType] The intended target type.
   *        Required only when the source maps to more than one target on the hop
   *        (e.g. ServiceRequest R4->R3 -> ProcedureRequest or ReferralRequest);
   *        checked against the declared target whenever supplied.
   * @returns {Object} Immutable selected mapping descriptor.
   * @throws {Error} If no candidate exists or selection remains ambiguous.
   */
  function resolveMapping(
    sourceResourceType,
    fromVer,
    toVer,
    { targetResourceType } = {},
  ) {
    const allCandidates =
      loadDirection(fromVer, toVer).get(sourceResourceType) || [];
    if (allCandidates.length === 0) {
      throw new Error(
        `FML mapping not found for ${sourceResourceType} ${fromVer}->${toVer}`,
      );
    }

    const availableTargets =
      [...new Set(allCandidates.map(candidate => candidate.targetResourceType))].sort();

    if (targetResourceType == null && availableTargets.length > 1) {
      throw new Error(
        `Ambiguous FML mapping for ${sourceResourceType} ${fromVer}->${toVer}; ` +
        'opts.targetResourceType is required. Available targets: ' +
        availableTargets.join(', '),
      );
    }

    const selectedTarget = targetResourceType ?? availableTargets[0];
    const candidates = allCandidates.filter(
      candidate => candidate.targetResourceType === selectedTarget,
    );
    if (candidates.length === 0) {
      throw new Error(
        `No FML mapping for ${sourceResourceType} ${fromVer}->${toVer} targeting ` +
        `${selectedTarget}. Available targets: ${availableTargets.join(', ')}`,
      );
    }

    if (candidates.length > 1) {
      const mapNames = candidates.map(candidate => candidate.structureMapName);
      throw new Error(
        `Multiple FML StructureMaps for ${sourceResourceType} ${fromVer}->${toVer} ` +
        `targeting ${selectedTarget}: ${mapNames.join(', ')}`,
      );
    }

    return candidates[0];
  }

  return { hasMapping, resolveMapping };
}
