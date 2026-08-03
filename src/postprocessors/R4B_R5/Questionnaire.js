/**
 * @fileoverview Questionnaire postprocessor for the R4B <-> R5 version pair.
 *
 * R4B is identical to R4 for Questionnaire.item (no `answerConstraint`; same
 * type set), so the R5 -> R4B conversion has the exact same item.type narrowing
 * issue as R5 -> R4 and reuses that direction's postprocessor unchanged - only
 * the descriptor name/description differ so the conversion report is accurate.
 * See postprocessors/R4_R5/Questionnaire.js for the logic and the FML issues it
 * handles.
 *
 * The R4B -> R5 direction needs no postprocessor (the FML covers it, the same as
 * R4 -> R5). Inter-version-extension (IVE) handling is deferred (see the design
 * documents, "Inter-version extensions").
 *
 * @module postprocessors/R4B_R5/Questionnaire
 */
import { conv_R5_to_R4 } from '../R4_R5/Questionnaire.js';

/**
 * R5 -> R4B Questionnaire postprocessor descriptor.
 *
 * Reuses the R5 -> R4 transform verbatim (R4B == R4 for Questionnaire.item);
 * only the name/description differ.
 */
export const conv_R5_to_R4B = {
  ...conv_R5_to_R4,
  name: 'Questionnaire_R5_to_R4B',
  description:
    'Corrects Questionnaire item.type for R5->R4B (coding/answerConstraint -> '
    + 'choice/open-choice) from the R5 source, fixing the FML step\'s malformed '
    + 'and over-widened narrowing. Reuses the R5->R4 transform. Does not handle '
    + 'inter-version extensions.',
};



