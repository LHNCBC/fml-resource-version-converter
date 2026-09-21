/**
 * @fileoverview ValueSet postprocessor for the R4B <-> R5 version pair.
 *
 * R4B and R4 declare the same ValueSet element set, and
 * `ValueSet.compose.include.filter.op` binds to the same nine FilterOperator
 * codes (R5 adds `child-of` and `descendent-leaf`). The reviewed R5 -> R4B
 * conversion therefore has the same gaps as R5 -> R4 and reuses that
 * direction's postprocessor unchanged - only the descriptor
 * name/description differ so the conversion report is accurate. See
 * postprocessors/R4_R5/ValueSet.js for the logic and the FML issues it handles.
 *
 * The R4B -> R5 direction needs no postprocessor (the FML covers it, the same as
 * R4 -> R5): R5 is a superset of R4B for ValueSet, so nothing is dropped and no
 * value has to be invented. Inter-version-extension (IVE) handling is deferred
 * (see the design documents, "Inter-version extensions").
 *
 * Note that R4B converts only with R5 - there is no R4 <-> R4B conversion, as
 * the two are near-equivalent - so this pair covers the R5 -> R4B hop only.
 *
 * @module postprocessors/R4B_R5/ValueSet
 */
import { conv_R5_to_R4 } from '../R4_R5/ValueSet.js';

/**
 * R5 -> R4B ValueSet postprocessor descriptor.
 *
 * Reuses the R5 -> R4 transform verbatim because the relevant ValueSet element
 * set and filter operator codes match; only the name/description differ.
 */
export const conv_R5_to_R4B = {
  ...conv_R5_to_R4,
  name: 'ValueSet_R5_to_R4B',
  description:
    'Reports R5-only ValueSet content dropped during R5->R4B conversion and '
    + 'approximates R5-only filter operators as descendent-of with warnings. '
    + 'Reuses the R5->R4 transform. Does not handle inter-version extensions.',
};
