/**
 * @fileoverview FML resource-mapping discovery and route selection.
 *
 * Maintainer-only raw FML discovery. FML filenames are not authoritative: a
 * resource can be renamed between FHIR
 * versions, and one source resource can have more than one target mapping.
 * This module builds immutable mapping descriptors from each StructureMap's
 * source/target declarations and resource-level entry group.
 *
 * Catalogs are lazy and factory-scoped for scanner tests and maintainer tools.
 * Runtime conversion uses mapping descriptors from generated artifacts.
 *
 * @module tools/fml-mapping-catalog
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseFml } from '../src/fml_base_conv/fml_parser.js';
import { createMappingCatalog } from '../src/fml_base_conv/mapping_catalog_core.js';

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
 * Scan one version direction and index its resource mappings by source type.
 *
 * Exported so maintainer tooling can enumerate the declared routes using the
 * exact same detection rules the runtime uses, rather than re-deriving them.
 * An unknown version or an absent direction directory yields an empty map; a
 * malformed FML file throws.
 *
 * @param {string} fromVer Canonical source version.
 * @param {string} toVer Canonical target version.
 * @param {string} xverRoot Absolute FML mapping root.
 * @returns {Map<string, Array<Object>>} Source type to candidate descriptors.
 */
export function scanResourceMappings(fromVer, toVer, xverRoot) {
  const bySource = new Map();
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
 * Create a lazy mapping catalog bound to one FML input root.
 *
 * @param {string} xverRoot Absolute FML mapping root.
 * @returns {{hasMapping: Function, resolveMapping: Function}} Catalog API.
 */
export function createFmlMappingCatalog(xverRoot) {
  return createMappingCatalog(
    (fromVer, toVer) => scanResourceMappings(fromVer, toVer, xverRoot),
  );
}
