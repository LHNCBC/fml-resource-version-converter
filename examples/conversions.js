/**
 * @fileoverview Runnable examples for the FML-based FHIR resource version converter.
 *
 * Run from the repository root:
 *   node examples/conversions.js
 *
 * Demonstrates:
 *   1. Single adjacent hop (R4 -> R5) - printing WHAT the conversion changed, by
 *      diffing the input against the converted output.
 *   2. Multi-hop chain (R3 -> R5) with a REAL postprocessor that mutates the
 *      output (stamps a provenance tag), keyed to one specific hop, plus a
 *      readout of the per-hop conversion report.
 */
import {
  singleHopConverter,
  chainedConverter,
  COVERAGE,
  infoMessage,
} from '@lhncbc/fml-resource-version-converter';

/**
 * Flatten a JSON value into a map of leaf path -> primitive value for display.
 * Object keys and array indices are joined into a dotted/bracketed path, e.g.
 * "item[0].type". Only primitive leaves are recorded, which is enough to show
 * what a conversion added, removed, or changed.
 *
 * @param {*} value  The value to flatten (object, array, or primitive).
 * @param {string} prefix  Path prefix for the current value (internal use).
 * @param {Object<string, *>} out  Accumulator map (internal use).
 * @returns {Object<string, *>} Map of leaf path to primitive value.
 */
function flattenLeaves(value, prefix = '', out = {}) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => flattenLeaves(item, `${prefix}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      flattenLeaves(value[key], path, out);
    }
  } else {
    out[prefix] = value;
  }

  return out;
}

/**
 * Print the leaf-level differences between a resource before and after a
 * conversion, so the reader can see WHAT the mapping actually did.
 *
 * @param {Object} before  The resource passed into the converter.
 * @param {Object} after  The converted resource returned by the converter.
 * @returns {void}
 */
function printDiff(before, after) {
  const a = flattenLeaves(before);
  const b = flattenLeaves(after);
  const paths = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  console.log('  changes (input -> output):');

  let changes = 0;
  for (const p of paths) {
    const inA = Object.prototype.hasOwnProperty.call(a, p);
    const inB = Object.prototype.hasOwnProperty.call(b, p);

    if (inA && !inB) {
      console.log(`    - removed  ${p} = ${JSON.stringify(a[p])}`);
      changes++;
    } else if (!inA && inB) {
      console.log(`    + added    ${p} = ${JSON.stringify(b[p])}`);
      changes++;
    } else if (a[p] !== b[p]) {
      console.log(`    ~ changed  ${p}: ${JSON.stringify(a[p])} -> ${JSON.stringify(b[p])}`);
      changes++;
    }
  }

  if (changes === 0) {
    console.log('    (no leaf-level changes)');
  }
}

/**
 * Print a compact summary of a conversion result.
 *
 * Demonstrates reading the top-level result fields:
 *   result.resource      - the converted FHIR resource
 *   result.status        - 'ok' or 'warning'
 *   result.coverage      - rolled-up coverage level
 *   result.hops          - present only on a chained result (undefined on a
 *                          flat single-hop result)
 *
 * @param {string} label  Human-readable label for the run.
 * @param {Object} result  A conversion result (flat or chained).
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
 * Demonstrates reading the per-hop report fields on a chained result:
 *   hop.fromVer / hop.toVer      - the versions this hop bridges
 *   hop.fml_base_conv.coverage   - coverage of the FML mapping step
 *   hop.preprocessors            - descriptors that ran before the FML step
 *   hop.postprocessors           - descriptors that ran after the FML step
 *
 * @param {Object} result  A chained conversion result.
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

// Inline R4 Questionnaire (choice item with answerOption).
const r4Questionnaire = {
  resourceType: 'Questionnaire',
  status: 'active',
  title: 'Demo form',
  item: [
    {
      linkId: 'q1',
      text: 'Favorite color?',
      type: 'choice',
      answerOption: [
        { valueCoding: { code: 'blue', display: 'Blue' } },
      ],
    },
  ],
};

// Inline R3 (STU3) Questionnaire. Note the STU3 spelling `option` (choice list),
// which the R3 -> R4 mapping renames to `answerOption`; the diff below makes
// that visible.
const r3Questionnaire = {
  resourceType: 'Questionnaire',
  status: 'draft',
  title: 'Demo form',
  item: [
    {
      linkId: 'q1',
      text: 'Favorite color?',
      type: 'choice',
      option: [
        { valueCoding: { code: 'blue', display: 'Blue' } },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// 1. Single adjacent hop: R4 -> R5.
//    singleHopConverter.convert returns a FLAT result (no hops[]). We print the
//    input-vs-output diff so you can see WHAT the mapping produced, not just the
//    status/coverage metadata.
// ---------------------------------------------------------------------------
const singleHopResult = singleHopConverter.convert(r4Questionnaire, 'R4', 'R5');
summarize('single hop      R4 -> R5  (singleHopConverter.convert)', singleHopResult);
printDiff(r4Questionnaire, singleHopResult.resource);

// ---------------------------------------------------------------------------
// 2. Multi-hop chain: R3 -> R5 (runs as R3 -> R4 -> R5) with a REAL
//    postprocessor keyed to the R4 -> R5 hop.
//
//    Unlike a no-op annotator, this postprocessor mutates the output: it stamps
//    a provenance tag onto meta.tag. It claims COVERAGE.NEUTRAL because tagging
//    makes no completeness claim, so it never lowers the hop's coverage.
//
//    The key "Questionnaire:R4->R5" names one resource type on one hop of the
//    planned path; a bare list appends to the package's registered
//    postprocessors for that same key.
// ---------------------------------------------------------------------------
const provenanceTagPostprocessor = {
  name: 'example_stamp_tag',
  coverage: COVERAGE.NEUTRAL,
  description: 'Example postprocessor: stamps a provenance tag onto meta.tag.',
  execute: target => {
    target.meta = target.meta || {};
    target.meta.tag = target.meta.tag || [];
    target.meta.tag.push({
      system: 'http://example.org/conversion',
      code: 'converted-by-example',
    });

    return {
      resource: target,
      status: 'ok',
      messages: [infoMessage('example postproc stamped a provenance tag')],
    };
  },
};

const chainResult = chainedConverter.convert(r3Questionnaire, 'R3', 'R5', {
  postprocs: {
    'Questionnaire:R4->R5': [provenanceTagPostprocessor],
  },
  checkCoverage: true,
});
summarize('chain           R3 -> R5  (real postprocessor on the R4 -> R5 hop)', chainResult);
printHops(chainResult);
printDiff(r3Questionnaire, chainResult.resource);
console.log('  stamped meta.tag:', JSON.stringify(chainResult.resource.meta?.tag));

console.log();
