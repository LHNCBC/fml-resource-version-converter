/**
 * Tests for the ConceptMap resolution + data-integrity scan (conceptmaps.js).
 *
 * The fixture cases build a throwaway FML directory and pass its root to
 * scanConceptMaps, which also exercises the "check an arbitrary data root"
 * capability. The final case asserts the bundled data is clean for every
 * adjacent pair - the automated counterpart of tools/check-data.js.
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanConceptMaps } from '../../../src/fml_base_conv/conceptmaps.js';
import { getAdjacentPairs } from '../../../src/fml_base_conv/create_converter.js';

describe('fml_base_conv/conceptmaps: scanConceptMaps', function () {
  let root;

  before(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fmlscan-'));
    const dir = path.join(root, 'R4toR5');
    fs.mkdirSync(dir, { recursive: true });
    const fml = [
      'map "http://example/StructureMap/Test" = "Test"',
      'group g(source src, target tgt) {',
      "  src.a -> tgt.a = translate(src.a, 'http://hl7.org/fhir/uv/xver/ConceptMap/SomeMissingMap', 'code');",
      "  src.b -> tgt.b = translate(src.b, '#SomeContainedMap', 'code');",
      '}',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'Test.fml'), fml, 'utf-8');
  });

  after(function () {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports an absent standalone ConceptMap as missing (on a given data root)', function () {
    const scan = scanConceptMaps('R4', 'R5', root);
    assert.deepEqual(scan.missingConceptMaps, ['SomeMissingMap']);
    assert.equal(scan.parseErrors.length, 0);
  });

  it('never reports contained (#-fragment) refs as missing', function () {
    const scan = scanConceptMaps('R4', 'R5', root);
    assert.ok(!scan.missingConceptMaps.some(id => id.startsWith('#')));
  });

  it('returns empty facts for a directory that does not exist', function () {
    // R2->R3 has no fixture directory under this throwaway root.
    const scan = scanConceptMaps('R2', 'R3', root);
    assert.deepEqual(scan.missingConceptMaps, []);
    assert.deepEqual(scan.parseErrors, []);
  });
});

// Ship-time guarantee: the bundled cross-version data must reference no absent
// or unparseable standalone ConceptMaps. This is the automated counterpart of
// running tools/check-data.js against the default (bundled) data root.
describe('fml_base_conv/conceptmaps: bundled data integrity', function () {
  it('every adjacent pair resolves all referenced standalone ConceptMaps', function () {
    for (const [from, to] of getAdjacentPairs()) {
      const { missingConceptMaps, parseErrors } = scanConceptMaps(from, to);
      assert.deepEqual(
        missingConceptMaps, [],
        `${from}->${to} references absent standalone ConceptMap(s): ${missingConceptMaps.join(', ')}`,
      );
      assert.deepEqual(
        parseErrors.map(p => p.id), [],
        `${from}->${to} has unparseable ConceptMap file(s): ${parseErrors.map(p => p.id).join(', ')}`,
      );
    }
  });
});



