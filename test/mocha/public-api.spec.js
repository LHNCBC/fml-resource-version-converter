/**
 * Public API surface tests.
 *
 * Guards the curated set of exports from the package barrel (src/index.js) so
 * a public symbol is never dropped by accident. Update this list deliberately
 * whenever the public API changes.
 */
import { strict as assert } from 'node:assert';
import * as api from '../../src/index.js';

describe('public API (src/index.js)', function () {
  const FUNCTIONS = [
    'getRegistryEntry',
    'makeProcessor',
    'validateProcessorDescriptor',
    'makeMessage',
    'infoMessage',
    'warningMessage',
    'statusFromMessages',
  ];

  // Converters are exported as objects exposing convert().
  const CONVERTERS = ['singleHopConverter', 'chainedConverter'];

  const ENUMS = ['POSTPROCESS_POLICY', 'COVERAGE', 'STATUS', 'MESSAGE_TYPE'];

  for (const name of FUNCTIONS) {
    it(`exports ${name} as a function`, function () {
      assert.equal(typeof api[name], 'function');
    });
  }

  for (const name of CONVERTERS) {
    it(`exports ${name} as an object with convert()`, function () {
      assert.equal(typeof api[name], 'object');
      assert.notEqual(api[name], null);
      assert.equal(typeof api[name].convert, 'function');
    });
  }

  for (const name of ENUMS) {
    it(`exports ${name} as a frozen enum object`, function () {
      assert.equal(typeof api[name], 'object');
      assert.notEqual(api[name], null);
      assert.equal(Object.isFrozen(api[name]), true);
    });
  }

  it('exposes exactly the curated set of names (no accidental leakage)', function () {
    const expected = [...FUNCTIONS, ...CONVERTERS, ...ENUMS].sort();
    const actual = Object.keys(api).sort();
    assert.deepEqual(actual, expected);
  });

  it('re-exports the same enum values as their source modules', function () {
    assert.equal(api.COVERAGE.COMPLETE, 'complete');
    assert.equal(api.COVERAGE.KNOWN_GAPS, 'known_gaps');
    assert.equal(api.COVERAGE.BEST_EFFORT, 'best_effort');
    assert.equal(api.STATUS.WARNING, 'warning');
    assert.equal(api.MESSAGE_TYPE.INFO, 'info');
    assert.equal(api.POSTPROCESS_POLICY.APPEND, 'append');
  });
});

describe('public API: getRegistryEntry', function () {
  it('returns a reviewed entry (fml coverage + processor descriptors)', function () {
    const entry = api.getRegistryEntry('Questionnaire', 'R5', 'R4');
    assert.ok(entry, 'entry should be present for a supported tuple');
    assert.equal(typeof entry.fml.coverage, 'string');
    assert.ok(Array.isArray(entry.processors));
    // Descriptors are usable building blocks: they carry execute().
    for (const p of entry.processors) {
      assert.equal(typeof p.name, 'string');
      assert.equal(typeof p.execute, 'function');
    }
  });

  it('returns null (does not throw) for an unsupported tuple', function () {
    assert.equal(api.getRegistryEntry('Questionnaire', 'R4', 'R4B'), null); // no direct mapping
    assert.equal(api.getRegistryEntry('NoSuchResource', 'R4', 'R5'), null); // unknown resource
  });

  it('returns a safe copy: mutating the result does not affect later reads', function () {
    const first = api.getRegistryEntry('Questionnaire', 'R5', 'R4');
    const originalLen = first.processors.length;
    first.processors.push({ name: 'x', execute() {} });
    first.fml.coverage = 'tampered';
    const second = api.getRegistryEntry('Questionnaire', 'R5', 'R4');
    assert.equal(second.processors.length, originalLen);
    assert.notEqual(second.fml.coverage, 'tampered');
  });

  it('returns a safe copy: mutating a returned descriptor does not affect later reads', function () {
    const first = api.getRegistryEntry('Questionnaire', 'R5', 'R4');
    assert.ok(first.processors.length > 0, 'tuple should have a package postprocessor');

    const originalName = first.processors[0].name;
    const originalCoverage = first.processors[0].coverage;
    const originalExecute = first.processors[0].execute;

    // Tamper with the nested descriptor object's own fields.
    first.processors[0].name = 'tampered-name';
    first.processors[0].coverage = 'tampered';
    first.processors[0].execute = () => { throw new Error('tampered'); };

    const second = api.getRegistryEntry('Questionnaire', 'R5', 'R4');
    assert.equal(second.processors[0].name, originalName);
    assert.equal(second.processors[0].coverage, originalCoverage);
    assert.equal(second.processors[0].execute, originalExecute);
  });

  it('tampering a returned descriptor does not affect a later conversion', function () {
    const r5Questionnaire = {
      resourceType: 'Questionnaire',
      status: 'active',
      item: [{ linkId: 'a', type: 'string' }],
    };

    const entry = api.getRegistryEntry('Questionnaire', 'R5', 'R4');
    entry.processors[0].execute = () => { throw new Error('tampered execute must not run'); };

    // The conversion pulls its own (pristine) descriptors from the shared table,
    // so the tampered copy above must not leak in.
    assert.doesNotThrow(() => api.singleHopConverter.convert(r5Questionnaire, 'R5', 'R4'));
  });
});

describe('public API: ./fml-engine subpath barrel', function () {
  let engine;

  before(async function () {
    engine = await import('../../src/fml-engine.js');
  });

  it('exposes exactly the engine surface', function () {
    assert.deepEqual(Object.keys(engine).sort(),
      ['createFmlEngineFactory', 'getAdjacentPairs', 'planHops'].sort());
  });

  it('createFmlEngineFactory yields a working factory', function () {
    const factory = engine.createFmlEngineFactory();
    assert.equal(typeof factory.hasMapping, 'function');
    assert.equal(typeof factory.resolveMapping, 'function');
    assert.equal(typeof factory.createEngine, 'function');
    assert.equal(factory.hasMapping('Questionnaire', 'R4', 'R5'), true);
    assert.equal(factory.hasMapping('Questionnaire', 'R4', 'R4B'), false);
  });
});
