/**
 * Tests for processor descriptor helpers.
 */
import { strict as assert } from 'node:assert';
import {
  COVERAGE,
} from '../../../src/converter/coverage.js';
import {
  makeProcessor,
  validateProcessorDescriptor,
} from '../../../src/converter/processorDescriptor.js';


describe('converter/processorDescriptor', function () {
  function execute(resource) {
    return { resource, status: 'ok' };
  }

  it('accepts a valid postprocessor descriptor', function () {
    const descriptor = {
      name: 'completeProcessor',
      coverage: COVERAGE.COMPLETE,
      description: 'Completes a conversion gap.',
      execute,
    };

    assert.equal(validateProcessorDescriptor(descriptor), descriptor);
  });

  it('makeProcessor rejects non-function input', function () {
    assert.throws(() => makeProcessor({ name: 'x', execute }), /execute must be a function/);
    assert.throws(() => makeProcessor(null), /execute must be a function/);
  });

  it('wraps a bare postprocessor function with neutral coverage', function () {
    function patchThing(resource) {
      return { resource, status: 'ok' };
    }

    const descriptor = makeProcessor(patchThing);
    assert.equal(descriptor.name, 'patchThing');
    assert.equal(descriptor.coverage, COVERAGE.NEUTRAL);
    assert.equal(descriptor.description, 'Caller-provided processor.');
    assert.equal(descriptor.execute, patchThing);
  });

  it('lets callers override bare postprocessor metadata', function () {
    const fn = resource => ({ resource, status: 'ok' });
    const descriptor = makeProcessor(fn, {
      name: 'tagger',
      coverage: COVERAGE.COMPLETE,
      description: 'Adds a tag.',
    });

    assert.equal(descriptor.name, 'tagger');
    assert.equal(descriptor.coverage, COVERAGE.COMPLETE);
    assert.equal(descriptor.description, 'Adds a tag.');
  });

  it('makeProcessor requires a name (rejects anonymous with no opts.name)', function () {
    // Pass inline so no variable-name inference happens (execute.name is '').
    assert.throws(
      () => makeProcessor(function () { return { status: 'ok' }; }),
      /name is required/,
    );
  });

  it('rejects invalid postprocessor descriptors', function () {
    assert.throws(() => validateProcessorDescriptor(null), /must be an object/);
    assert.throws(() => validateProcessorDescriptor({ coverage: COVERAGE.NEUTRAL, description: 'x', execute }), /name/);
    assert.throws(() => validateProcessorDescriptor({ name: 'x', coverage: 'bad', description: 'x', execute }), /Invalid processor.coverage/);
    assert.throws(() => validateProcessorDescriptor({ name: 'x', coverage: COVERAGE.NEUTRAL, description: 'x' }), /execute/);
  });

  it('accepts a valid preprocessor descriptor without coverage', function () {
    const descriptor = {
      name: 'pre',
      execute,
    };

    assert.equal(validateProcessorDescriptor(descriptor, { allowCoverage: false, label: 'preprocessor' }), descriptor);
  });

  it('treats null coverage as absent', function () {
    // validateProcessorDescriptor: null coverage is treated as absent.
    assert.doesNotThrow(() => validateProcessorDescriptor({
      name: 'nullyCoverage',
      coverage: null,
      execute,
    }));

    // Same for preprocessor validation.
    assert.doesNotThrow(() => validateProcessorDescriptor({
      name: 'preNull',
      coverage: null,
      execute,
    }, { allowCoverage: false, label: 'preprocessor' }));
  });

  it('ignores unknown/extra fields on descriptors (duck-typed)', function () {
    const descriptor = validateProcessorDescriptor({
      name: 'extra',
      execute,
      description: 123,      // non-string description: not enforced
      random: { foo: 'bar' },
    });
    assert.equal(descriptor.description, 123);
    assert.deepEqual(descriptor.random, { foo: 'bar' });
  });
});


