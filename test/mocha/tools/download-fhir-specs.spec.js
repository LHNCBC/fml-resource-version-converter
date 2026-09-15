import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { downloadFhirSpecs } from '../../../tools/download-fhir-specs.js';

const FHIR_TABLE_VERSIONS = ['DSTU2', 'STU3', 'R4', 'R4B', 'R5'];

/**
 * Create a FHIR source dataset whose archives share one test URL.
 *
 * @param {string} root Temporary dataset directory.
 * @param {string} uri Archive URL.
 * @returns {void}
 */
function createFhirDataset(root, uri) {
  const sources = FHIR_TABLE_VERSIONS.map(tableVersion => `  - id: fixture-${tableVersion}
    tableVersion: ${tableVersion}
    version: fixture
    date: '2000-01-01'
    license: Test fixture
    uri: ${uri}
    archivePath: ${tableVersion}/definitions.json.zip
    bundlePaths:
      - profiles-resources.json
      - profiles-types.json`);
  fs.writeFileSync(
    path.join(root, 'sources.yaml'),
    `schemaVersion: 1\nsources:\n${sources.join('\n')}\n`,
  );
}

describe('tools/download-fhir-specs', function () {
  let server;
  let tempRoot;

  before(async function () {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'download-fhir-specs-'));
    server = http.createServer((request, response) => {
      response.writeHead(200, { 'Content-Length': '1024' });
      response.write('incomplete archive');
      setImmediate(() => response.destroy());
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    createFhirDataset(tempRoot, `http://127.0.0.1:${server.address().port}/archive.zip`);
  });

  after(async function () {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('rejects a truncated response and removes the partial archive', async function () {
    let timeout;
    try {
      await assert.rejects(
        Promise.race([
          downloadFhirSpecs(tempRoot),
          new Promise((resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error('Download did not reject promptly')),
              1_000,
            );
          }),
        ]),
        error => {
          assert.notEqual(error.message, 'Download did not reject promptly');
          assert.match(error.message, /^Download failed for http:\/\/127\.0\.0\.1:\d+\/archive\.zip: /);
          assert.ok(
            error.cause?.code === 'ECONNRESET' ||
              error.cause?.code === 'ERR_STREAM_PREMATURE_CLOSE',
            `Unexpected download error: ${error.message}`,
          );

          return true;
        },
      );
    } finally {
      clearTimeout(timeout);
    }

    const archiveFile = path.join(tempRoot, 'DSTU2/definitions.json.zip');
    assert.equal(fs.existsSync(archiveFile), false);
    assert.equal(fs.existsSync(`${archiveFile}.download-${process.pid}`), false);
  });
});
