/**
 * Public package subpath and packed-content acceptance tests.
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  collectPackageReport,
  validateCommittedRuntimeRoot,
  validatePackageReport,
} from '../../tools/check-package.js';

const PACKAGE_NAME = '@lhncbc/fml-resource-version-converter';
const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');
const RUNTIME_SUBPATHS = [
  'all',
  'r2-to-r3',
  'r3-to-r2',
  'r3-to-r4',
  'r4-to-r3',
  'r4-to-r5',
  'r4b-to-r5',
  'r5-to-r4',
  'r5-to-r4b',
];

describe('public package subpaths', function () {
  it('exports the code-only converter factory', async function () {
    const module = await import(`${PACKAGE_NAME}/converter-factory`);

    assert.deepEqual(Object.keys(module), ['converterFactory']);
    assert.equal(typeof module.converterFactory.create, 'function');
  });

  for (const subpath of RUNTIME_SUBPATHS) {
    it(`exports runtime/${subpath}`, async function () {
      const module = await import(`${PACKAGE_NAME}/runtime/${subpath}`);

      assert.deepEqual(Object.keys(module), ['default']);
      assert.equal(module.default.schemaVersion, 1);
      assert.equal(Object.isFrozen(module.default), true);
    });
  }

  it('marks only the executable CLI as side-effectful', function () {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'),
    );

    assert.deepEqual(packageJson.sideEffects, ['./bin/convert.js']);
  });
});

describe('packed package', function () {
  this.timeout(30_000);

  it('validates committed artifacts and final packed contents', async function () {
    const runtime = await validateCommittedRuntimeRoot();
    const measurements = validatePackageReport(collectPackageReport());

    assert.equal(runtime.artifactCount, 13);
    assert.ok(measurements.unpackedBytes > 0);
    assert.ok(measurements.compressedBytes > 0);
    assert.ok(measurements.fileCount > 0);
  });
});
