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
  hasAnyContent,
  hasPrimitiveValueOrExtension,
} from '../util/elements.js';
import { repairR4ToR3MetaAndExtensions } from './metaExtensions.js';

/**
 * R4 -> R3 Binary postprocessor descriptor.
 */
export const conv_R4_to_R3 = {
  name: 'Binary_R4_to_R3',
  coverage: COVERAGE.BEST_EFFORT,
  description:
    'Marks required Binary.content absent with the standard data-absent-reason extension '
    + 'when the optional R4 data element is absent, rather than inventing payload data. '
    + 'Reports R4 Meta.source and Reference.type on securityContext because STU3 cannot '
    + 'retain them, and removes ordinary Extensions left invalid by unrepresentable content. '
    + 'Does not handle inter-version extensions.',

  /**
   * @param {Object} target FML-converted STU3 Binary, mutated in place.
   * @param {Object} ctx Hop context with sourceResource, fromVer, and toVer.
   * @returns {{resource: Object, status: string, messages: Array<Object>}} Result.
   */
  execute(target, ctx) {
    const messages = [];
    const sourceSecurityContext = ctx.sourceResource?.securityContext;

    if (hasAnyContent(sourceSecurityContext, ['type', '_type'])) {
      messages.push(warningMessage(
        'Binary.securityContext.type and any primitive metadata were dropped because '
        + 'Reference.type has no STU3 equivalent',
      ));
    }

    if (!hasPrimitiveValueOrExtension(target, 'content')) {
      addDataAbsentReasonExtension(target, 'content');
      messages.push(warningMessage(
        'Binary.data is optional in R4 but Binary.content is required in STU3. The source '
        + 'had no payload, so content was marked absent with the data-absent-reason '
        + 'extension ("unknown") rather than inventing binary data',
      ));
    }

    repairR4ToR3MetaAndExtensions(target, ctx?.sourceResource, messages);

    return { resource: target, status: statusFromMessages(messages), messages };
  },
};
