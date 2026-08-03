#!/usr/bin/env node
/**
 * @fileoverview Regenerate data/fhir-defs from official FHIR spec archives.
 *
 * By default, this script does not use the network. It checks that the expected
 * raw FHIR spec archives are present under data/fhir-spec-downloads/ and then
 * invokes tools/build_fhir_tables.js once per version.
 *
 * Use --download-missing to fetch missing archives before building.
 */

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TOOL_DIR, '..');
const BUILD_TABLES_SCRIPT = path.join(TOOL_DIR, 'build_fhir_tables.js');

const SPEC_DIR = path.join(REPO_ROOT, 'data/fhir-spec-downloads');
const OUT_DIR = path.join(REPO_ROOT, 'data/fhir-defs');

const SPECS = [
  {
    version: 'DSTU2',
    archive: 'fhir-spec.zip',
    url: 'https://hl7.org/fhir/DSTU2/fhir-spec.zip',
  },
  {
    version: 'STU3',
    archive: 'definitions.json.zip',
    url: 'https://hl7.org/fhir/STU3/definitions.json.zip',
  },
  {
    version: 'R4',
    archive: 'definitions.json.zip',
    url: 'https://hl7.org/fhir/R4/definitions.json.zip',
  },
  {
    version: 'R4B',
    archive: 'definitions.json.zip',
    url: 'https://hl7.org/fhir/R4B/definitions.json.zip',
  },
  {
    version: 'R5',
    archive: 'definitions.json.zip',
    url: 'https://hl7.org/fhir/R5/definitions.json.zip',
  },
];

/**
 * Print usage information.
 */
function printUsage() {
  console.log(`Usage: node tools/build-fhir-defs.js [options]

Regenerate data/fhir-defs/<VERSION>.json from official FHIR spec archives.

Options:
  --download-missing     Download missing source archives before building.
  --help                 Show this help.

Default behavior does not use the network. If archives are missing, run:
  npm run build:fhir-defs -- --download-missing
`);
}

/**
 * Parse command-line arguments.
 *
 * @param {Array<string>} argv Command-line arguments after node/script.
 * @returns {Object} Parsed options.
 * @throws {Error} If an option is invalid.
 */
function parseArgs(argv) {
  const opts = {
    downloadMissing: false,
    help: false,
  };

  for (const arg of argv) {
    switch (arg) {
      case '--download-missing':
        opts.downloadMissing = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return opts;
}

/**
 * Build the archive specifications with absolute paths.
 *
 * @returns {Array<Object>} Archive specs.
 */
function specsWithFiles() {
  return SPECS.map(spec => ({
    ...spec,
    file: path.join(SPEC_DIR, spec.version, spec.archive),
  }));
}

/**
 * Return whether an archive file exists and is non-empty.
 *
 * @param {string} file Archive path.
 * @returns {boolean} True when the file exists and has content.
 */
function archiveExists(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size > 0;
  }
  catch {
    return false;
  }
}

/**
 * Print a missing-archive report.
 *
 * @param {Array<Object>} missing Missing archive specs.
 */
function printMissingReport(missing) {
  console.error('Missing FHIR spec archives:');
  for (const spec of missing) {
    console.error(`- ${path.relative(REPO_ROOT, spec.file)}`);
    console.error(`  ${spec.url}`);
  }
  console.error('\nRun:');
  console.error('  npm run build:fhir-defs -- --download-missing');
}

/**
 * Download one URL to a destination file, following redirects.
 *
 * @param {string} url Source URL.
 * @param {string} dest Destination file path.
 * @param {number} [redirectsLeft=5] Redirect limit.
 * @returns {Promise<void>} Resolves when the file is downloaded.
 */
async function downloadFile(url, dest, redirectsLeft = 5) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.download`;
  fs.rmSync(tmp, { force: true });

  try {
    await downloadToTemp(url, tmp, redirectsLeft);
    fs.renameSync(tmp, dest);
  }
  catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Download one URL to a temporary file.
 *
 * @param {string} urlText Source URL.
 * @param {string} tmp Temporary destination file.
 * @param {number} redirectsLeft Redirect limit.
 * @returns {Promise<void>} Resolves when complete.
 */
function downloadToTemp(urlText, tmp, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlText);
    const client = url.protocol === 'http:' ? http : https;
    const req = client.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          reject(new Error(`Too many redirects while downloading ${urlText}`));
          return;
        }
        const redirected = new URL(res.headers.location, url).toString();
        downloadToTemp(redirected, tmp, redirectsLeft - 1).then(resolve, reject);
        return;
      }

      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Download failed for ${urlText}: HTTP ${res.statusCode}`));
        return;
      }

      const out = fs.createWriteStream(tmp);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => {
      req.destroy(new Error(`Download timed out for ${urlText}`));
    });
  });
}

/**
 * Download missing source archives.
 *
 * @param {Array<Object>} specs Archive specs.
 * @returns {Promise<void>} Resolves when all requested downloads finish.
 */
async function downloadMissingArchives(specs) {
  for (const spec of specs) {
    if (archiveExists(spec.file)) {
      console.error(`Found ${path.relative(REPO_ROOT, spec.file)}`);
      continue;
    }
    console.error(`Downloading ${spec.version}: ${spec.url}`);
    await downloadFile(spec.url, spec.file);
    console.error(`Wrote ${path.relative(REPO_ROOT, spec.file)}`);
  }
}

/**
 * Run the existing per-version FHIR table generator.
 *
 * @param {Array<Object>} specs Archive specs.
 * @param {string} outDir Output directory.
 */
function buildTables(specs, outDir) {
  for (const spec of specs) {
    console.error(`Building ${spec.version} from ${path.relative(REPO_ROOT, spec.file)}`);
    const result = spawnSync(process.execPath, [
      BUILD_TABLES_SCRIPT,
      spec.version,
      spec.file,
      outDir,
    ], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      throw new Error(`build_fhir_tables.js failed for ${spec.version}`);
    }
  }
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
}
catch (err) {
  console.error(`Error: ${err.message}\n`);
  printUsage();
  process.exit(2);
}

if (opts.help) {
  printUsage();
  process.exit(0);
}

const specs = specsWithFiles();
const missing = specs.filter(spec => !archiveExists(spec.file));

if (missing.length > 0 && !opts.downloadMissing) {
  printMissingReport(missing);
  process.exit(1);
}

if (opts.downloadMissing) {
  await downloadMissingArchives(specs);
}

const stillMissing = specs.filter(spec => !archiveExists(spec.file));
if (stillMissing.length > 0) {
  printMissingReport(stillMissing);
  process.exit(1);
}

console.error(`FHIR spec archives ready: ${specs.map(spec => spec.version).join(', ')}`);

buildTables(specs, OUT_DIR);
