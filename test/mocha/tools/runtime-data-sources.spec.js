import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadSourceDataset,
  SOURCE_COMPONENT,
} from '../../../tools/runtime-data-sources.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..');

describe('tools/runtime-data-sources', function () {
  it('loads the checked-in FML dataset with paths relative to sources.yaml', function () {
    const dataset = loadSourceDataset(
      path.join(PROJECT_ROOT, 'data/fhir-cross-version'),
      SOURCE_COMPONENT.FML_MAPPINGS,
    );

    assert.equal(dataset.sources.length, 1);
    assert.equal(dataset.sources[0].modifiedFromUpstream, false);
    assert.equal(dataset.sources[0].inputRoot, path.join(dataset.root, 'input'));
    assert.equal(Object.hasOwn(dataset.sources[0], 'sha256'), false);
  });

  it('loads all checked-in FHIR archive declarations without configured hashes', function () {
    const dataset = loadSourceDataset(
      path.join(PROJECT_ROOT, 'data/fhir-spec-downloads'),
      SOURCE_COMPONENT.FHIR_TABLES,
      { requireInputs: false },
    );

    assert.deepEqual(
      dataset.sources.map(source => source.tableVersion),
      ['DSTU2', 'STU3', 'R4', 'R4B', 'R5'],
    );
    assert.equal(dataset.sources.every(source => !Object.hasOwn(source, 'sha256')), true);
  });

  it('requires the resource bundle before the type bundle', function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-sources-'));
    try {
      const sourceFile = path.join(PROJECT_ROOT, 'data/fhir-spec-downloads/sources.yaml');
      const sourceText = fs.readFileSync(sourceFile, 'utf8');
      const resourceThenType = [
        '      - site/profiles-resources.json',
        '      - site/profiles-types.json',
      ].join('\n');
      const typeThenResource = [
        '      - site/profiles-types.json',
        '      - site/profiles-resources.json',
      ].join('\n');
      assert.ok(sourceText.includes(resourceThenType));
      fs.writeFileSync(
        path.join(root, 'sources.yaml'),
        sourceText.replace(resourceThenType, typeThenResource),
      );

      assert.throws(
        () => loadSourceDataset(root, SOURCE_COMPONENT.FHIR_TABLES, { requireInputs: false }),
        /resource bundle followed by the type bundle/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires modification notes only when the modified flag is true', function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-sources-'));
    try {
      fs.mkdirSync(path.join(root, 'input'));
      const base = `schemaVersion: 1
sources:
  - id: example
    inputPath: input
    uri: https://example.test/source
    commit: abc123
    date: '2026-09-01'
    license: Example
`;
      fs.writeFileSync(
        path.join(root, 'sources.yaml'),
        `${base}    modifiedFromUpstream: false\n`,
      );
      assert.doesNotThrow(() => loadSourceDataset(root, SOURCE_COMPONENT.FML_MAPPINGS));

      fs.writeFileSync(
        path.join(root, 'sources.yaml'),
        `${base}    modifiedFromUpstream: true\n`,
      );
      assert.throws(
        () => loadSourceDataset(root, SOURCE_COMPONENT.FML_MAPPINGS),
        /modifications is required/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects unknown fields and unsafe relative paths', function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-sources-'));
    try {
      fs.writeFileSync(path.join(root, 'sources.yaml'), `schemaVersion: 1
sources:
  - id: example
    inputPath: ../outside
    uri: https://example.test/source
    commit: abc123
    date: '2026-09-01'
    license: Example
    modifiedFromUpstream: false
    sha256: forbidden
`);
      assert.throws(
        () => loadSourceDataset(root, SOURCE_COMPONENT.FML_MAPPINGS),
        /sha256 is not supported/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
