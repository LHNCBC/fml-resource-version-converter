/**
 * Static dependency-graph checks for browser-facing runtime entry points.
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..');
const RAW_LOADERS = new Set([
  path.join(PROJECT_ROOT, 'tools/conceptmaps.js'),
  path.join(PROJECT_ROOT, 'tools/fml-mapping-catalog.js'),
]);
const SELECTIVE_RUNTIMES = [
  {
    name: 'r2-to-r3',
    artifacts: ['fhir-tables/DSTU2.js', 'fhir-tables/STU3.js', 'fml-mappings/R2toR3.js'],
    model: 'fhirpath/fhir-context/dstu2/index.js',
  },
  {
    name: 'r3-to-r2',
    artifacts: ['fhir-tables/DSTU2.js', 'fhir-tables/STU3.js', 'fml-mappings/R3toR2.js'],
    model: 'fhirpath/fhir-context/stu3/index.js',
  },
  {
    name: 'r3-to-r4',
    artifacts: ['fhir-tables/R4.js', 'fhir-tables/STU3.js', 'fml-mappings/R3toR4.js'],
    model: 'fhirpath/fhir-context/stu3/index.js',
  },
  {
    name: 'r4-to-r3',
    artifacts: ['fhir-tables/R4.js', 'fhir-tables/STU3.js', 'fml-mappings/R4toR3.js'],
    model: 'fhirpath/fhir-context/r4/index.js',
  },
  {
    name: 'r4-to-r5',
    artifacts: ['fhir-tables/R4.js', 'fhir-tables/R5.js', 'fml-mappings/R4toR5.js'],
    model: 'fhirpath/fhir-context/r4/index.js',
  },
  {
    name: 'r4b-to-r5',
    artifacts: ['fhir-tables/R4B.js', 'fhir-tables/R5.js', 'fml-mappings/R4BtoR5.js'],
    model: 'fhirpath/fhir-context/r4/index.js',
  },
  {
    name: 'r5-to-r4',
    artifacts: ['fhir-tables/R4.js', 'fhir-tables/R5.js', 'fml-mappings/R5toR4.js'],
    model: 'fhirpath/fhir-context/r5/index.js',
  },
  {
    name: 'r5-to-r4b',
    artifacts: ['fhir-tables/R4B.js', 'fhir-tables/R5.js', 'fml-mappings/R5toR4B.js'],
    model: 'fhirpath/fhir-context/r5/index.js',
  },
];

/**
 * Collect static import/export specifiers from one ECMAScript module.
 *
 * @param {string} source Module source text.
 * @returns {string[]} Module specifiers in declaration order.
 */
function staticSpecifiers(source) {
  const pattern = /(?:^|\n)\s*(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  const specifiers = [];
  let match;

  while ((match = pattern.exec(source)) !== null) specifiers.push(match[1]);

  return specifiers;
}

/**
 * Traverse project-relative static imports from one or more entry modules.
 *
 * Bare package imports are recorded but not traversed into node_modules.
 *
 * @param {string[]} entries Project-relative entry filenames.
 * @returns {{files: Set<string>, bareSpecifiers: Set<string>, nodeSpecifiers: Set<string>}}
 *   Collected dependency graph.
 */
function collectGraph(entries) {
  const files = new Set();
  const bareSpecifiers = new Set();
  const nodeSpecifiers = new Set();
  const pending = entries.map(entry => path.join(PROJECT_ROOT, entry));

  while (pending.length > 0) {
    const file = pending.pop();
    if (files.has(file)) continue;
    files.add(file);

    const source = fs.readFileSync(file, 'utf-8');
    for (const specifier of staticSpecifiers(source)) {
      if (specifier.startsWith('node:')) {
        nodeSpecifiers.add(specifier);
      } else if (specifier.startsWith('.')) {
        pending.push(path.resolve(path.dirname(file), specifier));
      } else {
        bareSpecifiers.add(specifier);
      }
    }
  }

  return { files, bareSpecifiers, nodeSpecifiers };
}

/**
 * Assert that a runtime graph excludes Node built-ins and raw data loaders.
 *
 * @param {string} label Graph label for diagnostics.
 * @param {ReturnType<typeof collectGraph>} graph Collected graph.
 * @returns {void}
 */
function assertPortableGraph(label, graph) {
  assert.deepEqual(
    [...graph.nodeSpecifiers],
    [],
    `${label} imports Node built-ins`,
  );

  const rawLoaders = [...graph.files].filter(file => RAW_LOADERS.has(file));
  assert.deepEqual(rawLoaders, [], `${label} reaches raw snapshot loaders`);
}

describe('runtime dependency graphs', function () {
  it('keeps the default package entry portable', function () {
    const graph = collectGraph(['src/index.js']);

    assertPortableGraph('default package entry', graph);
    assert.ok(graph.files.has(path.join(PROJECT_ROOT, 'src/runtime/data_modules/all.js')));
  });

  it('keeps the all-data low-level engine entry portable', function () {
    const graph = collectGraph(['src/fml-engine.js']);

    assertPortableGraph('low-level engine entry', graph);
    assert.ok(graph.files.has(path.join(PROJECT_ROOT, 'src/runtime/data_modules/all.js')));
  });

  for (const runtime of SELECTIVE_RUNTIMES) {
    it(`keeps selective ${runtime.name} free of unrelated runtime data`, function () {
      const graph = collectGraph([
        'src/converter/converterFactory.js',
        `src/runtime/data_modules/${runtime.name}.js`,
      ]);

      assertPortableGraph(`selective ${runtime.name} entry`, graph);
      assert.equal(
        graph.files.has(path.join(PROJECT_ROOT, 'src/runtime/data_modules/all.js')),
        false,
      );

      const generatedArtifacts = [...graph.files]
        .filter(file => file.startsWith(path.join(PROJECT_ROOT, 'data/runtime/')))
        .map(file => path.relative(path.join(PROJECT_ROOT, 'data/runtime'), file))
        .sort();
      assert.deepEqual(generatedArtifacts, runtime.artifacts);
      assert.deepEqual(
        [...graph.bareSpecifiers]
          .filter(specifier => specifier.startsWith('fhirpath/fhir-context/')),
        [runtime.model],
      );
    });
  }
});
