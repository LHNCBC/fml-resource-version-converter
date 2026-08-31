import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dstu2TableEnvelope from '../../../data/runtime/fhir-tables/DSTU2.js';
import r4TableEnvelope from '../../../data/runtime/fhir-tables/R4.js';
import r4bTableEnvelope from '../../../data/runtime/fhir-tables/R4B.js';
import r5TableEnvelope from '../../../data/runtime/fhir-tables/R5.js';
import stu3TableEnvelope from '../../../data/runtime/fhir-tables/STU3.js';
import { converterFactory } from '../../../src/converter/converterFactory.js';
import { loadRuntimeDataRoot } from '../../../tools/runtime-data-root.js';
import { decodeArtifact, decodeBase64 } from '../../../src/runtime/decode.js';
import { validateManifest } from '../../../src/runtime/schema.js';
import { parseArgs } from '../../../tools/build-runtime-data.js';
import { compactConceptMap } from '../../../tools/runtime-artifacts-lib.js';
import {
  checkRuntimeDataFreshness,
  generateRuntimeData,
  hashTree,
  readCrossVersionSource,
} from '../../../tools/runtime-data-generator.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..');
const XVER_ROOT = path.join(PROJECT_ROOT, 'data/fhir-cross-version/input');
const XVER_SOURCE = readCrossVersionSource(
  path.join(PROJECT_ROOT, 'data/fhir-cross-version/source.json'),
);
const FHIR_SPEC_ROOT = path.join(PROJECT_ROOT, 'data/fhir-spec-downloads');
const TABLE_ENVELOPES = [
  dstu2TableEnvelope,
  stu3TableEnvelope,
  r4TableEnvelope,
  r4bTableEnvelope,
  r5TableEnvelope,
];

/**
 * Materialize verified committed table payloads as generator inputs.
 *
 * The generated `data/fhir-defs` directory is a maintainer intermediate, not a
 * tracked test fixture. Using decoded committed artifacts keeps generator tests
 * independent of that optional directory while retaining complete table values.
 *
 * @param {string} root Temporary definitions root.
 * @returns {void}
 */
function materializeFhirDefinitions(root) {
  fs.mkdirSync(root, { recursive: true });
  for (const envelope of TABLE_ENVELOPES) {
    const { data } = decodeArtifact(envelope);
    fs.writeFileSync(
      path.join(root, `${data.fhirVersion}.json`),
      `${JSON.stringify(data)}\n`,
      'utf8',
    );
  }
}

/**
 * List all files below a root in deterministic order.
 *
 * @param {string} root Directory root.
 * @returns {string[]} Relative POSIX paths.
 */
function listFiles(root) {
  const result = [];

  /**
   * Visit one directory.
   *
   * @param {string} directory Absolute directory.
   * @param {string} relative Relative directory.
   * @returns {void}
   */
  function visit(directory, relative) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(path.join(directory, entry.name), childRelative);
      } else if (entry.isFile()) {
        result.push(childRelative);
      }
    }
  }

  visit(root, '');

  return result;
}

/**
 * Import and decode one generated artifact module.
 *
 * @param {string} root Generated root.
 * @param {string} relative Module path.
 * @returns {Promise<Object>} Decoded artifact.
 */
async function loadArtifact(root, relative) {
  const source = fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8');
  const module = await import(`data:text/javascript,${encodeURIComponent(source)}`);

  return decodeArtifact(module.default);
}

/**
 * Import one dependency-free generated envelope from its module source.
 *
 * @param {string} root Generated root.
 * @param {string} relative Module path.
 * @returns {Promise<Object>} Artifact envelope.
 */
async function loadEnvelope(root, relative) {
  const source = fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8');
  const module = await import(`data:text/javascript,${encodeURIComponent(source)}`);

  return module.default;
}

describe('tools/runtime-data-generator', function () {
  let tempRoot;
  let firstRoot;
  let secondRoot;
  let reviewRoot;
  let fhirDefsRoot;
  let manifest;
  let sourceHashBefore;

  before(async function () {
    this.timeout(30000);
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-data-generator-'));
    firstRoot = path.join(tempRoot, 'first');
    secondRoot = path.join(tempRoot, 'second');
    reviewRoot = path.join(tempRoot, 'review');
    fhirDefsRoot = path.join(tempRoot, 'fhir-defs');
    materializeFhirDefinitions(fhirDefsRoot);
    sourceHashBefore = hashTree(XVER_ROOT);
    manifest = await generateRuntimeData({
      output: firstRoot,
      reviewOutput: reviewRoot,
      xverRoot: XVER_ROOT,
      fhirDefsRoot,
      fhirSpecRoot: FHIR_SPEC_ROOT,
    });
    await generateRuntimeData({
      output: secondRoot,
      xverRoot: XVER_ROOT,
      fhirDefsRoot,
      fhirSpecRoot: FHIR_SPEC_ROOT,
    });
  });

  after(function () {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('requires a caller-selected output directory', function () {
    assert.throws(() => parseArgs(['--unknown']), /Unknown option/);
    assert.equal(parseArgs(['--help']).help, true);
    assert.equal(parseArgs(['--output', 'candidate']).output, 'candidate');
    const alternate = parseArgs([
      '--check-root', 'current',
      '--fhir-table-runtime-root', 'tables',
      '--xver-source-commit', 'alternate-commit',
    ]);
    assert.equal(alternate.checkRoot, 'current');
    assert.equal(alternate.fhirTableRuntimeRoot, 'tables');
    assert.equal(alternate.xverSource.commit, 'alternate-commit');
  });

  it('generates eight mapping and five FHIR-table artifacts with a valid manifest', function () {
    validateManifest(manifest);
    assert.equal(manifest.artifacts.length, 13);
    assert.equal(
      manifest.artifacts.filter(artifact => artifact.kind === 'fml-mappings').length,
      8,
    );
    assert.equal(
      manifest.artifacts.filter(artifact => artifact.kind === 'fhir-table').length,
      5,
    );
    assert.equal(manifest.format.compression.codec, 'zlib');
    const fflatePackage = JSON.parse(fs.readFileSync(
      path.join(PROJECT_ROOT, 'node_modules/fflate/package.json'),
      'utf8',
    ));
    assert.equal(manifest.format.compression.implementationVersion, fflatePackage.version);
    assert.equal(manifest.sources.length, 6);
    assert.deepEqual(
      manifest.sources.find(source => source.id === XVER_SOURCE.id),
      { ...XVER_SOURCE, sha256: hashTree(XVER_ROOT) },
    );
  });

  it('produces byte-identical roots on repeated generation', function () {
    const firstFiles = listFiles(firstRoot);

    assert.deepEqual(listFiles(secondRoot), firstFiles);
    for (const relative of firstFiles) {
      assert.deepEqual(
        fs.readFileSync(path.join(firstRoot, ...relative.split('/'))),
        fs.readFileSync(path.join(secondRoot, ...relative.split('/'))),
        relative,
      );
    }
  });

  it('preserves every FML file and ConceptMap and round-trips committed tables', async function () {
    for (const artifact of manifest.artifacts) {
      const decoded = await loadArtifact(firstRoot, artifact.modulePath);
      if (artifact.kind === 'fml-mappings') {
        const { from, to } = decoded.data.direction;
        const pair = `${from}to${to}`;
        const expectedFiles = fs.readdirSync(path.join(XVER_ROOT, pair), {
          withFileTypes: true,
        })
          .filter(entry => entry.isFile() && entry.name.endsWith('.fml'))
          .map(entry => `${pair}/${entry.name}`)
          .sort();
        assert.deepEqual(Object.keys(decoded.data.files).sort(), expectedFiles);

        for (const [virtualFile, text] of Object.entries(decoded.data.files)) {
          assert.equal(
            text,
            fs.readFileSync(path.join(XVER_ROOT, ...virtualFile.split('/')), 'utf8'),
            virtualFile,
          );
        }
        for (const conceptMap of decoded.data.conceptMaps) {
          const source = JSON.parse(fs.readFileSync(
            path.join(XVER_ROOT, ...conceptMap.virtualFile.split('/')),
            'utf8',
          ));
          assert.deepEqual(
            conceptMap,
            compactConceptMap(source, conceptMap.virtualFile, conceptMap.url),
            conceptMap.virtualFile,
          );
        }
        continue;
      }

      const version = decoded.data.fhirVersion;
      const sourceTable = JSON.parse(fs.readFileSync(
        path.join(fhirDefsRoot, `${version}.json`),
        'utf8',
      ));
      for (const field of ['polyPaths', 'arrayPaths', 'elementTypes', 'resourceTypes']) {
        assert.deepEqual(decoded.data[field], sourceTable[field], `${version}.${field}`);
      }
    }
  });

  it('writes optional canonical review JSON outside the artifact root', function () {
    const review = fs.readFileSync(path.join(reviewRoot, 'fhir-tables/R4.json'), 'utf8');
    const parsed = JSON.parse(review);

    assert.equal(parsed.fhirVersion, 'R4');
    assert.ok(!listFiles(firstRoot).some(relative => relative.endsWith('.review.json')));
  });

  it('meets the selected all-artifact size threshold', async function () {
    let canonicalBytes = 0;
    let compressedBytes = 0;
    let base64Bytes = 0;
    for (const artifact of manifest.artifacts) {
      const envelope = await loadEnvelope(firstRoot, artifact.modulePath);
      canonicalBytes += envelope.uncompressedLength;
      compressedBytes += decodeBase64(envelope.payload, envelope.id).length;
      base64Bytes += envelope.payload.length;
    }

    assert.ok(base64Bytes < 1_100_000, `Base64 payload was ${base64Bytes} bytes`);
    assert.ok(
      compressedBytes / canonicalBytes < 0.15,
      `Compressed ratio was ${compressedBytes / canonicalBytes}`,
    );
  });

  it('does not modify the cross-version source tree', function () {
    assert.equal(hashTree(XVER_ROOT), sourceHashBefore);
  });

  it('reuses verified FHIR tables for an alternate mapping snapshot', async function () {
    this.timeout(30000);
    const alternateXverRoot = path.join(tempRoot, 'alternate-xver');
    const alternateOutput = path.join(tempRoot, 'alternate-output');
    fs.cpSync(XVER_ROOT, alternateXverRoot, { recursive: true });
    fs.appendFileSync(
      path.join(alternateXverRoot, 'R4toR5/Questionnaire.fml'),
      '\n// Alternate snapshot marker.\n',
      'utf8',
    );
    const alternateSource = {
      ...XVER_SOURCE,
      uri: 'https://example.test/alternate-fhir-cross-version',
      commit: 'alternate-commit',
      date: '2026-08-27',
    };
    const alternateManifest = await generateRuntimeData({
      output: alternateOutput,
      xverRoot: alternateXverRoot,
      fhirTableRuntimeRoot: firstRoot,
      xverSource: alternateSource,
    });

    const source = alternateManifest.sources.find(item => item.id === alternateSource.id);
    assert.equal(source.uri, alternateSource.uri);
    assert.equal(source.commit, alternateSource.commit);
    assert.equal(source.sha256, hashTree(alternateXverRoot));
    for (const version of ['DSTU2', 'STU3', 'R4', 'R4B', 'R5']) {
      const relative = `fhir-tables/${version}.js`;
      assert.deepEqual(
        fs.readFileSync(path.join(alternateOutput, relative)),
        fs.readFileSync(path.join(firstRoot, relative)),
        relative,
      );
    }
    assert.notDeepEqual(
      fs.readFileSync(path.join(alternateOutput, 'fml-mappings/R4toR5.js')),
      fs.readFileSync(path.join(firstRoot, 'fml-mappings/R4toR5.js')),
    );

    const runtimeData = await loadRuntimeDataRoot(alternateOutput);
    const converters = converterFactory.create(runtimeData);
    const converted = converters.singleHopConverter.convert({
      resourceType: 'Questionnaire',
      status: 'active',
      item: [{ linkId: 'choice', type: 'choice' }],
    }, 'R4', 'R5');
    assert.equal(converted.resource.item[0].type, 'coding');
    assert.equal(converted.resource.item[0].answerConstraint, 'optionsOnly');

    const originalRootHash = hashTree(firstRoot);
    await assert.rejects(() => checkRuntimeDataFreshness({
      runtimeDataRoot: firstRoot,
      xverRoot: alternateXverRoot,
      fhirTableRuntimeRoot: firstRoot,
      xverSource: alternateSource,
    }), /Runtime data root is stale/);
    assert.equal(hashTree(firstRoot), originalRootHash);
  });

  it('checks freshness without modifying the selected runtime root', async function () {
    const rootHashBefore = hashTree(firstRoot);
    const result = await checkRuntimeDataFreshness({
      runtimeDataRoot: firstRoot,
      xverRoot: XVER_ROOT,
      fhirTableRuntimeRoot: firstRoot,
      xverSource: XVER_SOURCE,
    });

    assert.deepEqual(result, { fresh: true, filesCompared: 14 });
    assert.equal(hashTree(firstRoot), rootHashBefore);
  });

  it('does not publish a partial root when an input is missing', async function () {
    const output = path.join(tempRoot, 'failed');
    const emptySpecs = path.join(tempRoot, 'empty-specs');
    fs.mkdirSync(emptySpecs);

    await assert.rejects(() => generateRuntimeData({
      output,
      xverRoot: XVER_ROOT,
      fhirDefsRoot,
      fhirSpecRoot: emptySpecs,
    }), /ENOENT/);
    assert.equal(fs.existsSync(output), false);
  });
});
