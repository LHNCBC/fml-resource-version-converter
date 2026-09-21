/**
 * @fileoverview CodeSystem postprocessors for the R4B <-> R5 version pair.
 *
 * R4B and R4 declare exactly the same 66 CodeSystem element paths, bind
 * `CodeSystem.filter.operator` to the same nine FilterOperator codes (R5 adds
 * `child-of` and `descendent-leaf`), and carry the same error-severity
 * invariants (csd-1 only; R5 adds csd-4 and csd-5). The R4B ConceptMap
 * `csd.fi.operator-5to4b` marks the same two codes `noMap` as its R4
 * counterpart. Both reviewed directions therefore have exactly the gaps found
 * for R4 and reuse those transforms unchanged - only the descriptor
 * name/description differ so the conversion report is accurate. See
 * postprocessors/R4_R5/CodeSystem.js for the logic and the FML issues it
 * handles.
 *
 * Note that R4B converts only with R5 - there is no R4 <-> R4B conversion, as
 * the two are near-equivalent - so this pair covers the R4B <-> R5 hops only.
 *
 * @module postprocessors/R4B_R5/CodeSystem
 */
import { conv_R4_to_R5, conv_R5_to_R4 } from '../R4_R5/CodeSystem.js';

/**
 * R5 -> R4B CodeSystem postprocessor descriptor.
 *
 * Reuses the R5 -> R4 transform verbatim because the relevant CodeSystem element
 * set and filter operator codes match; only the name/description differ.
 */
export const conv_R5_to_R4B = {
  ...conv_R5_to_R4,
  name: 'CodeSystem_R5_to_R4B',
  description:
    'Reports R5-only CodeSystem content dropped during R5->R4B conversion and removes '
    + 'R5-only filter operator codes with warnings, dropping a filter left without any '
    + 'operator. Reuses the R5->R4 transform. Does not handle inter-version extensions.',
};

/**
 * R4B -> R5 CodeSystem postprocessor descriptor.
 *
 * Reuses the R4 -> R5 transform verbatim: R4B permits `content = "supplement"`
 * without `supplements` exactly as R4 does, and R5 rejects it either way.
 */
export const conv_R4B_to_R5 = {
  ...conv_R4_to_R5,
  name: 'CodeSystem_R4B_to_R5',
  description:
    'Marks CodeSystem.supplements absent with the standard data-absent-reason extension '
    + 'when an R4B code system supplement omits it, which R5 invariant csd-4 requires. The '
    + 'supplemented canonical cannot be derived from the source, so it is reported as '
    + 'unknown rather than invented. Reuses the R4->R5 transform. Does not handle '
    + 'inter-version extensions.',
};
