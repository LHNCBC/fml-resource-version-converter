/**
 * Runtime-data-bound converter factory tests.
 */

import { strict as assert } from 'node:assert';
import { converterFactory } from '../../../src/converter/converterFactory.js';
import r2ToR3 from '../../../src/runtime/data_modules/r2-to-r3.js';
import r3ToR2 from '../../../src/runtime/data_modules/r3-to-r2.js';
import r3ToR4 from '../../../src/runtime/data_modules/r3-to-r4.js';
import r4ToR3 from '../../../src/runtime/data_modules/r4-to-r3.js';
import r4ToR5 from '../../../src/runtime/data_modules/r4-to-r5.js';
import r4bToR5 from '../../../src/runtime/data_modules/r4b-to-r5.js';
import r5ToR4 from '../../../src/runtime/data_modules/r5-to-r4.js';
import r5ToR4b from '../../../src/runtime/data_modules/r5-to-r4b.js';

const DIRECTIONS = [
  ['R2', 'R3', r2ToR3],
  ['R3', 'R2', r3ToR2],
  ['R3', 'R4', r3ToR4],
  ['R4', 'R3', r4ToR3],
  ['R4', 'R5', r4ToR5],
  ['R5', 'R4', r5ToR4],
  ['R4B', 'R5', r4bToR5],
  ['R5', 'R4B', r5ToR4b],
];

/**
 * Create a compact Questionnaire accepted by the bundled mappings.
 *
 * @param {string} type Questionnaire item type for the source version.
 * @returns {Object} Questionnaire fixture.
 */
function questionnaire(type) {
  return {
    resourceType: 'Questionnaire',
    id: 'runtime-data-test',
    status: 'active',
    item: [{ linkId: 'choice', type }],
  };
}

describe('converter/converterFactory', function () {
  this.timeout(15000);

  for (const [fromVer, toVer, runtimeData] of DIRECTIONS) {
    it(`executes the predefined ${fromVer}->${toVer} runtime module`, function () {
      const { singleHopConverter } = converterFactory.create(runtimeData);

      const result = singleHopConverter.convert(
        { resourceType: 'Questionnaire', status: 'active' },
        fromVer,
        toVer,
      );

      assert.equal(result.resource.resourceType, 'Questionnaire');
    });
  }

  it('binds single-hop conversion and registry lookup to one direction', function () {
    const { singleHopConverter, getRegistryEntry } = converterFactory.create(r4ToR5);

    const result = singleHopConverter.convert(questionnaire('choice'), 'R4', 'R5');

    assert.equal(result.resource.resourceType, 'Questionnaire');
    assert.equal(result.resource.item[0].type, 'coding');
    assert.equal(result.resource.item[0].answerConstraint, 'optionsOnly');
    assert.ok(getRegistryEntry('Questionnaire', 'R4', 'R5'));
    assert.equal(getRegistryEntry('Questionnaire', 'R3', 'R4'), null);
  });

  it('composes an arbitrary two-direction selection', function () {
    const { chainedConverter } = converterFactory.create([r2ToR3, r3ToR4]);

    const result = chainedConverter.convert(questionnaire('choice'), 'R2', 'R4');

    assert.equal(result.resource.resourceType, 'Questionnaire');
    assert.equal(result.hops.length, 2);
    assert.deepEqual(
      result.hops.map(hop => `${hop.fromVer}->${hop.toVer}`),
      ['R2->R3', 'R3->R4'],
    );
  });

  it('rejects a chained route before execution when one direction is absent', function () {
    const { chainedConverter } = converterFactory.create(r2ToR3);

    assert.throws(
      () => chainedConverter.convert(questionnaire('choice'), 'R2', 'R4'),
      /runtime data does not include R3->R4/,
    );
  });

  it('rejects an empty runtime-data selection', function () {
    assert.throws(
      () => converterFactory.create([]),
      /Runtime data selection.*must not be empty/,
    );
  });
});
