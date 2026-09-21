/**
 * @fileoverview Binary postprocessor for the R3 -> R2 direction.
 *
 * STU3 adds the optional `Binary.securityContext` element. DSTU2 has no
 * equivalent, and the bundled FML drops it silently, so this postprocessor
 * reports the unavoidable loss without changing the converted resource.
 *
 * @module postprocessors/R2_R3/Binary
 */
import { COVERAGE } from '../../converter/coverage.js';
import {
  statusFromMessages,
  warningMessage,
} from '../../converter/diagnostics.js';
import { hasAnyContent } from '../util/elements.js';

/**
 * R3 -> R2 Binary postprocessor descriptor.
 */
export const conv_R3_to_R2 = {
  name: 'Binary_R3_to_R2',
  coverage: COVERAGE.BEST_EFFORT,
  description:
    'Reports Binary.securityContext dropped because DSTU2 has no equivalent. '
    + 'Does not handle inter-version extensions.',

  /**
   * @param {Object} target FML-converted DSTU2 Binary, mutated in place.
   * @param {Object} ctx Hop context with sourceResource, fromVer, and toVer.
   * @returns {{resource: Object, status: string, messages: Array<Object>}} Result.
   */
  execute(target, ctx) {
    const messages = [];

    if (hasAnyContent(ctx?.sourceResource, ['securityContext'])) {
      messages.push(warningMessage(
        'Binary.securityContext has no DSTU2 equivalent and was dropped; the converted '
        + 'resource no longer identifies the security context used to control access',
      ));
    }

    return { resource: target, status: statusFromMessages(messages), messages };
  },
};
