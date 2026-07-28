/**
 * CLI tests for bin/convert.js diagnostics aggregation.
 *
 * The conversion result rolls status up across the FML stage AND the
 * postprocessors. These tests drive the real CLI as a subprocess and assert
 * that postprocessor warnings/info are surfaced and counted on stderr (not just
 * the FML stage), with and without --verbose. The R4 fixture is the same one
 * the postprocessor unit tests use, so it reliably produces both a
 * postprocessor warning (dropped enableWhen with no STU3 equivalent) and
 * postprocessor info (options.reference, initialSelected).
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CLI = path.resolve(import.meta.dirname, '../../../bin/convert.js');
const FIXTURE = path.resolve(import.meta.dirname, '../../data/qn-ver-conv-test-r4base.json');
const r4Input = fs.readFileSync(FIXTURE, 'utf-8');

/**
 * Run the CLI with the R4 fixture piped on stdin.
 *
 * @param {Array<string>} args CLI arguments (e.g. ['R4', 'R3']).
 * @returns {{status: number, stdout: string, stderr: string}} Process result.
 */
function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    input: r4Input,
    encoding: 'utf-8',
  });
}

describe('bin/convert.js CLI diagnostics', function () {
  it('surfaces and counts postprocessor warnings, not just the FML stage', function () {
    const res = runCli(['R4', 'R3']);
    assert.equal(res.status, 0);

    // Overall status is warning and the count is non-zero (was warnings=0 before
    // aggregation, because the CLI only read the FML stage).
    assert.match(res.stderr, /status=warning/);
    assert.doesNotMatch(res.stderr, /warnings=0/);

    // The postprocessor's own warning is printed, tagged with its hop + stage.
    assert.match(res.stderr, /Questionnaire_R4_to_R3\] warning:/);
    assert.match(res.stderr, /no STU3 equivalent/);

    // The converted resource still goes to stdout as valid JSON.
    const out = JSON.parse(res.stdout);
    assert.equal(out.resourceType, 'Questionnaire');
  });

  it('hides info by default but reports the hidden count', function () {
    const res = runCli(['R4', 'R3']);
    assert.match(res.stderr, /info=[1-9]/);
    assert.match(res.stderr, /info messages hidden; pass --verbose/);
    // Info text itself is not printed without --verbose.
    assert.doesNotMatch(res.stderr, / info: /);
  });

  it('prints info (including postprocessor info) with --verbose', function () {
    const res = runCli(['--verbose', 'R4', 'R3']);
    assert.equal(res.status, 0);
    // Verbose shows info lines and drops the "hidden" note.
    assert.match(res.stderr, / info: /);
    assert.doesNotMatch(res.stderr, /info messages hidden/);
  });
});

