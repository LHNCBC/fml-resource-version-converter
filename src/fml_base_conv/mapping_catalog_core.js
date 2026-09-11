/**
 * @fileoverview Pure FML resource-mapping selection.
 *
 * The caller supplies direction loading, allowing the same target-selection
 * rules to operate on filesystem scans and decoded runtime artifacts.
 *
 * @module fml_base_conv/mapping_catalog_core
 */

/**
 * Load the mapping candidates declared for one version direction.
 *
 * @callback DirectionLoader
 * @param {string} fromVer Canonical source version.
 * @param {string} toVer Canonical target version.
 * @returns {Map<string, Array<Object>>} Candidates indexed by source type.
 */

/**
 * @typedef {Object} MappingCatalog
 * @property {Function} hasMapping Test whether a source type has candidates.
 * @property {Function} resolveMapping Select one unambiguous candidate.
 */

/**
 * Create a lazy mapping catalog from a direction loader. Loader failures
 * propagate from catalog method calls and are not cached.
 *
 * @param {DirectionLoader} directionLoader Lazy direction source.
 * @returns {MappingCatalog} Mapping availability and selection API.
 */
export function createMappingCatalog(directionLoader) {
  /** @type {Map<string, Map<string, Array<Object>>>} */
  const directionCache = new Map();

  /**
   * Load and index one version direction, memoizing only successful results.
   *
   * @param {string} fromVer Canonical source version.
   * @param {string} toVer Canonical target version.
   * @returns {Map<string, Array<Object>>} Source type to candidate descriptors.
   */
  function loadDirection(fromVer, toVer) {
    const cacheKey = `${fromVer}->${toVer}`;
    if (directionCache.has(cacheKey)) return directionCache.get(cacheKey);

    const bySource = directionLoader(fromVer, toVer);
    directionCache.set(cacheKey, bySource);

    return bySource;
  }

  /**
   * Whether any mapping is declared for a source resource on a version hop.
   *
   * @param {string} sourceResourceType Source FHIR resource type.
   * @param {string} fromVer Canonical source version.
   * @param {string} toVer Canonical target version.
   * @returns {boolean} True when at least one candidate exists.
   * @throws {Error} If direction loading fails.
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
   * @param {Object} [opts] Selection options.
   * @param {string} [opts.targetResourceType] Intended target resource type.
   * @returns {Object} Immutable selected mapping descriptor.
   * @throws {Error} If loading fails, no candidate exists, or selection is ambiguous.
   */
  function resolveMapping(
    sourceResourceType,
    fromVer,
    toVer,
    { targetResourceType } = {},
  ) {
    const allCandidates = loadDirection(fromVer, toVer).get(sourceResourceType) || [];
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
