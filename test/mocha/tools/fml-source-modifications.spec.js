/**
 * Guard for the local modifications recorded in the bundled FML snapshot.
 *
 * `data/fhir-cross-version/sources.yaml` declares that the checked-in snapshot
 * differs from its named upstream commit. Replacing the snapshot with a newer
 * upstream drop would silently revert those edits, so this test fails loudly
 * when a recorded modification is no longer present. Whether a given edit can
 * be re-applied depends on the new upstream files and is a maintainer decision;
 * this guard only reports that the edit is gone.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..');
const INPUT_ROOT = path.join(PROJECT_ROOT, 'data/fhir-cross-version/input');

/** Files that must carry the recorded Meta-valued Extension rule. */
const META_EXTENSION_FILES = [
  'R3toR4/Extension.fml',
  'R4toR3/Extension.fml',
];

describe('data/fhir-cross-version recorded modifications', function () {
  it('keeps the Meta-valued Extension rule in the R3/R4 mappings', function () {
    for (const relativePath of META_EXTENSION_FILES) {
      const text = fs.readFileSync(path.join(INPUT_ROOT, relativePath), 'utf8');

      assert.match(
        text,
        /^\s*src\.value\s*:\s*Meta\b.*"valueMeta";\s*$/m,
        `${relativePath} no longer has the Meta-valued Extension rule recorded under ` +
        '"modifications" in data/fhir-cross-version/sources.yaml. If the snapshot was ' +
        'updated, decide whether the rule is still needed and, if so, re-apply it and ' +
        'rebuild the fml-mappings runtime data.',
      );
    }
  });
});

