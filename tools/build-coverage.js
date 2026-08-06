#!/usr/bin/env node
/**
 * @fileoverview Generate COVERAGE.md from the postprocessor registry.
 *
 * Walks the consolidated registry (one section per directed FHIR version pair)
 * and emits a Markdown report of conversion coverage per resource type: the FML
 * mapping's coverage, the package postprocessors, the rolled-up cumulative
 * coverage, and the combined descriptions.
 *
 * The registry is the single source of truth; this file only renders it, so the
 * report can never drift from the code. Output is deterministic (resource types
 * sorted, no timestamp), so regenerating is a no-op unless the registry changes.
 *
 * Usage:
 *   node tools/build-coverage.js [outputFile]   # default: <repoRoot>/COVERAGE.md
 *   node tools/build-coverage.js --stdout        # print to stdout instead
 *
 * @module tools/build-coverage
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  getConsolidatedRegistry,
  registeredDirections,
} from '../src/postprocessors/registry.js';
import { COVERAGE, rollupHopCoverage } from '../src/converter/coverage.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/**
 * Turn a direction key like 'R4->R5' into a display label 'R4 -> R5'.
 *
 * @param {string} key Direction key.
 * @returns {string} Display label.
 */
function directionLabel(key) {
  const [from, to] = key.split('->');
  return `${from} -> ${to}`;
}

/**
 * Build a heading anchor the way GitHub/GitLab slug headings: lowercase, drop
 * characters other than a-z/0-9/space/hyphen, then spaces to hyphens.
 *
 * @param {string} text Heading text.
 * @returns {string} Anchor slug.
 */
function anchor(text) {
  return text.toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-');
}

/**
 * Escape a value for use inside a Markdown table cell (pipes and newlines).
 *
 * @param {*} value Any value.
 * @returns {string} Cell-safe text.
 */
function mdCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

/**
 * Build the combined description cell: the FML note plus each postprocessor's
 * description, one per line.
 *
 * @param {Object} entry Registry entry.
 * @returns {string} Description cell.
 */
function describeCell(entry) {
  const parts = [];
  if (entry.fml.description) parts.push(`**FML:** ${entry.fml.description}`);
  for (const p of entry.processors) {
    if (p.description) parts.push(`**${p.name}:** ${p.description}`);
  }
  return parts.length ? parts.map(mdCell).join('<br>') : '-';
}

/**
 * Effective postprocessor coverage: the last non-neutral coverage declared by
 * the postprocessors (each declares the cumulative level after it runs), or
 * null when there are no postprocessors or all are neutral.
 *
 * @param {Object} entry Registry entry.
 * @returns {string|null} Postprocessor coverage level, or null.
 */
function postprocessorCoverage(entry) {
  let level = null;
  for (const p of entry.processors) {
    if (p.coverage == null || p.coverage === COVERAGE.NEUTRAL) continue;
    level = p.coverage;
  }
  return level;
}

/**
 * Overall coverage: the FML coverage rolled up with the postprocessors', using
 * the same rollup the runtime uses.
 *
 * @param {Object} entry Registry entry.
 * @returns {string} Overall coverage level.
 */
function overallCoverage(entry) {
  return rollupHopCoverage(entry.fml.coverage, entry.processors.map(p => p.coverage));
}

/**
 * Render one directed-pair section: a heading plus a table. Every table ends
 * with an "All other resource types" row stating the default for anything not
 * explicitly listed. A direction with no reviewed resource types therefore
 * shows a table with just that default row.
 *
 * @param {string} key Direction key.
 * @param {Object} table resourceType -> entry map for this direction.
 * @returns {string} Markdown section.
 */
function renderSection(key, table) {
  const label = directionLabel(key);
  const lines = [`## ${label}`, ''];

  lines.push('| Resource | FML coverage | Postprocessor coverage | Overall coverage | Description |');
  lines.push('| --- | --- | --- | --- | --- |');

  for (const rt of Object.keys(table).sort()) {
    const entry = table[rt];
    const pp = postprocessorCoverage(entry);
    lines.push(
      `| ${mdCell(rt)} | ${entry.fml.coverage} | ${pp || '-'} `
      + `| ${overallCoverage(entry)} | ${describeCell(entry)} |`,
    );
  }

  // Trailing default row: everything not explicitly listed above.
  lines.push(
    `| _All other resource types_ | ${COVERAGE.NOT_REVIEWED} | - | ${COVERAGE.NOT_REVIEWED} `
    + '| _Default: FML mapping not yet reviewed; no postprocessors._ |',
  );
  lines.push('');
  return lines.join('\n');
}

/**
 * Build the entire COVERAGE.md document.
 *
 * @returns {string} The Markdown document.
 */
function buildDocument() {
  const consolidated = getConsolidatedRegistry();
  const directions = registeredDirections();
  const out = [];

  out.push('# Conversion Coverage', '');
  out.push(
    'This document reports the package\'s conversion coverage for each FHIR resource type across '
    + 'the supported adjacent FHIR version pairs.',
    '',
  );
  out.push('A conversion runs in up to two steps:', '');
  out.push(
    '- **FML mapping** - the FHIR Mapping Language (FML) mapping file is executed, handling most '
    + '(sometimes all) data elements.',
  );
  out.push(
    '- **Postprocessing** - where the FML mapping falls short, one or more postprocessors may be '
    + 'used to refine the result and complete the conversion. At this point, the package only '
    + 'supplies postprocessors in very limited cases.',
  );
  out.push('');
  out.push(
    'For each resource type, the tables report the coverage of the FML step, of the postprocessors '
    + '(when any apply), and of the two combined as the overall coverage.',
    '',
  );
  out.push(
    '> _Generated file - do not edit by hand. Maintainers regenerate it with '
    + '`npm run build:coverage` (see `tools/build-coverage.js` in the source '
    + 'repository)._',
    '',
  );

  out.push('## Coverage levels', '');
  out.push(
    `This report uses **${COVERAGE.NOT_REVIEWED}**, **${COVERAGE.KNOWN_GAPS}**, `
    + `**${COVERAGE.BEST_EFFORT}**, and **${COVERAGE.COMPLETE}**. See `
    + '[Coverage levels](README.md#coverage-levels) '
    + 'in `README.md` for definitions.',
  );
  out.push('');

  out.push('## Contents', '');
  for (const key of directions) {
    const label = directionLabel(key);
    out.push(`- [${label}](#${anchor(label)})`);
  }
  out.push('');

  for (const key of directions) {
    out.push(renderSection(key, consolidated[key] || {}));
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/**
 * CLI entry point: write COVERAGE.md (default) or print to stdout.
 *
 * @returns {void}
 */
function main() {
  const args = process.argv.slice(2);
  const doc = buildDocument();

  if (args.includes('--stdout')) {
    process.stdout.write(doc);
    return;
  }

  const outArg = args.find(a => !a.startsWith('--'));
  const outPath = outArg ? path.resolve(outArg) : path.join(REPO_ROOT, 'COVERAGE.md');
  fs.writeFileSync(outPath, doc, 'utf-8');
  process.stderr.write(`Wrote ${path.relative(REPO_ROOT, outPath) || outPath}\n`);
}

main();

