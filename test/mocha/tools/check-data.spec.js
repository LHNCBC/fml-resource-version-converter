/**
 * Command-level tests for tools/check-data.js.
 *
 * The tool statically audits the bundled cross-version ConceptMap data. These
 * tests drive it as a subprocess and assert that (a) the default bundled root
 * passes cleanly, and (b) a missing/unreadable root is reported as clean
 * per-pair failures - every pair enumerated, a FAILED summary printed, and a
 * non-zero exit - rather than aborting mid-run with an uncaught stack trace.
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const TOOL = path.resolve(import.meta.dirname, '../../../tools/check-data.js');

/**
 * Run the check-data tool with the given arguments.
 *
 * @param {Array<string>} args CLI arguments (e.g. a data-root path).
 * @returns {{status: number, stdout: string, stderr: string}} Process result.
 */
function run(args) {
  return spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf-8' });
}

describe('tools/check-data.js', function () {
  // The default-root scan reads the bundled data from disk; give it headroom.
  this.timeout(20000);

  it('passes cleanly on the bundled default data root', function () {
    const res = run([]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /Data integrity check passed\./);
  });

  it('reports a missing root as clean per-pair failures without an uncaught crash', function () {
    const res = run([path.join('/tmp', 'fml-check-data-does-not-exist-xyz')]);

    // Non-zero exit, but via the tool's own failure path (not a thrown crash).
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Data integrity check FAILED\./);

    // Every pair is enumerated in a single run as a clean ERROR line, rather
    // than aborting at the first one.
    const errorLines = res.stderr.split('\n').filter(l => l.startsWith('ERROR '));
    assert.ok(errorLines.length >= 2, `expected multiple ERROR lines, got ${errorLines.length}`);
    assert.ok(errorLines.every(l => /Cannot read ConceptMap directory/.test(l)));

    // The summary line (which a mid-run crash would have skipped) is printed.
    assert.match(res.stdout, /Summary: \d+ pair\(s\) checked;.*scan error\(s\)\./);
  });
});

