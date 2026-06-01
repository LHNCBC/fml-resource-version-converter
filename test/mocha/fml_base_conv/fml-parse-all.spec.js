/**
 * Exhaustive test: parse every FML file in fhir-cross-version/input and
 * ensure compileFmlXver succeeds without throwing.
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { compileFmlXver } from '../../../src/fml_base_conv/fml_xver_engine.js';

const FML_ROOT = path.resolve(import.meta.dirname, '../../../fhir-cross-version/input');

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
