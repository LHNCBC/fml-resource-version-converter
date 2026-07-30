/**
 * Exhaustive test: parse every FML file in data/fhir-cross-version/input and
 * ensure compileFmlXver succeeds without throwing.
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { compileFmlXver } from '../../../src/fml_base_conv/fml_xver_engine.js';
import { tokenise } from '../../../src/fml_base_conv/fml_parser.js';

const FML_ROOT = path.resolve(import.meta.dirname, '../../../data/fhir-cross-version/input');

const DIRS = [
  'R2toR3', 'R3toR2', 'R3toR4', 'R4toR3',
  'R4toR5', 'R5toR4', 'R4BtoR5', 'R5toR4B',
];

describe('FML parse: all cross-version files', function () {
  for (const dir of DIRS) {
    const dirPath = path.join(FML_ROOT, dir);
    if (!fs.existsSync(dirPath)) continue;

    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.fml')).sort();

    it(`parses all ${files.length} files in ${dir}`, function () {
      const failures = [];
      for (const file of files) {
        try {
          const fmlText = fs.readFileSync(path.join(dirPath, file), 'utf-8');
          const engine = compileFmlXver({ fmlText, onWarning: () => {} });
          if (!engine.convert || engine.groups.length === 0) {
            failures.push(`${file}: missing convert or groups`);
          }
        } catch (e) {
          failures.push(`${file}: ${e.message}`);
        }
      }
      assert.deepEqual(failures, [], `${failures.length} file(s) failed:\n  ${failures.join('\n  ')}`);
    });
  }
});

// A standalone minus (e.g. the `- 1` in `where (v = ( - 1))`) must tokenise as
// a MINUS token, not trigger an "unrecognised character" warning. Otherwise the
// warning leaks into any conversion that merely imports the file (all sibling
// FML files are loaded for wildcard imports).
describe('FML tokeniser: standalone minus', function () {
  it('tokenises a signed numeric guard cleanly (MINUS token, no warnings)', function () {
    const warnings = [];
    const tokens = tokenise(
      'src.strand as v where (v = ( - 1)) -> tgt.strand = \'crick\';',
      w => warnings.push(w),
    );
    assert.deepEqual(warnings, [], `unexpected tokenizer warnings: ${warnings.join(', ')}`);
    assert.ok(tokens.some(t => t.kind === 'MINUS'), 'expected a MINUS token');
  });

  it('MolecularSequence R3toR4 compiles without a stray "-" warning', function () {
    const fmlText = fs.readFileSync(
      path.join(FML_ROOT, 'R3toR4', 'MolecularSequence.fml'), 'utf-8',
    );
    const warnings = [];
    compileFmlXver({ fmlText, onWarning: w => warnings.push(w) });
    const stray = warnings.filter(w => w.includes('unrecognised character "-"'));
    assert.deepEqual(stray, [], `unexpected stray-minus warnings: ${stray.join(', ')}`);
  });
});

