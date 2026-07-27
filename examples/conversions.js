/**
 * @fileoverview Runnable examples for the FML-based FHIR resource version converter.
 *
 * Run from the repository root:
 *   node examples/conversions.js
 *
 * In your own project, import from the package instead of the relative src path:
 *   import { singleHopConverter, chainedConverter, COVERAGE, infoMessage }
 *     from '@lhncbc/fml-resource-version-converter';
 *
 * Demonstrates, simplest to most involved:
 *   1. A single adjacent hop (singleHopConverter.convert) - flat result.
 *   2. A simple multi-hop chain (chainedConverter.convert) with one boundary
 *      preprocessor and one boundary postprocessor.
 *   3. A non-trivial multi-hop chain with per-hop, per-type postprocessors. It
 *      also shows (commented out) how contained-resource types would be targeted
 *      once contained-resource support lands.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  singleHopConverter,
  chainedConverter,
  COVERAGE,
  infoMessage,
} from '../src/index.js';

const DATA = path.resolve(import.meta.dirname, '../test/data');
const load = file => JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf-8'));

/**
 * Print a compact summary of a conversion result.
 *
 * @param {string} label Human-readable label for the run.
 * @param {Object} result A conversion result (flat or chained).
 * @returns {void}
 */
function summarize(label, result) {
  const hops = result.hops
    ? result.hops.map(h => `${h.fromVer}->${h.toVer}`).join(', ')
    : '(flat single-hop result; no hops[])';
  console.log(`\n== ${label} ==`);
  console.log(`  resourceType: ${result.resource.resourceType}`);
  console.log(`  status:       ${result.status}`);
  console.log(`  coverage:     ${result.coverage}`);
  console.log(`  hops:         ${hops}`);
}

/**
 * Print each hop's report (FML step plus any pre-/postprocessors).
 *
 * @param {Object} result A chained conversion result.
 * @returns {void}
 */
function printHops(result) {
  for (const hop of result.hops) {
    const pre = (hop.preprocessors || []).map(p => p.name).join(', ') || '(none)';
    const post = (hop.postprocessors || []).map(p => p.name).join(', ') || '(none)';
    console.log(
      `  hop ${hop.fromVer}->${hop.toVer}: ` +
      `fml=${hop.fml_base_conv.coverage}, preprocessors=[${pre}], postprocessors=[${post}]`,
    );
  }
}

const r4Questionnaire = load('qn-ver-conv-test-r4base.json');
const r3Questionnaire = load('qn-ver-conv-test-stu3base.json');

// ---------------------------------------------------------------------------
// 1. Single adjacent hop: R4 -> R5.
//    singleHopConverter.convert returns a FLAT result (no hops[] array); it is
//    the terse call for one adjacent pair and the building block for chains.
// ---------------------------------------------------------------------------
const single = singleHopConverter.convert(r4Questionnaire, 'R4', 'R5');
summarize('single hop      R4 -> R5  (singleHopConverter.convert)', single);

// ---------------------------------------------------------------------------
// 2. Simple chain: R3 -> R5 (runs as R3 -> R4 -> R5) with ONE boundary
//    preprocessor and ONE boundary postprocessor for the primary resource.
//    - preproc is applied to the first hop (the very first processor to run).
//    - postproc is applied to the last hop (the very last; its output is final).
// ---------------------------------------------------------------------------
const tagBeforeConversion = {
  name: 'example_pre',
  description: 'Example preprocessor: applied to the first hop (the very first processor).',
  execute: source => ({
    resource: source,
    status: 'ok',
    messages: [infoMessage('example preproc ran on the source')],
  }),
};
const tagAfterConversion = {
  name: 'example_post',
  coverage: COVERAGE.NEUTRAL,   // makes no completeness claim (only annotates)
  description: 'Example postprocessor: applied to the last hop (the very last processor).',
  execute: target => ({
    resource: target,
    status: 'ok',
    messages: [infoMessage('example postproc ran on the final result')],
  }),
};

const simpleChain = chainedConverter.convert(r3Questionnaire, 'R3', 'R5', {
  preproc: [tagBeforeConversion],
  postproc: [tagAfterConversion],
});
summarize('chain (simple)  R3 -> R5  (one boundary preproc + postproc)', simpleChain);
printHops(simpleChain);

// ---------------------------------------------------------------------------
// 3. Non-trivial chain: R3 -> R5 with postprocessors that DIFFER per hop
//    (keyed by "ResourceType:from->to"), plus a boundary preprocessor.
// ---------------------------------------------------------------------------
const notePrimarySource = {
  name: 'example_note_source',
  description: 'Example preprocessor: inspects/annotates the R3 source resource.',
  execute: source => ({
    resource: source,
    status: 'ok',
    messages: [infoMessage('example preproc: inspected the R3 source')],
  }),
};

// In a keyed map, a bare list appends to the package registry's postprocessors
// for that same key. COVERAGE.NEUTRAL means the processor makes no completeness
// claim (these only annotate), so it never lowers the hop's coverage.
const noteR3toR4 = {
  name: 'example_note_R3_to_R4',
  coverage: COVERAGE.NEUTRAL,
  description: 'Example postprocessor for the R3 -> R4 hop.',
  execute: target => ({
    resource: target,
    status: 'ok',
    messages: [infoMessage('example postproc ran on the R3 -> R4 hop')],
  }),
};
const noteR4toR5 = {
  name: 'example_note_R4_to_R5',
  coverage: COVERAGE.NEUTRAL,
  description: 'Example postprocessor for the R4 -> R5 hop.',
  execute: target => ({
    resource: target,
    status: 'ok',
    messages: [infoMessage('example postproc ran on the R4 -> R5 hop')],
  }),
};

const perHopChain = chainedConverter.convert(r3Questionnaire, 'R3', 'R5', {
  preproc: [notePrimarySource],
  // Keyed `preprocs` could run a preprocessor on a SPECIFIC hop - including an
  // intermediate hop - e.g. preprocs: { 'Questionnaire:R4->R5': [somePre] }.
  // (preproc and preprocs are mutually exclusive, so this example keeps the
  // boundary preproc above.)

  // Each key is "ResourceType:from->to" - one resource type on one hop of the
  // planned path. Here the primary Questionnaire gets a different postprocessor
  // on each hop of R3 -> R4 -> R5.
  postprocs: {
    'Questionnaire:R3->R4': [noteR3toR4],
    'Questionnaire:R4->R5': [noteR4toR5],

    // --- Contained resource types (NOT YET SUPPORTED) ---------------------
    // If this Questionnaire contained other resources (say an Observation and
    // a ValueSet), you would target THEIR conversions on each hop of the path
    // in exactly the same way - one entry per (type, hop). This depends on
    // contained-resource orchestration, which is planned but NOT yet available:
    // the converter does not currently convert a resource's contained[] entries,
    // so the entries below are commented out (today they would simply never run,
    // because no contained Observation/ValueSet is ever converted).
    //
    // 'Observation:R3->R4': [fixObservationR3toR4],
    // 'Observation:R4->R5': [fixObservationR4toR5],
    // 'ValueSet:R3->R4':    [fixValueSetR3toR4],
    // 'ValueSet:R4->R5':    [fixValueSetR4toR5],
  },

  checkCoverage: true,
});
summarize('chain (per-hop) R3 -> R5  (postprocessors keyed by type:hop)', perHopChain);
printHops(perHopChain);

console.log();

