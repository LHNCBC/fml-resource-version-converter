/**
 * @fileoverview Binary postprocessor for the R4 -> R3 direction.
 *
 * R4 makes `Binary.data` optional, while STU3 requires the corresponding
 * `Binary.content` primitive. When a valid R4 source omits both the value and
 * an extension-bearing companion, the bundled FML emits an invalid STU3
 * Binary. The postprocessor marks the required target primitive absent with
 * the standard data-absent-reason extension rather than inventing payload data.
 *
 * @module postprocessors/R3_R4/Binary
 */
import { COVERAGE } from '../../converter/coverage.js';
import {
  statusFromMessages,
  warningMessage,
} from '../../converter/diagnostics.js';
import {
  addDataAbsentReasonExtension,
  hasPrimitiveValueOrExtension,
} from '../util/elements.js';

/**
 * R4 -> R3 Binary postprocessor descriptor.
 */
export const conv_R4_to_R3 = {
  name: 'Binary_R4_to_R3',
  coverage: COVERAGE.BEST_EFFORT,
  description:
    'Marks required Binary.content absent with the standard data-absent-reason extension '
    + 'when the optional R4 data element is absent, rather than inventing payload data. '
    + 'R4 Reference.type on securityContext has no STU3 equivalent and is not retained. '
    + 'Does not handle inter-version extensions.',

  /**
   * @param {Object} target FML-converted STU3 Binary, mutated in place.
   * @param {Object} ctx Hop context with sourceResource, fromVer, and toVer.
   * @returns {{resource: Object, status: string, messages: Array<Object>}} Result.
   */
  execute(target, ctx) {
    const messages = [];

    if (!hasPrimitiveValueOrExtension(target, 'content')) {
      addDataAbsentReasonExtension(target, 'content');
      messages.push(warningMessage(
        'Binary.data is optional in R4 but Binary.content is required in STU3. The source '
        + 'had no payload, so content was marked absent with the data-absent-reason '
        + 'extension ("unknown") rather than inventing binary data',
      ));
    }

    return { resource: target, status: statusFromMessages(messages), messages };
  },
};
