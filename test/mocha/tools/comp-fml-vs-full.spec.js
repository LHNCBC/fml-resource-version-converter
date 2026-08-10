/**
 * CLI tests for tools/comp-fml-vs-full.js.
 *
 * The tool compares raw FML output with the full single-hop pipeline. The FML
 * engine returns an envelope ({ resource, spinOffResources? }); the tool must
 * compare only the resource, otherwise the envelope wrapper reports as a total
 * mismatch (every field a false diff). These tests drive the real tool as a
 * subprocess and assert:
 *   1. A conversion with no package postprocessor reports MATCH and exits 0.
 *   2. A postprocessed conversion reports only real resource-level differences
 *      (never the envelope wrapper) and exits 1.
 *
 * The R4 fixture is the same one the postprocessor unit tests use. It has no
 * postprocessor for R4 -> R5 (clean MATCH) and a real one for R4 -> R3 (drops
 * enableWhen entries with no STU3 equivalent).
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const TOOL = path.resolve(import.meta.dirname, '../../../tools/comp-fml-vs-full.js');
const FIXTURE = path.resolve(import.meta.dirname, '../../data/qn-ver-conv-test-r4base.json');

/**
 * Run the comparison tool as a subprocess.
 *
 * @param {Array<string>} args Positional args (from-version, to-version, file).
 * @returns {{status: number, stdout: string, stderr: string}} Process result.
 */
function runTool(args) {
  return spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf-8' });
}

describe('tools/comp-fml-vs-full.js FML-vs-Full comparison', function () {
  it('reports MATCH and exits 0 when no postprocessor runs (Questionnaire R4 -> R5)', function () {
    const res = runTool(['R4', 'R5', FIXTURE]);

    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Postprocessors: none/);
    assert.match(res.stdout, /FML vs Full: MATCH/);
    // The engine envelope must never leak into the comparison.
    assert.doesNotMatch(res.stdout, /\$\.resource\b/);
  });

  it('reports only real resource-level differences (not the envelope) when a postprocessor runs (Questionnaire R4 -> R3)', function () {
    const res = runTool(['R4', 'R3', FIXTURE]);

    // The R4 -> R3 postprocessor drops enableWhen entries with no STU3
    // equivalent, so genuine resource-level differences are expected.
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /Postprocessors: 1/);
    assert.match(res.stdout, /FML vs Full: \d+ difference/);
    // The pre-fix symptoms were "$.resource present only in FML" plus every
    // real field "missing in FML output". Neither may appear after the fix.
    assert.doesNotMatch(res.stdout, /\$\.resource: present in FML output/);
    assert.doesNotMatch(res.stdout, /\$\.resourceType: missing in FML output/);
  });
});

