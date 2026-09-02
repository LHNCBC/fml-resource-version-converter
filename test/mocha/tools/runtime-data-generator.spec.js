import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { decodeArtifact, decodeBase64 } from '../../../src/runtime/decode.js';
import {
  canonicalStringify,
  manifestArtifacts,
  validateManifest,
} from '../../../src/runtime/schema.js';
import { parseArgs as parseBuildArgs } from '../../../tools/build-runtime-data.js';
import {
  DEFAULT_SOURCE_CHECK_ROOTS,
  parseArgs as parseSourceCheckArgs,
} from '../../../tools/check-runtime-data-sources.js';
import {
  buildAllRuntimeData,
  buildRuntimeDataComponent,
  checkRuntimeDataFreshness,
  hashTree,
  migrateRuntimeDataComponent,
  RUNTIME_COMPONENT,
} from '../../../tools/runtime-data-generator.js';
import { loadRuntimeArtifactRoot } from '../../../tools/runtime-data-root.js';
import {
  loadSourceDataset,
  SOURCE_COMPONENT,
} from '../../../tools/runtime-data-sources.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..');
const FML_DATASET_ROOT = path.join(PROJECT_ROOT, 'data/fhir-cross-version');
const FHIR_DATASET_ROOT = path.join(PROJECT_ROOT, 'data/fhir-spec-downloads');
const COMMITTED_ROOT = path.join(PROJECT_ROOT, 'data/runtime');
const FHIR_TABLE_VERSIONS = ['DSTU2', 'STU3', 'R4', 'R4B', 'R5'];

/**
 * Create a complete, minimal FHIR source dataset for generator tests.
 *
 * @param {string} root Temporary dataset directory.
 * @returns {Promise<void>} Resolves after all fixture ZIPs are written.
 */
async function createFhirDataset(root) {
  const sourceRecords = [];
  for (const tableVersion of FHIR_TABLE_VERSIONS) {
    const archivePath = `${tableVersion}/definitions.json.zip`;
    const archiveFile = path.join(root, ...archivePath.split('/'));
    const resourceBundle = {
      resourceType: 'Bundle',
      entry: [{
        resource: {
          resourceType: 'StructureDefinition',
          id: `Patient-${tableVersion}`,
          kind: 'resource',
          type: 'Patient',
          snapshot: {
            element: [
              { path: 'Patient' },
              { path: 'Patient.name', max: '*', type: [{ code: 'HumanName' }] },
            ],
          },
        },
      }],
    };
    const typeBundle = {
      resourceType: 'Bundle',
      entry: [{
        resource: {
          resourceType: 'StructureDefinition',
          id: `HumanName-${tableVersion}`,
          kind: 'complex-type',
          type: 'HumanName',
          snapshot: {
            element: [
              { path: 'HumanName' },
              { path: 'HumanName.family', max: '1', type: [{ code: 'string' }] },
            ],
          },
        },
      }],
    };
    const zip = new JSZip();
    const entryOptions = { date: new Date('2000-01-01T00:00:00Z') };
    zip.file('profiles-resources.json', JSON.stringify(resourceBundle), entryOptions);
    zip.file('profiles-types.json', JSON.stringify(typeBundle), entryOptions);
    fs.mkdirSync(path.dirname(archiveFile), { recursive: true });
    fs.writeFileSync(archiveFile, await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
    }));
    sourceRecords.push(`  - id: fixture-${tableVersion}
    tableVersion: ${tableVersion}
    version: fixture
    date: '2000-01-01'
    license: Test fixture
    uri: https://example.test/${archivePath}
    archivePath: ${archivePath}
    bundlePaths:
      - profiles-resources.json
      - profiles-types.json`);
  }
  fs.writeFileSync(
    path.join(root, 'sources.yaml'),
    `schemaVersion: 1\nsources:\n${sourceRecords.join('\n')}\n`,
  );
}

/**
 * Import one dependency-free generated envelope.
 *
 * @param {string} root Runtime root.
 * @param {string} relative Module path.
 * @returns {Promise<Object>} Exported artifact envelope.
 */
async function loadEnvelope(root, relative) {
  const source = fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8');
  const module = await import(`data:text/javascript,${encodeURIComponent(source)}`);

  return module.default;
}

/**
 * Require two directory trees to contain identical files and bytes.
 *
 * @param {string} left First directory.
 * @param {string} right Second directory.
 * @returns {void}
 */
function assertTreesEqual(left, right) {
  const leftFiles = [];
  const rightFiles = [];

  /**
   * Collect deterministic relative files.
   *
   * @param {string} root Directory root.
   * @param {string[]} output Output array.
   * @param {string} [relative=''] Relative directory.
   * @returns {void}
   */
  function collect(root, output, relative = '') {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) collect(root, output, child);
      else if (entry.isFile()) output.push(child);
    }
  }

  collect(left, leftFiles);
  collect(right, rightFiles);
  assert.deepEqual(leftFiles, rightFiles);
  for (const relative of leftFiles) {
    assert.deepEqual(
      fs.readFileSync(path.join(left, ...relative.split('/'))),
      fs.readFileSync(path.join(right, ...relative.split('/'))),
      relative,
    );
  }
}

describe('tools/runtime-data-generator', function () {
  let tempRoot;
  let firstRoot;
  let secondRoot;
  let manifest;
  let fmlHashBefore;
  let fhirFixtureRoot;

  before(async function () {
    this.timeout(60_000);
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-data-generator-'));
    firstRoot = path.join(tempRoot, 'first');
    secondRoot = path.join(tempRoot, 'second');
    fhirFixtureRoot = path.join(tempRoot, 'fhir-dataset');
    fs.mkdirSync(fhirFixtureRoot);
    await createFhirDataset(fhirFixtureRoot);
    fmlHashBefore = hashTree(FML_DATASET_ROOT);
    manifest = await buildAllRuntimeData({
      fmlDatasetRoot: FML_DATASET_ROOT,
      fhirDatasetRoot: fhirFixtureRoot,
      runtimeDataRoot: firstRoot,
    });
    await buildAllRuntimeData({
      fmlDatasetRoot: FML_DATASET_ROOT,
      fhirDatasetRoot: fhirFixtureRoot,
      runtimeDataRoot: secondRoot,
    });
  });

  after(function () {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('parses component and full-build dataset options without field overrides', function () {
    assert.throws(() => parseBuildArgs(['--unknown']), /Unknown option/);
    assert.equal(parseBuildArgs(['--help']).help, true);
    assert.throws(
      () => parseBuildArgs([
        'fml-mappings',
        '--runtime-data-root', 'candidate',
        '--fhir-dataset-root', 'unused',
      ]),
      /do not apply to a component build/,
    );
    assert.throws(
      () => parseBuildArgs([
        'all',
        '--runtime-data-root', 'candidate',
        '--dataset-root', 'unused',
      ]),
      /does not apply to all/,
    );
    assert.throws(
      () => parseBuildArgs([
        'fml-mappings',
        '--runtime-data-root', 'first',
        '--runtime-data-root', 'second',
      ]),
      /Duplicate option/,
    );
    assert.deepEqual(
      parseBuildArgs([
        'fml-mappings',
        '--runtime-data-root', 'candidate',
        '--dataset-root', 'alternate',
      ]),
      {
        component: 'fml-mappings',
        runtimeDataRoot: 'candidate',
        datasetRoot: 'alternate',
        fmlDatasetRoot: FML_DATASET_ROOT,
        fhirDatasetRoot: FHIR_DATASET_ROOT,
        help: false,
      },
    );
  });

  it('parses source-equivalence component selection with shared defaults', function () {
    assert.deepEqual(parseSourceCheckArgs([]), {
      ...DEFAULT_SOURCE_CHECK_ROOTS,
      component: 'all',
      help: false,
    });
    assert.equal(
      parseSourceCheckArgs(['fml-mappings', '--fml-dataset-root', 'alternate']).component,
      'fml-mappings',
    );
    assert.throws(
      () => parseSourceCheckArgs(['fml-mappings', '--fhir-dataset-root', 'unused']),
      /does not apply/,
    );
    assert.throws(() => parseSourceCheckArgs(['unknown']), /Unknown component/);
  });

  it('generates independently owned manifest sections', function () {
    validateManifest(manifest);
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.components.fmlMappings.artifacts.length, 8);
    assert.equal(manifest.components.fhirTables.artifacts.length, 5);
    assert.equal(manifest.components.fmlMappings.sources.length, 1);
    assert.equal(manifest.components.fhirTables.sources.length, 5);

    const fmlSource = manifest.components.fmlMappings.sources[0];
    assert.equal(fmlSource.modifiedFromUpstream, false);
    assert.equal(fmlSource.sha256, hashTree(path.join(FML_DATASET_ROOT, 'input')));
    for (const source of manifest.components.fhirTables.sources) {
      assert.match(source.sha256, /^[a-f0-9]{64}$/);
    }
  });

  it('produces byte-identical roots on repeated full builds', function () {
    assertTreesEqual(firstRoot, secondRoot);
  });

  it('derives the same FML artifact bytes as the committed runtime data', function () {
    assertTreesEqual(
      path.join(firstRoot, 'fml-mappings'),
      path.join(COMMITTED_ROOT, 'fml-mappings'),
    );
  });

  it('derives the same FHIR artifact bytes when the official archives are available', async function () {
    this.timeout(60_000);
    const dataset = loadSourceDataset(
      FHIR_DATASET_ROOT,
      SOURCE_COMPONENT.FHIR_TABLES,
      { requireInputs: false },
    );
    if (!dataset.sources.every(source => fs.existsSync(source.archiveFile))) this.skip();
    const actualRoot = path.join(tempRoot, 'official-fhir-build');
    await buildRuntimeDataComponent({
      component: RUNTIME_COMPONENT.FHIR_TABLES,
      datasetRoot: FHIR_DATASET_ROOT,
      runtimeDataRoot: actualRoot,
    });

    assertTreesEqual(
      path.join(actualRoot, 'fhir-tables'),
      path.join(COMMITTED_ROOT, 'fhir-tables'),
    );
  });

  it('meets the selected all-artifact size threshold', async function () {
    const committedManifest = JSON.parse(
      fs.readFileSync(path.join(COMMITTED_ROOT, 'manifest.json'), 'utf8'),
    );
    let canonicalBytes = 0;
    let compressedBytes = 0;
    let base64Bytes = 0;
    for (const artifact of manifestArtifacts(committedManifest)) {
      const envelope = await loadEnvelope(COMMITTED_ROOT, artifact.modulePath);
      canonicalBytes += envelope.uncompressedLength;
      compressedBytes += decodeBase64(envelope.payload, envelope.id).length;
      base64Bytes += envelope.payload.length;
      assert.equal(decodeArtifact(envelope).id, artifact.id);
    }

    assert.ok(base64Bytes < 1_100_000, `Base64 payload was ${base64Bytes} bytes`);
    assert.ok(
      compressedBytes / canonicalBytes < 0.15,
      `Compressed ratio was ${compressedBytes / canonicalBytes}`,
    );
  });

  it('does not modify the source datasets', function () {
    assert.equal(hashTree(FML_DATASET_ROOT), fmlHashBefore);
  });

  it('builds a valid partial root and complete validation rejects it', async function () {
    const partialRoot = path.join(tempRoot, 'partial');
    await buildRuntimeDataComponent({
      component: RUNTIME_COMPONENT.FML_MAPPINGS,
      datasetRoot: FML_DATASET_ROOT,
      runtimeDataRoot: partialRoot,
    });
    const loaded = await loadRuntimeArtifactRoot(partialRoot, { complete: false });

    assert.equal(loaded.artifacts.length, 8);
    assert.equal(Object.hasOwn(loaded.manifest.components, 'fhirTables'), false);
    await assert.rejects(
      () => loadRuntimeArtifactRoot(partialRoot),
      /complete validation requires fhirTables/,
    );
  });

  it('replaces only the selected component', async function () {
    const target = path.join(tempRoot, 'component-update');
    fs.cpSync(firstRoot, target, { recursive: true });
    const tableHash = hashTree(path.join(target, 'fhir-tables'));
    const tableSection = canonicalStringify(
      manifest.components.fhirTables,
    );
    await buildRuntimeDataComponent({
      component: RUNTIME_COMPONENT.FML_MAPPINGS,
      datasetRoot: FML_DATASET_ROOT,
      runtimeDataRoot: target,
    });
    const updated = JSON.parse(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8'));

    assert.equal(hashTree(path.join(target, 'fhir-tables')), tableHash);
    assert.equal(canonicalStringify(updated.components.fhirTables), tableSection);
  });

  it('migrates both components symmetrically without rebuilding them', async function () {
    const target = path.join(tempRoot, 'migrated');
    await migrateRuntimeDataComponent({
      component: RUNTIME_COMPONENT.FML_MAPPINGS,
      fromRuntimeDataRoot: firstRoot,
      toRuntimeDataRoot: target,
    });
    await migrateRuntimeDataComponent({
      component: RUNTIME_COMPONENT.FHIR_TABLES,
      fromRuntimeDataRoot: firstRoot,
      toRuntimeDataRoot: target,
    });
    const migrated = await loadRuntimeArtifactRoot(target);

    assert.equal(migrated.artifacts.length, 13);
    assertTreesEqual(firstRoot, target);
  });

  it('checks source equivalence without modifying the selected runtime root', async function () {
    this.timeout(60_000);
    const rootHashBefore = hashTree(firstRoot);
    const result = await checkRuntimeDataFreshness({
      runtimeDataRoot: firstRoot,
      fmlDatasetRoot: FML_DATASET_ROOT,
      fhirDatasetRoot: fhirFixtureRoot,
    });

    assert.deepEqual(result, { fresh: true, outputsCompared: 14 });
    assert.equal(hashTree(firstRoot), rootHashBefore);
  });

  it('checks either component independently', async function () {
    this.timeout(60_000);
    const damagedOtherComponentRoot = path.join(tempRoot, 'damaged-other-component');
    fs.cpSync(firstRoot, damagedOtherComponentRoot, { recursive: true });
    fs.writeFileSync(path.join(damagedOtherComponentRoot, 'fhir-tables/R4.js'), 'invalid\n');

    const fmlResult = await checkRuntimeDataFreshness({
      component: RUNTIME_COMPONENT.FML_MAPPINGS,
      runtimeDataRoot: damagedOtherComponentRoot,
      fmlDatasetRoot: FML_DATASET_ROOT,
    });
    const fhirResult = await checkRuntimeDataFreshness({
      component: RUNTIME_COMPONENT.FHIR_TABLES,
      runtimeDataRoot: firstRoot,
      fhirDatasetRoot: fhirFixtureRoot,
    });

    assert.deepEqual(fmlResult, { fresh: true, outputsCompared: 9 });
    assert.deepEqual(fhirResult, { fresh: true, outputsCompared: 6 });
  });

  it('leaves the target unchanged when a component build fails', async function () {
    const target = path.join(tempRoot, 'failed-update');
    fs.cpSync(firstRoot, target, { recursive: true });
    const hashBefore = hashTree(target);

    await assert.rejects(() => buildRuntimeDataComponent({
      component: RUNTIME_COMPONENT.FHIR_TABLES,
      datasetRoot: path.join(tempRoot, 'missing-dataset'),
      runtimeDataRoot: target,
    }), /Dataset root cannot be read/);
    assert.equal(hashTree(target), hashBefore);
  });
});
