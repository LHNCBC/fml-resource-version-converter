/**
 * @fileoverview Portable random UUID generation for postprocessors.
 *
 * Postprocessors run in Node and in the browser, so they must not import a
 * Node built-in such as node:crypto: the runtime entry points are checked to
 * be free of Node built-ins. The Web Crypto API is available in both
 * environments via globalThis, so it is used directly with no import.
 *
 * Two Web Crypto entry points are tried in order:
 *   - crypto.randomUUID(), which is the cheapest and is present in Node 19+
 *     and in modern browsers, but only in secure contexts (HTTPS/localhost).
 *   - crypto.getRandomValues(), which has no secure-context restriction, and
 *     from which a version 4 UUID is formatted here.
 *
 * A caller reaching neither gets a hard error rather than a weak identifier,
 * because these UUIDs become FHIR resource identifiers.
 *
 * @module postprocessors/util/uuid
 */

/** Byte values rendered as two-digit lowercase hex, indexed by byte. */
const HEX_BY_BYTE = Array.from(
  { length: 256 },
  (unused, value) => value.toString(16).padStart(2, '0'),
);

/**
 * Format 16 random bytes as a canonical version 4 UUID string.
 *
 * Sets the version (4) and IETF variant bits required by RFC 4122 before
 * rendering the 8-4-4-4-12 hexadecimal form.
 *
 * @param {Uint8Array} bytes Exactly 16 random bytes, mutated in place.
 * @returns {string} Canonical lowercase UUID.
 */
function formatUuidV4(bytes) {
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = [];
  for (const byte of bytes) hex.push(HEX_BY_BYTE[byte]);

  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-');
}

/**
 * Generate a random version 4 UUID without importing a Node built-in.
 *
 * @returns {string} Canonical lowercase UUID.
 * @throws {Error} If the Web Crypto API is unavailable.
 */
export function randomUuid() {
  const webCrypto = globalThis.crypto;

  if (typeof webCrypto?.randomUUID === 'function') {
    return webCrypto.randomUUID();
  }

  if (typeof webCrypto?.getRandomValues === 'function') {
    return formatUuidV4(webCrypto.getRandomValues(new Uint8Array(16)));
  }

  throw new Error(
    'randomUuid: the Web Crypto API is unavailable, so no UUID can be generated',
  );
}
