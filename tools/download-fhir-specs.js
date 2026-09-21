#!/usr/bin/env node
/**
 * @fileoverview Download and verify declared FHIR specification archives.
 */

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { inspectFhirSpecArchive } from './fhir-spec-parser.js';
import { loadSourceDataset, SOURCE_COMPONENT } from './runtime-data-sources.js';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(TOOL_DIR, '..');
const DEFAULT_DATASET_ROOT = path.join(PROJECT_ROOT, 'data/fhir-spec-downloads');

/**
 * Download one URL to a temporary file, following redirects.
 *
 * @param {string} urlText Source URL.
 * @param {string} temporaryFile Temporary destination file.
 * @param {number} redirectsLeft Redirect limit.
 * @returns {Promise<void>} Resolves when complete.
 */
function downloadToTemporaryFile(urlText, temporaryFile, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlText);
    const client = url.protocol === 'http:' ? http : https;
    const request = client.get(url, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 &&
          response.headers.location) {
        response.resume();
        if (redirectsLeft <= 0) {
          reject(new Error(`Too many redirects while downloading ${urlText}`));
          return;
        }
        downloadToTemporaryFile(
          new URL(response.headers.location, url).toString(),
          temporaryFile,
          redirectsLeft - 1,
        ).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed for ${urlText}: HTTP ${response.statusCode}`));
        return;
      }
      const output = fs.createWriteStream(temporaryFile);
      pipeline(response, output).then(resolve, error => {
        reject(new Error(`Download failed for ${urlText}: ${error.message}`, {
          cause: error,
        }));
      });
    });
    request.on('error', reject);
    request.setTimeout(120000, () => {
      request.destroy(new Error(`Download timed out for ${urlText}`));
    });
  });
}

/**
 * Download one missing source archive and publish it after ZIP validation.
 *
 * @param {Object} source Loaded source record.
 * @returns {Promise<void>} Resolves after publication.
 */
async function downloadSource(source) {
  fs.mkdirSync(path.dirname(source.archiveFile), { recursive: true });
  const temporaryFile = `${source.archiveFile}.download-${process.pid}`;
  fs.rmSync(temporaryFile, { force: true });
  try {
    await downloadToTemporaryFile(source.uri, temporaryFile, 5);
    await inspectFhirSpecArchive({
      archiveFile: temporaryFile,
      bundlePaths: source.bundlePaths,
    });
    fs.renameSync(temporaryFile, source.archiveFile);
  } catch (error) {
    fs.rmSync(temporaryFile, { force: true });
    throw error;
  }
}

/**
 * Download missing archives and verify every declared source.
 *
 * @param {string} datasetRoot FHIR source dataset root.
 * @returns {Promise<number>} Number of newly downloaded archives.
 */
export async function downloadFhirSpecs(datasetRoot) {
  const dataset = loadSourceDataset(datasetRoot, SOURCE_COMPONENT.FHIR_TABLES, {
    requireInputs: false,
  });
  let downloaded = 0;
  for (const source of dataset.sources) {
    if (!fs.existsSync(source.archiveFile)) {
      console.error(`Downloading ${source.tableVersion}: ${source.uri}`);
      await downloadSource(source);
      downloaded++;
    }
    await inspectFhirSpecArchive(source);
    console.error(`Verified ${source.tableVersion}: ${source.archivePath}`);
  }

  return downloaded;
}

/**
 * Run the downloader CLI.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {Promise<number>} Process exit code.
 */
export async function main(argv) {
  try {
    let datasetRoot = DEFAULT_DATASET_ROOT;
    if (argv.includes('--help') || argv.includes('-h')) {
      console.log('Usage: node tools/download-fhir-specs.js [--dataset-root DIR]');

      return 0;
    }
    if (argv.length > 0) {
      if (argv.length !== 2 || argv[0] !== '--dataset-root') {
        throw new Error(`Unknown option: ${argv[0]}`);
      }
      datasetRoot = argv[1];
    }
    const downloaded = await downloadFhirSpecs(datasetRoot);
    console.error(`FHIR specification archives are ready (${downloaded} downloaded).`);

    return 0;
  } catch (error) {
    console.error(`Error: ${error.message}`);

    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
