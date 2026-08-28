/**
 * @fileoverview Pure FHIR version graph and conversion-hop planning.
 *
 * This module contains no runtime data, filesystem access, or engine imports so
 * selective converter construction can use it without reaching the legacy
 * bundled-data path.
 *
 * @module fml_base_conv/version_graph
 */

const CONVERSION_LANES = Object.freeze([
  Object.freeze(['R2', 'R3', 'R4', 'R5']),
  Object.freeze(['R4B', 'R5']),
]);
const KNOWN_VERSIONS = new Set(CONVERSION_LANES.flat());

/**
 * Plan the shortest supported conversion path between two FHIR versions.
 *
 * @param {string} fromVer Canonical source version.
 * @param {string} toVer Canonical target version.
 * @returns {Array<[string, string]>} Ordered adjacent conversion hops.
 * @throws {Error} If a version is unknown or the pair has no supported route.
 */
export function planHops(fromVer, toVer) {
  if (!KNOWN_VERSIONS.has(fromVer)) throw new Error(`Unknown FHIR version: ${fromVer}`);
  if (!KNOWN_VERSIONS.has(toVer)) throw new Error(`Unknown FHIR version: ${toVer}`);

  if (fromVer === toVer) {
    throw new Error(
      `Unsupported conversion ${fromVer} -> ${toVer}: ` +
      'source and target versions are the same',
    );
  }
  if ((fromVer === 'R4' && toVer === 'R4B') ||
      (fromVer === 'R4B' && toVer === 'R4')) {
    throw new Error(
      `Unsupported conversion ${fromVer} -> ${toVer}: ` +
      'R4 and R4B are near-equivalent and have no conversion between them',
    );
  }

  for (const lane of CONVERSION_LANES) {
    const fromIndex = lane.indexOf(fromVer);
    const toIndex = lane.indexOf(toVer);
    if (fromIndex === -1 || toIndex === -1) continue;

    const step = fromIndex < toIndex ? 1 : -1;
    const hops = [];
    for (let index = fromIndex; index !== toIndex; index += step) {
      hops.push([lane[index], lane[index + step]]);
    }

    return hops;
  }

  throw new Error(`Unsupported conversion ${fromVer} -> ${toVer}`);
}

/**
 * List every directed adjacent version pair with a bundled mapping.
 *
 * @returns {Array<[string, string]>} Directed adjacent pairs.
 */
export function getAdjacentPairs() {
  const seen = new Set();
  const pairs = [];
  for (const lane of CONVERSION_LANES) {
    for (let index = 0; index < lane.length - 1; index++) {
      for (const [from, to] of [
        [lane[index], lane[index + 1]],
        [lane[index + 1], lane[index]],
      ]) {
        const key = `${from}->${to}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push([from, to]);
      }
    }
  }

  return pairs;
}
