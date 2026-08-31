/**
 * @fileoverview Portable synchronous decoding for generated runtime artifacts.
 *
 * This module is browser-safe: it uses Uint8Array, TextDecoder, global atob,
 * and fflate. It deliberately does not use Buffer, node:crypto, or filesystem
 * APIs.
 *
 * @module runtime/decode
 */

import { unzlibSync } from 'fflate';
import {
  ARTIFACT_CODEC,
  canonicalStringify,
  validateArtifactEnvelope,
  validateDecodedArtifact,
} from './schema.js';

const SHA256_INITIAL = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);
const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * Rotate a 32-bit word right.
 *
 * @param {number} value Word to rotate.
 * @param {number} bits Rotation width.
 * @returns {number} Rotated unsigned word.
 */
function rotateRight(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

/**
 * Decode canonical Base64 without relying on Node's Buffer global.
 *
 * @param {string} value Canonical Base64 text.
 * @param {string} [identity='<unknown>'] Artifact identity for diagnostics.
 * @returns {Uint8Array} Decoded bytes.
 */
export function decodeBase64(value, identity = '<unknown>') {
  if (typeof globalThis.atob !== 'function') {
    throw new Error(`Runtime artifact "${identity}": Base64 decoding is unavailable`);
  }

  let binary;
  try {
    binary = globalThis.atob(value);
  } catch (error) {
    throw new Error(
      `Runtime artifact "${identity}": Base64 payload cannot be decoded: ${error.message}`,
      { cause: error },
    );
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

/**
 * Compute a lowercase SHA-256 digest synchronously with portable JavaScript.
 *
 * @param {Uint8Array} input Bytes to hash.
 * @returns {string} Lowercase hexadecimal digest.
 */
export function sha256Hex(input) {
  if (!(input instanceof Uint8Array)) {
    throw new TypeError('SHA-256 input must be a Uint8Array');
  }

  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;

  const bitLengthHigh = Math.floor(input.length / 0x20000000);
  const bitLengthLow = (input.length << 3) >>> 0;
  const lengthOffset = paddedLength - 8;
  padded[lengthOffset] = bitLengthHigh >>> 24;
  padded[lengthOffset + 1] = bitLengthHigh >>> 16;
  padded[lengthOffset + 2] = bitLengthHigh >>> 8;
  padded[lengthOffset + 3] = bitLengthHigh;
  padded[lengthOffset + 4] = bitLengthLow >>> 24;
  padded[lengthOffset + 5] = bitLengthLow >>> 16;
  padded[lengthOffset + 6] = bitLengthLow >>> 8;
  padded[lengthOffset + 7] = bitLengthLow;

  const hash = new Uint32Array(SHA256_INITIAL);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index++) {
      const byteOffset = offset + index * 4;
      words[index] = (
        (padded[byteOffset] << 24) |
        (padded[byteOffset + 1] << 16) |
        (padded[byteOffset + 2] << 8) |
        padded[byteOffset + 3]
      ) >>> 0;
    }
    for (let index = 16; index < 64; index++) {
      const previous = words[index - 15];
      const recent = words[index - 2];
      const sigma0 = rotateRight(previous, 7) ^
        rotateRight(previous, 18) ^ (previous >>> 3);
      const sigma1 = rotateRight(recent, 17) ^
        rotateRight(recent, 19) ^ (recent >>> 10);
      words[index] = (
        words[index - 16] + sigma0 + words[index - 7] + sigma1
      ) >>> 0;
    }

    let a = hash[0];
    let b = hash[1];
    let c = hash[2];
    let d = hash[3];
    let e = hash[4];
    let f = hash[5];
    let g = hash[6];
    let h = hash[7];

    for (let index = 0; index < 64; index++) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choice + SHA256_CONSTANTS[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }

  return [...hash].map(word => word.toString(16).padStart(8, '0')).join('');
}

/**
 * Decode, parse, and validate one generated artifact envelope.
 *
 * @param {Object} envelope Generated artifact envelope.
 * @param {boolean} verifyEncoding Whether to verify the payload hash and
 *   canonical JSON encoding.
 * @returns {{id: string, kind: string, sha256: string, data: Object}} Decoded artifact.
 */
function decodeArtifactInternal(envelope, verifyEncoding) {
  validateArtifactEnvelope(envelope);
  const label = `Runtime artifact "${envelope.id}"`;

  if (envelope.codec !== ARTIFACT_CODEC) {
    throw new Error(`${label}: unsupported codec "${envelope.codec}"`);
  }

  let bytes;
  try {
    bytes = unzlibSync(decodeBase64(envelope.payload, envelope.id));
  } catch (error) {
    throw new Error(`${label}: zlib payload cannot be decoded: ${error.message}`, {
      cause: error,
    });
  }

  if (bytes.length !== envelope.uncompressedLength) {
    throw new Error(
      `${label}: decoded length ${bytes.length} does not match ` +
      `declared length ${envelope.uncompressedLength}`,
    );
  }

  if (verifyEncoding) {
    const digest = sha256Hex(bytes);
    if (digest !== envelope.sha256) {
      throw new Error(
        `${label}: SHA-256 ${digest} does not match declared hash ${envelope.sha256}`,
      );
    }
  }

  let text;
  let data;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label}: decoded payload is not valid UTF-8 JSON: ${error.message}`, {
      cause: error,
    });
  }

  if (verifyEncoding) {
    let canonical;
    try {
      canonical = canonicalStringify(data);
    } catch (error) {
      throw new Error(`${label}: decoded payload is not canonical JSON: ${error.message}`, {
        cause: error,
      });
    }
    if (canonical !== text) {
      throw new Error(`${label}: decoded payload is not canonical JSON`);
    }
  }

  const decoded = Object.freeze({
    id: envelope.id,
    kind: envelope.kind,
    sha256: envelope.sha256,
    data,
  });
  validateDecodedArtifact(decoded, envelope.kind, label, '$');

  return decoded;
}

/**
 * Decode and fully verify an artifact from a maintainer or alternate root.
 *
 * @param {Object} envelope Generated artifact envelope.
 * @returns {{id: string, kind: string, sha256: string, data: Object}} Decoded artifact.
 */
export function decodeArtifact(envelope) {
  return decodeArtifactInternal(envelope, true);
}

/**
 * Decode a package-owned artifact already verified before publication.
 *
 * Runtime decoding retains envelope, codec, length, JSON, and payload-schema
 * validation while avoiding repeated publication-time hash and canonical-form
 * verification during application startup.
 *
 * @param {Object} envelope Package-owned generated artifact envelope.
 * @returns {{id: string, kind: string, sha256: string, data: Object}} Decoded artifact.
 */
export function decodeTrustedArtifact(envelope) {
  return decodeArtifactInternal(envelope, false);
}
