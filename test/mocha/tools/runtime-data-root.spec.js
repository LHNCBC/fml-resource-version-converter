import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { converterFactory } from '../../../src/converter/converterFactory.js';
import {
  loadRuntimeArtifactRoot,
  loadRuntimeDataRoot,
} from '../../../tools/runtime-data-root.js';
import { canonicalStringify } from '../../../src/runtime/schema.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..');
const COMMITTED_ROOT = path.join(PROJECT_ROOT, 'data/runtime');

/**
 * Copy the committed runtime root into a caller-owned temporary directory.
 *
 * @param {string} parent Temporary parent directory.
 * @param {string} name Child directory name.
 * @returns {string} Copied runtime root.
 */
function copyRuntimeRoot(parent, name) {
  const root = path.join(parent, name);
  fs.cpSync(COMMITTED_ROOT, root, { recursive: true });

  return root;
}

/**
 * Write a manifest using its required canonical representation.
 *
 * @param {string} root Runtime root.
 * @param {Object} manifest Manifest value.
 * @returns {void}
 */
function writeManifest(root, manifest) {
  fs.writeFileSync(
    path.join(root, 'manifest.json'),
    `${canonicalStringify(manifest)}\n`,
    'utf8',
  );
}

describe('tools/runtime-data-root', function () {
  let tempRoot;

  before(function () {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-data-root-'));
  });

  after(function () {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('loads all indexed artifacts from a complete root', async function () {
    const loaded = await loadRuntimeArtifactRoot(COMMITTED_ROOT);

    assert.equal(loaded.artifacts.length, 13);
    assert.equal(loaded.manifest.artifacts.length, 13);
  });

  it('drives the synchronous converter pipeline after asynchronous loading', async function () {
    const runtimeData = await loadRuntimeDataRoot(COMMITTED_ROOT);
    const converters = converterFactory.create(runtimeData);
    const result = converters.singleHopConverter.convert({
      resourceType: 'Questionnaire',
      status: 'draft',
    }, 'R4', 'R5');

    assert.equal(result.resource.resourceType, 'Questionnaire');
    assert.equal(result.resource.status, 'draft');
  });

  it('rejects an incomplete manifest', async function () {
    const root = copyRuntimeRoot(tempRoot, 'incomplete');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    manifest.artifacts.pop();
    writeManifest(root, manifest);

    await assert.rejects(
      () => loadRuntimeDataRoot(root),
      /artifact set is incomplete.*missing fhir-tables\/R5/,
    );
  });

  it('rejects a missing indexed module', async function () {
    const root = copyRuntimeRoot(tempRoot, 'missing-module');
    fs.rmSync(path.join(root, 'fhir-tables/R4.js'));

    await assert.rejects(
      () => loadRuntimeDataRoot(root),
      /Runtime artifact module cannot be read.*R4\.js/,
    );
  });

  it('rejects a corrupt artifact before converter construction', async function () {
    const root = copyRuntimeRoot(tempRoot, 'corrupt');
    const file = path.join(root, 'fml-mappings/R4toR5.js');
    const source = fs.readFileSync(file, 'utf8').replace(/("payload": ")[A-Za-z0-9+/]/, '$1!');
    fs.writeFileSync(file, source, 'utf8');

    await assert.rejects(
      () => loadRuntimeDataRoot(root),
      /payload must be canonical Base64/,
    );
  });

  it('rejects manifest metadata that differs from its verified envelope', async function () {
    const root = copyRuntimeRoot(tempRoot, 'manifest-mismatch');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    manifest.artifacts[0].sha256 = '0'.repeat(64);
    writeManifest(root, manifest);

    await assert.rejects(
      () => loadRuntimeDataRoot(root),
      /manifest entry "fml-mappings\/R2toR3" sha256 does not match its envelope/,
    );
  });

  it('rejects a non-canonical manifest', async function () {
    const root = copyRuntimeRoot(tempRoot, 'noncanonical');
    const file = path.join(root, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    await assert.rejects(() => loadRuntimeDataRoot(root), /manifest is not canonical JSON/);
  });
});
