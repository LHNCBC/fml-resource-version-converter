/**
 * @fileoverview Library postprocessors for the R4 <-> R5 version pair.
 *
 * The bundled FML preserves every shared Library element. It cannot represent
 * R4 RelatedArtifact.url in R5, or the R5-only Library and embedded-datatype
 * additions in R4. The FML also leaves version-specific required-binding codes
 * unchanged in DataRequirement.type and RelatedArtifact.type. These processors
 * apply exact resource renames, remove entries that cannot conform to the target
 * binding, and report unavoidable losses without inventing replacements. R4
 * Library names and canonical URLs also have two shapes that satisfy R4 but
 * trip R5 warning-severity canonical-resource invariants; those are reported
 * without rewriting resource identity.
 *
 * R4B reuses both transforms unchanged; see postprocessors/R4B_R5/Library.js.
 * Neither direction implements inter-version extensions.
 *
 * @module postprocessors/R4_R5/Library
 */
import { COVERAGE } from '../../converter/coverage.js';
import {
  infoMessage,
  statusFromMessages,
  warningMessage,
} from '../../converter/diagnostics.js';
import { hasAnyContent } from '../util/elements.js';

// R5 tightened the inherited canonical-resource name recommendation: unlike
// R4/R4B, it anchors the expression and requires at least two characters.
const R5_CNL_0_NAME = /^[A-Z][A-Za-z0-9_]{1,254}$/;
const R5_CNL_1_URL = /^[^|# ]+$/;

// DataRequirement.type has a required binding to FHIR resource type names. The
// generic `types-*` ConceptMaps do not cover resource renames, so the FML leaves
// these codes unchanged. Keep this reviewed policy static: an exact rename is
// applied where the bundled resource maps establish one; a source-only type
// with no mapping makes the whole requirement unrepresentable because type is
// required. R4 and R4B differ, so selection uses the actual hop key.
const DATA_REQUIREMENT_TYPE_POLICIES = {
  'R4->R5': {
    renames: new Map([
      ['DeviceUseStatement', 'DeviceUsage'],
      ['MedicinalProduct', 'MedicinalProductDefinition'],
      ['RequestGroup', 'RequestOrchestration'],
      ['SubstanceSpecification', 'SubstanceDefinition'],
    ]),
    unsupported: new Set([
      'CatalogEntry',
      'DocumentManifest',
      'EffectEvidenceSynthesis',
      'Media',
      'MedicinalProductAuthorization',
      'MedicinalProductContraindication',
      'MedicinalProductIndication',
      'MedicinalProductIngredient',
      'MedicinalProductInteraction',
      'MedicinalProductManufactured',
      'MedicinalProductPackaged',
      'MedicinalProductPharmaceutical',
      'MedicinalProductUndesirableEffect',
      'ResearchDefinition',
      'ResearchElementDefinition',
      'RiskEvidenceSynthesis',
    ]),
  },
  'R4B->R5': {
    renames: new Map([
      ['DeviceUseStatement', 'DeviceUsage'],
      ['RequestGroup', 'RequestOrchestration'],
    ]),
    unsupported: new Set([
      'CatalogEntry',
      'DocumentManifest',
      'Media',
      'ResearchDefinition',
      'ResearchElementDefinition',
    ]),
  },
  'R5->R4': {
    renames: new Map([
      ['DeviceUsage', 'DeviceUseStatement'],
      ['MedicinalProductDefinition', 'MedicinalProduct'],
      ['RequestOrchestration', 'RequestGroup'],
      ['SubstanceDefinition', 'SubstanceSpecification'],
    ]),
    unsupported: new Set([
      'ActorDefinition',
      'AdministrableProductDefinition',
      'ArtifactAssessment',
      'BiologicallyDerivedProductDispense',
      'CanonicalResource',
      'Citation',
      'ClinicalUseDefinition',
      'ConditionDefinition',
      'DeviceAssociation',
      'DeviceDispense',
      'EncounterHistory',
      'EvidenceReport',
      'FormularyItem',
      'GenomicStudy',
      'ImagingSelection',
      'Ingredient',
      'InventoryItem',
      'InventoryReport',
      'ManufacturedItemDefinition',
      'MetadataResource',
      'NutritionIntake',
      'NutritionProduct',
      'PackagedProductDefinition',
      'Permission',
      'RegulatedAuthorization',
      'Requirements',
      'SubscriptionStatus',
      'SubscriptionTopic',
      'TestPlan',
      'Transport',
    ]),
  },
  'R5->R4B': {
    renames: new Map([
      ['DeviceUsage', 'DeviceUseStatement'],
      ['RequestOrchestration', 'RequestGroup'],
    ]),
    unsupported: new Set([
      'ActorDefinition',
      'ArtifactAssessment',
      'BiologicallyDerivedProductDispense',
      'CanonicalResource',
      'ConditionDefinition',
      'DeviceAssociation',
      'DeviceDispense',
      'EncounterHistory',
      'FormularyItem',
      'GenomicStudy',
      'ImagingSelection',
      'InventoryItem',
      'InventoryReport',
      'MetadataResource',
      'NutritionIntake',
      'Permission',
      'Requirements',
      'SubstanceNucleicAcid',
      'SubstancePolymer',
      'SubstanceProtein',
      'SubstanceReferenceInformation',
      'SubstanceSourceMaterial',
      'TestPlan',
      'Transport',
    ]),
  },
};

// R5 expanded the required RelatedArtifact.type binding from R4/R4B's eight
// codes to 36. None of the 28 additions has a faithful older-version code.
const R5_ONLY_RELATED_ARTIFACT_TYPES = new Set([
  'amended-with',
  'amends',
  'appended-with',
  'appends',
  'cite-as',
  'cited-by',
  'cites',
  'comment-in',
  'comments-on',
  'contained-in',
  'contains',
  'correction-in',
  'corrects',
  'created-with',
  'documents',
  'part-of',
  'replaced-with',
  'replaces',
  'retracted-by',
  'retracts',
  'signs',
  'similar-to',
  'specification-of',
  'supported-with',
  'supports',
  'transformed-into',
  'transformed-with',
  'transforms',
]);

const R5_ONLY_ROOT_FIELDS = [
  ['versionAlgorithm[x]', [
    'versionAlgorithmString',
    '_versionAlgorithmString',
    'versionAlgorithmCoding',
  ]],
  ['copyrightLabel', ['copyrightLabel', '_copyrightLabel']],
];

const R5_ONLY_ATTACHMENT_FIELDS = [
  ['duration', ['duration', '_duration']],
  ['frames', ['frames', '_frames']],
  ['height', ['height', '_height']],
  ['pages', ['pages', '_pages']],
  ['width', ['width', '_width']],
];

const R5_ONLY_RELATED_ARTIFACT_FIELDS = [
  ['classifier', ['classifier']],
  ['publicationDate', ['publicationDate', '_publicationDate']],
  ['publicationStatus', ['publicationStatus', '_publicationStatus']],
  ['resourceReference', ['resourceReference']],
];

/**
 * Add paths for R5-only Attachment content found in one attachment.
 *
 * @param {Object|undefined} attachment R5 Attachment to inspect.
 * @param {string} prefix Library path leading to the attachment.
 * @param {Set<string>} paths Paths receiving detected content.
 */
function inspectAttachment(attachment, prefix, paths) {
  for (const [field, fields] of R5_ONLY_ATTACHMENT_FIELDS) {
    if (hasAnyContent(attachment, fields)) paths.add(`${prefix}.${field}`);
  }
}

/**
 * Find R4-only Library content that the R5 structures cannot represent.
 *
 * RelatedArtifact.resource already exists independently in R4, so an artifact
 * URL cannot safely be redirected there. An entry may carry both fields, and a
 * URL need not identify a canonical resource.
 *
 * @param {Object} source R4 or R4B Library source.
 * @returns {string[]} Sorted paths.
 */
function findR4OnlyContent(source) {
  const paths = new Set();

  for (const artifact of source?.relatedArtifact || []) {
    if (hasAnyContent(artifact, ['url', '_url'])) {
      paths.add('Library.relatedArtifact.url');
    }
  }

  return [...paths].sort();
}

/**
 * Find R5-only Library content that R4 and R4B cannot represent.
 *
 * Attachment additions are checked both under Library.content and under the
 * Attachment carried by RelatedArtifact.document.
 *
 * @param {Object} source R5 Library source.
 * @returns {string[]} Sorted paths.
 */
function findR5OnlyContent(source) {
  const paths = new Set();

  for (const [field, fields] of R5_ONLY_ROOT_FIELDS) {
    if (hasAnyContent(source, fields)) paths.add(`Library.${field}`);
  }

  for (const attachment of source?.content || []) {
    inspectAttachment(attachment, 'Library.content', paths);
  }

  for (const requirement of source?.dataRequirement || []) {
    if (hasAnyContent(requirement, ['valueFilter'])) {
      paths.add('Library.dataRequirement.valueFilter');
    }
  }

  for (const artifact of source?.relatedArtifact || []) {
    for (const [field, fields] of R5_ONLY_RELATED_ARTIFACT_FIELDS) {
      if (hasAnyContent(artifact, fields)) {
        paths.add(`Library.relatedArtifact.${field}`);
      }
    }
    inspectAttachment(artifact?.document, 'Library.relatedArtifact.document', paths);
  }

  return [...paths].sort();
}

/**
 * Normalize DataRequirement.type values for one Library conversion hop.
 *
 * The Library FML emits one target dataRequirement for each source entry in the
 * same order. This function depends on that alignment to preserve each complete
 * converted entry while changing or filtering its required type code. Focused
 * tests lock the assumption for shared, renamed, and dropped entries.
 *
 * @param {Object} target FML-converted Library, mutated in place.
 * @param {Object} source Source Library (read-only).
 * @param {string} sourceVersion Source FHIR version.
 * @param {string} targetVersion Target FHIR version.
 * @param {Array<Object>} messages Diagnostic messages to append.
 */
function normalizeDataRequirementTypes(
  target,
  source,
  sourceVersion,
  targetVersion,
  messages,
) {
  const policy = DATA_REQUIREMENT_TYPE_POLICIES[`${sourceVersion}->${targetVersion}`];
  const sourceRequirements = source?.dataRequirement;
  const targetRequirements = target?.dataRequirement;
  if (!policy || !Array.isArray(sourceRequirements) || !Array.isArray(targetRequirements)) return;

  const kept = [];

  targetRequirements.forEach((requirement, index) => {
    const sourceType = sourceRequirements[index]?.type;
    const renamedType = policy.renames.get(sourceType);

    if (renamedType) {
      requirement.type = renamedType;
      kept.push(requirement);
      messages.push(infoMessage(
        `Library.dataRequirement[${index}].type was renamed from "${sourceType}" to `
        + `"${renamedType}" to follow the resource rename between ${sourceVersion} and `
        + targetVersion,
      ));
      return;
    }

    if (policy.unsupported.has(sourceType)) {
      messages.push(warningMessage(
        `Library.dataRequirement[${index}] was dropped because its required type `
        + `"${sourceType}" is a ${sourceVersion}-only resource type with no `
        + `${targetVersion} equivalent`,
      ));
      return;
    }

    kept.push(requirement);
  });

  if (kept.length === targetRequirements.length) return;
  if (kept.length === 0) delete target.dataRequirement;
  else target.dataRequirement = kept;
}

/**
 * Remove R5 related artifacts whose required relationship code R4/R4B lacks.
 *
 * The FML preserves codes explicitly marked noMap, producing an invalid target.
 * There is no neutral relationship code and substituting a directional near
 * match could reverse or weaken the assertion, so the complete entry is
 * dropped. Source and target arrays are aligned one-to-one by the FML.
 *
 * @param {Object} target FML-converted R4/R4B Library, mutated in place.
 * @param {Object} source R5 Library source (read-only).
 * @param {string} targetVersion Target FHIR version.
 * @param {Array<Object>} messages Diagnostic messages to append.
 */
function removeUnrepresentableRelatedArtifacts(target, source, targetVersion, messages) {
  const sourceArtifacts = source?.relatedArtifact;
  const targetArtifacts = target?.relatedArtifact;
  if (!Array.isArray(sourceArtifacts) || !Array.isArray(targetArtifacts)) return;

  const kept = [];

  targetArtifacts.forEach((artifact, index) => {
    const sourceType = sourceArtifacts[index]?.type;
    if (!R5_ONLY_RELATED_ARTIFACT_TYPES.has(sourceType)) {
      kept.push(artifact);
      return;
    }

    messages.push(warningMessage(
      `Library.relatedArtifact[${index}] was dropped because ${targetVersion} does not define `
      + `the R5 RelatedArtifact.type code "${sourceType}"; type is required and no faithful `
      + 'substitute exists',
    ));
  });

  if (kept.length === targetArtifacts.length) return;
  if (kept.length === 0) delete target.relatedArtifact;
  else target.relatedArtifact = kept;
}

/**
 * Normalize R4/R4B content for R5 and report losses and warning invariants.
 *
 * @param {Object} target FML-converted R5 Library, mutated in place when a
 *   DataRequirement type must be renamed or its entry removed.
 * @param {Object} ctx Hop context with sourceResource, fromVer, and toVer.
 * @returns {{resource: Object, status: string, messages: Array<Object>}} Result.
 */
function convertR4ToR5(target, ctx) {
  const messages = [];
  const source = ctx?.sourceResource || {};
  const sourceVersion = ctx?.fromVer || 'R4';
  const targetVersion = ctx?.toVer || 'R5';
  const paths = findR4OnlyContent(source);

  if (paths.length > 0) {
    messages.push(warningMessage(
      `${sourceVersion}-only Library content was dropped because ${targetVersion} has no `
      + `equivalent: ${paths.join(', ')}`,
    ));
  }

  if (typeof target?.name === 'string' && !R5_CNL_0_NAME.test(target.name)) {
    messages.push(warningMessage(
      `Library.name "${target.name}" does not satisfy ${targetVersion} warning invariant `
      + 'cnl-0 (name should start with an uppercase letter, contain only letters, digits, '
      + `or underscores, and contain 2-255 characters); ${sourceVersion} permits this name. `
      + 'It was left unchanged because it identifies the resource',
    ));
  }

  if (typeof target?.url === 'string' && !R5_CNL_1_URL.test(target.url)) {
    messages.push(warningMessage(
      `Library.url "${target.url}" does not satisfy ${targetVersion} warning invariant `
      + `cnl-1 (canonical URLs should not contain "|", "#", or spaces); ${sourceVersion} `
      + 'does not impose this rule. It was left unchanged because it identifies the resource',
    ));
  }

  normalizeDataRequirementTypes(
    target,
    source,
    sourceVersion,
    targetVersion,
    messages,
  );

  return { resource: target, status: statusFromMessages(messages), messages };
}

/**
 * Normalize R5 content for R4/R4B and report unavoidable losses.
 *
 * @param {Object} target FML-converted R4/R4B Library, mutated in place when a
 *   DataRequirement type is normalized or an unrepresentable entry is removed.
 * @param {Object} ctx Hop context with sourceResource, fromVer, and toVer.
 * @returns {{resource: Object, status: string, messages: Array<Object>}} Result.
 */
function convertR5ToR4(target, ctx) {
  const messages = [];
  const source = ctx?.sourceResource || {};
  const sourceVersion = ctx?.fromVer || 'R5';
  const targetVersion = ctx?.toVer || 'R4';
  const paths = findR5OnlyContent(source);

  if (paths.length > 0) {
    messages.push(warningMessage(
      `${sourceVersion}-only Library content was dropped because ${targetVersion} has no `
      + `equivalent: ${paths.join(', ')}`,
    ));
  }

  normalizeDataRequirementTypes(
    target,
    source,
    sourceVersion,
    targetVersion,
    messages,
  );
  removeUnrepresentableRelatedArtifacts(target, source, targetVersion, messages);

  return { resource: target, status: statusFromMessages(messages), messages };
}

/**
 * R4 -> R5 Library postprocessor descriptor.
 */
export const conv_R4_to_R5 = {
  name: 'Library_R4_to_R5',
  coverage: COVERAGE.BEST_EFFORT,
  description:
    'Reports RelatedArtifact.url content dropped because R5 has no equivalent, normalizes '
    + 'DataRequirement resource type renames and removes requirements with unrepresentable '
    + 'types, and reports R4 names or URLs that do not satisfy R5 warning invariants cnl-0 '
    + 'and cnl-1. Does not handle inter-version extensions.',
  execute: convertR4ToR5,
};

/**
 * R5 -> R4 Library postprocessor descriptor.
 */
export const conv_R5_to_R4 = {
  name: 'Library_R5_to_R4',
  coverage: COVERAGE.BEST_EFFORT,
  description:
    'Reports R5-only Library content and nested Attachment, DataRequirement, and '
    + 'RelatedArtifact content, normalizes DataRequirement resource type renames and removes '
    + 'requirements with unrepresentable types, and drops related artifacts whose required '
    + 'R5 relationship type has no R4 code. Does not handle inter-version extensions.',
  execute: convertR5ToR4,
};
