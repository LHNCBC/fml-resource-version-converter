/**
 * @fileoverview Library postprocessors for the R4B <-> R5 version pair.
 *
 * R4B and R4 declare the same Library element set, equivalent relevant warning
 * constraints, and the same Attachment, DataRequirement, and RelatedArtifact
 * structures. Their FML maps have the same omissions, so this pair reuses the
 * R4 <-> R5 logic. Only descriptor names and descriptions differ so reports
 * identify the actual conversion hop.
 *
 * @module postprocessors/R4B_R5/Library
 */
import { conv_R4_to_R5, conv_R5_to_R4 } from '../R4_R5/Library.js';

/**
 * R4B -> R5 Library postprocessor descriptor.
 */
export const conv_R4B_to_R5 = {
  ...conv_R4_to_R5,
  name: 'Library_R4B_to_R5',
  description:
    'Reports RelatedArtifact.url content dropped because R5 has no equivalent and reports '
    + 'R4B names or URLs that do not satisfy R5 warning invariants cnl-0 and cnl-1, and '
    + 'normalizes or removes DataRequirement resource types that changed across the hop. '
    + 'Reuses the R4->R5 transform. Does not handle inter-version extensions.',
};

/**
 * R5 -> R4B Library postprocessor descriptor.
 */
export const conv_R5_to_R4B = {
  ...conv_R5_to_R4,
  name: 'Library_R5_to_R4B',
  description:
    'Reports R5-only Library content and nested Attachment, DataRequirement, and '
    + 'RelatedArtifact content, normalizes or removes version-specific DataRequirement '
    + 'resource types, and drops related artifacts whose R5-only relationship type is invalid '
    + 'in R4B. Reuses the R5->R4 transform. Does not handle inter-version extensions.',
};
