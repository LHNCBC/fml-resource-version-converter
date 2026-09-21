/**
 * @fileoverview Library postprocessors for the R4 <-> R5 version pair.
 *
 * The bundled FML preserves every shared Library element. It cannot represent
 * R4 RelatedArtifact.url in R5, or the R5-only Library and embedded-datatype
 * additions in R4. The FML also leaves version-specific required-binding codes
 * unchanged in ParameterDefinition.type, DataRequirement.type, and
 * RelatedArtifact.type. These processors apply exact resource renames, remove
 * entries that cannot conform to the target binding, and report unavoidable
 * losses without inventing replacements. R4 Library names and canonical URLs
 * also have two shapes that satisfy R4 but trip R5 warning-severity
 * canonical-resource invariants; those are reported without rewriting resource
 * identity.
 *
 * R4B reuses both transforms unchanged; see postprocessors/R4B_R5/Library.js.
 * Neither direction implements inter-version extensions.
 *
 * @module postprocessors/R4_R5/Library
 */
import { COVERAGE } from '../../converter/coverage.js';
import {
  statusFromMessages,
  warningMessage,
} from '../../converter/diagnostics.js';
import {
  describeLibraryTypeActions,
  normalizeLibraryRequiredTypes,
} from '../util/Library.js';
import { hasAnyContent } from '../util/elements.js';

// R5 tightened the inherited canonical-resource name recommendation: unlike
// R4/R4B, it anchors the expression and requires at least two characters.
const R5_CNL_0_NAME = /^[A-Z][A-Za-z0-9_]{1,254}$/;
const R5_CNL_1_URL = /^[^|# ]+$/;

// ParameterDefinition.type and DataRequirement.type have required bindings to
// FHIR type names. The generic `types-*` ConceptMaps do not cover resource
// renames and sometimes map a removed datatype to itself, so their output does
// not establish target validity. Keep this reviewed policy static: apply exact
// resource renames and reviewed datatype approximations, and remove an entry
// whose required type has no target equivalent. R4 and R4B differ, so selection
// uses the actual hop key.
const REQUIRED_TYPE_POLICIES = {
  'R4->R5': {
    renames: new Map([
      ['DeviceUseStatement', 'DeviceUsage'],
      ['MedicinalProduct', 'MedicinalProductDefinition'],
      ['RequestGroup', 'RequestOrchestration'],
      ['SubstanceSpecification', 'SubstanceDefinition'],
    ]),
    unsupported: new Set([
      'Any',
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
      'MoneyQuantity',
      'Population',
      'ProdCharacteristic',
      'ResearchDefinition',
      'ResearchElementDefinition',
      'RiskEvidenceSynthesis',
      'SimpleQuantity',
      'SubstanceAmount',
      'Type',
    ]),
  },
  'R4B->R5': {
    renames: new Map([
      ['DeviceUseStatement', 'DeviceUsage'],
      ['RequestGroup', 'RequestOrchestration'],
    ]),
    unsupported: new Set([
      'Any',
      'CatalogEntry',
      'DocumentManifest',
      'Media',
      'MoneyQuantity',
      'Population',
      'ProdCharacteristic',
      'ResearchDefinition',
      'ResearchElementDefinition',
      'SimpleQuantity',
      'Type',
    ]),
  },
  'R5->R4': {
    renames: new Map([
      ['DeviceUsage', 'DeviceUseStatement'],
      ['MedicinalProductDefinition', 'MedicinalProduct'],
      ['RequestOrchestration', 'RequestGroup'],
      ['SubstanceDefinition', 'SubstanceSpecification'],
    ]),
    approximations: new Map([
      ['integer64', {
        targetType: 'integer',
        detail: 'integer has a smaller range than integer64',
      }],
    ]),
    unsupported: new Set([
      'ActorDefinition',
      'AdministrableProductDefinition',
      'ArtifactAssessment',
      'Availability',
      'BackboneType',
      'Base',
      'BiologicallyDerivedProductDispense',
      'CanonicalResource',
      'Citation',
      'ClinicalUseDefinition',
      'CodeableReference',
      'ConditionDefinition',
      'DataType',
      'DeviceAssociation',
      'DeviceDispense',
      'EncounterHistory',
      'EvidenceReport',
      'ExtendedContactDetail',
      'FormularyItem',
      'GenomicStudy',
      'ImagingSelection',
      'Ingredient',
      'InventoryItem',
      'InventoryReport',
      'ManufacturedItemDefinition',
      'MetadataResource',
      'MonetaryComponent',
      'NutritionIntake',
      'NutritionProduct',
      'PackagedProductDefinition',
      'Permission',
      'PrimitiveType',
      'RatioRange',
      'RegulatedAuthorization',
      'Requirements',
      'SubscriptionStatus',
      'SubscriptionTopic',
      'TestPlan',
      'Transport',
      'VirtualServiceDetail',
    ]),
  },
  'R5->R4B': {
    renames: new Map([
      ['DeviceUsage', 'DeviceUseStatement'],
      ['RequestOrchestration', 'RequestGroup'],
    ]),
    approximations: new Map([
      ['integer64', {
        targetType: 'integer',
        detail: 'integer has a smaller range than integer64',
      }],
    ]),
    unsupported: new Set([
      'ActorDefinition',
      'ArtifactAssessment',
      'Availability',
      'BackboneType',
      'Base',
      'BiologicallyDerivedProductDispense',
      'CanonicalResource',
      'ConditionDefinition',
      'DataType',
      'DeviceAssociation',
      'DeviceDispense',
      'EncounterHistory',
      'ExtendedContactDetail',
      'FormularyItem',
      'GenomicStudy',
      'ImagingSelection',
      'InventoryItem',
      'InventoryReport',
      'MetadataResource',
      'MonetaryComponent',
      'NutritionIntake',
      'Permission',
      'PrimitiveType',
      'Requirements',
      'SubstanceNucleicAcid',
      'SubstancePolymer',
      'SubstanceProtein',
      'SubstanceReferenceInformation',
      'SubstanceSourceMaterial',
      'TestPlan',
      'Transport',
      'VirtualServiceDetail',
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
 * Normalize required ParameterDefinition/DataRequirement type codes.
 *
 * The hop is taken from the runtime context, so an unreviewed version pair
 * cannot be ruled out here. Every hop these descriptors are registered on has a
 * reviewed policy, so a missing one means the processor was attached to a hop it
 * was not written for - only possible through a caller-supplied preproc/postproc
 * entry. Continuing would leave required type codes exactly as the FML produced
 * them and silently emit a resource that may violate the target binding, so this
 * fails like the framework's other processor-wiring errors instead.
 *
 * The check is unconditional: whether this particular resource happens to carry
 * a typed entry is irrelevant to the pipeline being misconfigured, and failing
 * only for some payloads would hide the mistake behind the test data.
 *
 * @param {Object} target FML-converted Library, mutated in place.
 * @param {Object} source Source Library (read-only).
 * @param {string} sourceVersion Source FHIR version.
 * @param {string} targetVersion Target FHIR version.
 * @param {Array<Object>} messages Diagnostic messages to append.
 * @throws {Error} If no reviewed type policy covers this hop.
 */
function normalizeRequiredTypes(
  target,
  source,
  sourceVersion,
  targetVersion,
  messages,
) {
  const hop = `${sourceVersion}->${targetVersion}`;
  const policy = REQUIRED_TYPE_POLICIES[hop];
  if (!policy) {
    throw new Error(
      `Library postprocessor: no reviewed FHIR type policy for the ${hop} hop. This `
      + 'processor normalizes the required ParameterDefinition.type and DataRequirement.type '
      + `codes and supports only ${Object.keys(REQUIRED_TYPE_POLICIES).join(', ')}. Check the `
      + 'hop this postprocessor was attached to.',
    );
  }

  const actions = normalizeLibraryRequiredTypes(target, source, policy);
  messages.push(...describeLibraryTypeActions(actions, sourceVersion, targetVersion));
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
 *   ParameterDefinition/DataRequirement type must be renamed or its entry removed.
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

  normalizeRequiredTypes(
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
 *   ParameterDefinition/DataRequirement type is normalized or an unrepresentable entry is removed.
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

  normalizeRequiredTypes(
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
    + 'ParameterDefinition and DataRequirement FHIR type changes and removes entries '
    + 'with unrepresentable types, and reports R4 names or URLs that do not satisfy R5 '
    + 'warning invariants cnl-0 and cnl-1. Does not handle inter-version extensions.',
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
    + 'RelatedArtifact content, normalizes ParameterDefinition and DataRequirement FHIR '
    + 'type changes and removes entries with unrepresentable types, and drops related '
    + 'artifacts whose required R5 relationship type has no R4 code. Does not handle '
    + 'inter-version extensions.',
  execute: convertR5ToR4,
};
