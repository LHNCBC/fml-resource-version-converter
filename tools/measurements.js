/**
 * @fileoverview Formatting helpers for the measurements the tools report.
 *
 * The project does not cap package size, artifact size, or initialization
 * time. Those follow from the data the strategy selects, so a cap would only
 * fail a build for a legitimate upstream change. The tools measure and print
 * instead, so a maintainer can see movement and judge it.
 *
 * @module tools/measurements
 */

/**
 * Format a byte count with thousands separators and a readable magnitude.
 *
 * @param {number} bytes Byte count.
 * @returns {string} Formatted byte count.
 */
export function formatBytes(bytes) {
  const exact = Math.round(bytes).toLocaleString('en-US');
  if (bytes < 1024) return `${exact} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }

  return `${exact} B (${value.toFixed(1)} ${units[unit]})`;
}

/**
 * Format an elapsed duration in milliseconds.
 *
 * @param {number} milliseconds Elapsed milliseconds.
 * @returns {string} Formatted duration.
 */
export function formatDuration(milliseconds) {
  if (milliseconds < 1000) return `${milliseconds.toFixed(0)} ms`;

  return `${(milliseconds / 1000).toFixed(1)} s`;
}

/**
 * Start an elapsed-time measurement.
 *
 * @returns {function(): number} Returns elapsed milliseconds when called.
 */
export function startTimer() {
  const started = process.hrtime.bigint();

  return () => Number(process.hrtime.bigint() - started) / 1e6;
}

/**
 * Render a titled block of aligned label/value measurement rows.
 *
 * @param {string} title Report heading.
 * @param {Array<[string, string|number]>} rows Label/value pairs.
 * @returns {string} Formatted report ending in a newline.
 */
export function formatReport(title, rows) {
  const width = rows.reduce((longest, [label]) => Math.max(longest, label.length), 0);
  const lines = rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`);

  return `${title}\n${lines.join('\n')}\n`;
}

/**
 * Measure the encoded and canonical sizes carried by artifact envelopes.
 *
 * @param {Object[]} envelopes Artifact envelopes.
 * @returns {{count: number, base64Bytes: number, compressedBytes: number,
 *   canonicalBytes: number, ratio: number}} Measured sizes.
 */
export function summarizeArtifactSizes(envelopes) {
  let base64Bytes = 0;
  let compressedBytes = 0;
  let canonicalBytes = 0;
  for (const envelope of envelopes) {
    const payload = envelope.payload;
    const padding = payload.endsWith('==') ? 2 : (payload.endsWith('=') ? 1 : 0);
    base64Bytes += payload.length;
    compressedBytes += (payload.length / 4) * 3 - padding;
    canonicalBytes += envelope.uncompressedLength;
  }

  return {
    count: envelopes.length,
    base64Bytes,
    compressedBytes,
    canonicalBytes,
    ratio: canonicalBytes === 0 ? 0 : compressedBytes / canonicalBytes,
  };
}

/**
 * Render the measurement rows shared by every artifact size report.
 *
 * @param {Object} sizes Result of `summarizeArtifactSizes`.
 * @returns {Array<[string, string]>} Label/value pairs.
 */
export function artifactSizeRows(sizes) {
  return [
    ['canonical JSON', formatBytes(sizes.canonicalBytes)],
    ['compressed', formatBytes(sizes.compressedBytes)],
    ['Base64 payload', formatBytes(sizes.base64Bytes)],
    ['compression ratio', `${(sizes.ratio * 100).toFixed(1)}% of canonical`],
  ];
}


