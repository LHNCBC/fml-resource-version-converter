/**
 * @fileoverview Library postprocessors for the R3 <-> R4 version pair.
 *
 * The bundled FML needs resource-level repair for the STU3 Contributor model,
 * Reference/canonical changes in embedded datatypes, required FHIR type codes,
 * and R4-only Library/DataRequirement content. These processors reconstruct
 * representable content from the read-only source and report unavoidable loss.
 *
 * Neither direction implements inter-version extensions.
 *
 * @module postprocessors/R3_R4/Library
 */
import { COVERAGE } from '../../converter/coverage.js';
import {
  infoMessage,
  statusFromMessages,
  warningMessage,
} from '../../converter/diagnostics.js';
import {
  describeLibraryTypeActions,
  normalizeLibraryRequiredTypes,
} from '../util/Library.js';
import {
  addDataAbsentReasonExtension,
  hasAnyContent,
  hasPrimitiveValueOrExtension,
  stripCanonicalVersion,
} from '../util/elements.js';
import { repairR4ToR3MetaAndExtensions } from './metaExtensions.js';
import { removeUnrepresentableUsageContexts } from './usageContext.js';

const R4_LIB_0_NAME = /^[A-Z][A-Za-z0-9_]{0,254}$/;
const RENDERED_VALUE_URL = 'http://hl7.org/fhir/StructureDefinition/rendered-value';
const CONTRIBUTOR_BUCKETS = ['author', 'editor', 'reviewer', 'endorser'];
const LIBRARY_TYPE_SYSTEMS = {
  R3: 'http://hl7.org/fhir/library-type',
  R4: 'http://terminology.hl7.org/CodeSystem/library-type',
};

const REQUIRED_TYPE_POLICIES = {
  'R3->R4': {
    renames: new Map([
      ['BodySite', 'BodyStructure'],
      ['EligibilityRequest', 'CoverageEligibilityRequest'],
      ['EligibilityResponse', 'CoverageEligibilityResponse'],
      ['ProcedureRequest', 'ServiceRequest'],
      ['ReferralRequest', 'ServiceRequest'],
      ['Sequence', 'MolecularSequence'],
    ]),
    unsupported: new Set([
      'DataElement',
      'DeviceComponent',
      'ExpansionProfile',
      'ImagingManifest',
      'ProcessRequest',
      'ProcessResponse',
      'ServiceDefinition',
    ]),
  },
  'R4->R3': {
    renames: new Map([
      ['BodyStructure', 'BodySite'],
      ['CoverageEligibilityRequest', 'EligibilityRequest'],
      ['CoverageEligibilityResponse', 'EligibilityResponse'],
      ['MolecularSequence', 'Sequence'],
    ]),
    approximations: new Map([
      ['canonical', {
        targetType: 'uri',
        detail: 'uri cannot retain canonical version-selection semantics',
      }],
      ['url', {
        targetType: 'uri',
        detail: 'uri does not retain the more specific url type constraint',
      }],
    ]),
    ambiguous: new Set(['ServiceRequest']),
    unsupported: new Set([
      'BiologicallyDerivedProduct',
      'CatalogEntry',
      'ChargeItemDefinition',
      'DeviceDefinition',
      'EffectEvidenceSynthesis',
      'EventDefinition',
      'Evidence',
      'EvidenceVariable',
      'ExampleScenario',
      'Expression',
      'ImmunizationEvaluation',
      'InsurancePlan',
      'Invoice',
      'MarketingStatus',
      'MedicationKnowledge',
      'MedicinalProduct',
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
      'ObservationDefinition',
      'OrganizationAffiliation',
      'Population',
      'ProdCharacteristic',
      'ProductShelfLife',
      'ResearchDefinition',
      'ResearchElementDefinition',
      'RiskEvidenceSynthesis',
      'SpecimenDefinition',
      'SubstanceAmount',
      'SubstanceNucleicAcid',
      'SubstancePolymer',
      'SubstanceProtein',
      'SubstanceReferenceInformation',
      'SubstanceSourceMaterial',
      'SubstanceSpecification',
      'TerminologyCapabilities',
      'VerificationResult',
    ]),
  },
};

/**
 * Append cloned extensions to a primitive companion.
 *
 * @param {Object} companion Primitive companion being built.
 * @param {Array<Object>|undefined} extensions Extensions to append.
 */
function appendExtensions(companion, extensions) {
  if (!Array.isArray(extensions) || extensions.length === 0) return;
  if (!Array.isArray(companion.extension)) companion.extension = [];
  companion.extension.push(...structuredClone(extensions));
}

/**
 * Update the canonical URL of the LibraryType code system.
 *
 * R3 and R4 define the same four codes under different system URLs. The FML
 * copies CodeableConcept content without migrating the URL, so update only the
 * exact source system and leave other codings untouched.
 *
 * @param {Object} target Converted Library, mutated in place.
 * @param {string} sourceVersion Source FHIR version.
 * @param {string} targetVersion Target FHIR version.
 * @param {Array<Object>} messages Diagnostic messages to append.
 */
function normalizeLibraryTypeSystem(target, sourceVersion, targetVersion, messages) {
  const sourceSystem = LIBRARY_TYPE_SYSTEMS[sourceVersion];
  const targetSystem = LIBRARY_TYPE_SYSTEMS[targetVersion];
  if (!sourceSystem || !targetSystem || !Array.isArray(target?.type?.coding)) return;

  target.type.coding.forEach((coding, index) => {
    if (coding?.system !== sourceSystem) return;

    coding.system = targetSystem;
    messages.push(infoMessage(
      `Library.type.coding[${index}].system was updated from "${sourceSystem}" to `
      + `"${targetSystem}" because the LibraryType code system canonical changed between `
      + `${sourceVersion} and ${targetVersion}`,
    ));
  });
}

/**
 * Convert an STU3 Reference into an R4 canonical primitive.
 *
 * Reference element metadata becomes primitive metadata. Display is retained
 * through the standard rendered-value extension; Identifier has no canonical
 * representation and is reported.
 *
 * @param {Object|undefined} reference STU3 Reference.
 * @param {Object} target Object receiving the canonical.
 * @param {string} key Target primitive key.
 * @param {string} path Diagnostic path.
 * @param {Array<Object>} messages Diagnostic messages to append.
 */
function referenceToCanonical(reference, target, key, path, messages) {
  delete target[key];
  delete target[`_${key}`];
  if (!reference || typeof reference !== 'object') return;

  const companion = {};
  const referenceMetadata = reference._reference;
  const elementId = reference.id;
  const referenceId = referenceMetadata?.id;

  if (elementId != null) companion.id = elementId;
  else if (referenceId != null) companion.id = referenceId;

  if (elementId != null && referenceId != null && elementId !== referenceId) {
    messages.push(warningMessage(
      `${path} carries different ids on the Reference and its reference primitive; R4 canonical `
      + `has room for one id, so Reference.id "${elementId}" was retained and _reference.id `
      + `"${referenceId}" was dropped`,
    ));
  }

  appendExtensions(companion, reference.extension);
  appendExtensions(companion, referenceMetadata?.extension);

  if (hasAnyContent(reference, ['display', '_display'])) {
    const rendered = { url: RENDERED_VALUE_URL };
    if (Object.hasOwn(reference, 'display')) rendered.valueString = reference.display;
    if (Object.hasOwn(reference, '_display')) {
      rendered._valueString = structuredClone(reference._display);
    }
    appendExtensions(companion, [rendered]);
  }

  if (hasAnyContent(reference, ['identifier'])) {
    messages.push(warningMessage(
      `${path}.identifier has no R4 canonical equivalent and was dropped`,
    ));
  }

  if (Object.hasOwn(reference, 'reference')) target[key] = reference.reference;
  const hasExtension = Array.isArray(companion.extension) && companion.extension.length > 0;
  if (Object.keys(companion).length > 0 && (Object.hasOwn(target, key) || hasExtension)) {
    target[`_${key}`] = companion;
  }
  else if (Object.keys(companion).length > 0) {
    messages.push(warningMessage(
      `${path} had no reference value or extension; its id-only metadata was dropped because `
      + 'an id alone would make an invalid value-less canonical',
    ));
  }
}

/**
 * Convert an R4 canonical primitive into an STU3 Reference.
 *
 * @param {Object} source Object containing the canonical.
 * @param {string} key Source primitive key.
 * @param {string} path Diagnostic path.
 * @param {Array<Object>} messages Diagnostic messages to append.
 * @returns {Object|undefined} STU3 Reference, or undefined when no valid content exists.
 */
function canonicalToReference(source, key, path, messages) {
  const value = source?.[key];
  const companion = source?.[`_${key}`];
  const reference = {};

  if (typeof value === 'string') {
    const stripped = stripCanonicalVersion(value);
    reference.reference = stripped;
    if (stripped !== value) {
      messages.push(warningMessage(
        `${path} "${value}" pins a canonical version, which R3 Reference cannot express; `
        + `the version was dropped, leaving "${stripped}"`,
      ));
    }
  }

  if (companion && typeof companion === 'object') {
    if (companion.id != null) reference.id = companion.id;
    appendExtensions(reference, companion.extension);
  }

  const hasExtension = Array.isArray(reference.extension) && reference.extension.length > 0;
  if (Object.hasOwn(reference, 'reference') || hasExtension) return reference;
  if (Object.keys(reference).length > 0) {
    messages.push(warningMessage(
      `${path} had no canonical value or extension; its id-only metadata was dropped because `
      + 'an id alone would make an invalid empty Reference',
    ));
  }
  return undefined;
}

/**
 * Rebuild STU3 contributors as R4 ContactDetail buckets.
 *
 * @param {Object} target FML-converted R4 Library, mutated in place.
 * @param {Object} source STU3 Library source.
 * @param {Array<Object>} messages Diagnostic messages to append.
 */
function rebuildR4Contributors(target, source, messages) {
  for (const bucket of CONTRIBUTOR_BUCKETS) delete target[bucket];
  if (!Array.isArray(source?.contributor)) return;

  source.contributor.forEach((contributor, index) => {
    const bucket = contributor?.type;
    if (!CONTRIBUTOR_BUCKETS.includes(bucket)) {
      const reason = typeof bucket === 'string'
        ? `type "${bucket}" is not one of ${CONTRIBUTOR_BUCKETS.join(', ')}`
        : 'its required R3 type code is absent';
      messages.push(warningMessage(
        `Library.contributor[${index}] was dropped because ${reason}; R4 represents `
        + 'contributor types as separate author, editor, reviewer, and endorser fields',
      ));
      return;
    }

    const detail = {};
    if (contributor.id != null) detail.id = contributor.id;
    if (Array.isArray(contributor.extension)) {
      detail.extension = structuredClone(contributor.extension);
    }
    if (Object.hasOwn(contributor, 'name')) detail.name = contributor.name;
    if (Object.hasOwn(contributor, '_name')) detail._name = structuredClone(contributor._name);

    const telecom = [];
    let lostContactMetadata = false;
    for (const contact of contributor.contact || []) {
      if (Array.isArray(contact?.telecom)) telecom.push(...structuredClone(contact.telecom));
      if (hasAnyContent(contact, ['id', 'extension', 'name', '_name'])) {
        lostContactMetadata = true;
      }
    }
    if (telecom.length > 0) detail.telecom = telecom;

    if (!Array.isArray(target[bucket])) target[bucket] = [];
    target[bucket].push(detail);

    if (lostContactMetadata) {
      messages.push(warningMessage(
        `Library.contributor[${index}].contact contains nested ContactDetail identity, name, `
        + 'or extension content that R4 cannot retain when flattening contacts; telecom values '
        + 'were preserved',
      ));
    }
    if (hasAnyContent(contributor, ['_type'])) {
      messages.push(warningMessage(
        `Library.contributor[${index}]._type primitive metadata was dropped because R4 encodes `
        + `the contributor type structurally as Library.${bucket}`,
      ));
    }
  });
}

/**
 * Rebuild R4 ContactDetail buckets as valid STU3 Contributors.
 *
 * @param {Object} target FML-converted STU3 Library, mutated in place.
 * @param {Object} source R4 Library source.
 * @param {Array<Object>} messages Diagnostic messages to append.
 */
function rebuildR3Contributors(target, source, messages) {
  const contributors = [];

  for (const bucket of CONTRIBUTOR_BUCKETS) {
    for (const [index, detail] of (source?.[bucket] || []).entries()) {
      const contributor = { type: bucket };
      if (detail?.id != null) contributor.id = detail.id;
      if (Array.isArray(detail?.extension)) {
        contributor.extension = structuredClone(detail.extension);
      }
      if (Object.hasOwn(detail || {}, 'name')) contributor.name = detail.name;
      if (Object.hasOwn(detail || {}, '_name')) {
        contributor._name = structuredClone(detail._name);
      }
      if (Array.isArray(detail?.telecom) && detail.telecom.length > 0) {
        contributor.contact = [{ telecom: structuredClone(detail.telecom) }];
      }

      if (!hasPrimitiveValueOrExtension(contributor, 'name')) {
        addDataAbsentReasonExtension(contributor, 'name');
        messages.push(warningMessage(
          `Library.${bucket}[${index}].name is optional in R4 but Contributor.name is required `
          + 'in R3; data-absent-reason "unknown" was added instead of inventing a name',
        ));
      }
      contributors.push(contributor);
    }
  }

  if (contributors.length > 0) target.contributor = contributors;
  else delete target.contributor;
}

/**
 * Repair Reference/canonical changes in ParameterDefinition.profile.
 *
 * @param {Object} target Converted Library, mutated in place.
 * @param {Object} source Source Library.
 * @param {string} direction Conversion direction.
 * @param {Array<Object>} messages Diagnostic messages to append.
 */
function normalizeParameterProfiles(target, source, direction, messages) {
  const sourceParameters = source?.parameter;
  const targetParameters = target?.parameter;
  if (!Array.isArray(sourceParameters) || !Array.isArray(targetParameters)) return;

  sourceParameters.forEach((parameter, index) => {
    const targetParameter = targetParameters[index];
    if (!targetParameter) return;
    const path = `Library.parameter[${index}].profile`;

    if (direction === 'R3->R4') {
      referenceToCanonical(parameter?.profile, targetParameter, 'profile', path, messages);
      return;
    }

    delete targetParameter.profile;
    delete targetParameter._profile;
    const reference = canonicalToReference(parameter, 'profile', path, messages);
    if (reference) targetParameter.profile = reference;
  });
}

/**
 * Repair RelatedArtifact.resource Reference/canonical changes.
 *
 * @param {Object} target Converted Library, mutated in place.
 * @param {Object} source Source Library.
 * @param {string} direction Conversion direction.
 * @param {Array<Object>} messages Diagnostic messages to append.
 */
function normalizeRelatedArtifactResources(target, source, direction, messages) {
  const sourceArtifacts = source?.relatedArtifact;
  const targetArtifacts = target?.relatedArtifact;
  if (!Array.isArray(sourceArtifacts) || !Array.isArray(targetArtifacts)) return;

  sourceArtifacts.forEach((artifact, index) => {
    const targetArtifact = targetArtifacts[index];
    if (!targetArtifact) return;
    const path = `Library.relatedArtifact[${index}].resource`;

    if (direction === 'R3->R4') {
      referenceToCanonical(artifact?.resource, targetArtifact, 'resource', path, messages);
      return;
    }

    delete targetArtifact.resource;
    delete targetArtifact._resource;
    const reference = canonicalToReference(artifact, 'resource', path, messages);
    if (reference) targetArtifact.resource = reference;
  });
}

/**
 * Repair STU3 DataRequirement value-set references and report content lost
 * while flattening CodeableConcept values into R4 Coding values.
 *
 * @param {Object} target Converted R4 Library, mutated in place.
 * @param {Object} source STU3 Library.
 * @param {Array<Object>} messages Diagnostic messages to append.
 */
function normalizeR4DataRequirements(target, source, messages) {
  const sourceRequirements = source?.dataRequirement;
  const targetRequirements = target?.dataRequirement;
  if (!Array.isArray(sourceRequirements) || !Array.isArray(targetRequirements)) return;

  sourceRequirements.forEach((requirement, requirementIndex) => {
    const targetRequirement = targetRequirements[requirementIndex];
    if (!targetRequirement) return;

    (requirement?.codeFilter || []).forEach((filter, filterIndex) => {
      const targetFilter = targetRequirement.codeFilter?.[filterIndex];
      if (!targetFilter) return;
      const path = `Library.dataRequirement[${requirementIndex}].codeFilter[${filterIndex}]`;

      if (filter?.valueSetReference) {
        referenceToCanonical(
          filter.valueSetReference,
          targetFilter,
          'valueSet',
          `${path}.valueSetReference`,
          messages,
        );
      }

      (filter?.valueCodeableConcept || []).forEach((concept, conceptIndex) => {
        if (!hasAnyContent(concept, ['id', 'extension', 'text', '_text'])) return;
        messages.push(warningMessage(
          `${path}.valueCodeableConcept[${conceptIndex}] carries CodeableConcept-level `
          + 'identity, extension, or text content that R4 codeFilter.code cannot represent; '
          + 'its Coding entries were preserved',
        ));
      });
    });
  });
}

/**
 * Normalize one repeating canonical array into STU3 uri values.
 *
 * @param {Object} target Object whose array is mutated.
 * @param {string} key Primitive-array key.
 * @param {string} path Diagnostic path.
 * @param {Array<Object>} messages Diagnostic messages to append.
 */
function stripCanonicalArrayVersions(target, key, path, messages) {
  if (!Array.isArray(target?.[key])) return;

  target[key] = target[key].map((value, index) => {
    if (typeof value !== 'string') return value;
    const stripped = stripCanonicalVersion(value);
    if (stripped !== value) {
      messages.push(warningMessage(
        `${path}[${index}] "${value}" pins a canonical version, which R3 uri cannot `
        + `express; the version was dropped, leaving "${stripped}"`,
      ));
    }
    return stripped;
  });
}

/**
 * Repair R4 DataRequirement narrowing into STU3.
 *
 * @param {Object} target Converted STU3 Library, mutated in place.
 * @param {Object} source R4 Library.
 * @param {Array<Object>} messages Diagnostic messages to append.
 */
function normalizeR3DataRequirements(target, source, messages) {
  const sourceRequirements = source?.dataRequirement;
  const targetRequirements = target?.dataRequirement;
  if (!Array.isArray(sourceRequirements) || !Array.isArray(targetRequirements)) return;

  sourceRequirements.forEach((requirement, requirementIndex) => {
    const targetRequirement = targetRequirements[requirementIndex];
    if (!targetRequirement) return;
    const basePath = `Library.dataRequirement[${requirementIndex}]`;
    stripCanonicalArrayVersions(targetRequirement, 'profile', `${basePath}.profile`, messages);

    (requirement?.codeFilter || []).forEach((filter, filterIndex) => {
      const targetFilter = targetRequirement.codeFilter?.[filterIndex];
      if (!targetFilter) return;
      const path = `${basePath}.codeFilter[${filterIndex}]`;

      delete targetFilter.valueSet;
      delete targetFilter._valueSet;
      delete targetFilter.valueCode;
      delete targetFilter._valueCode;
      delete targetFilter.valueCoding;
      delete targetFilter.valueCodeableConcept;

      if (hasAnyContent(filter, ['valueSet', '_valueSet'])) {
        if (Object.hasOwn(filter, 'valueSet')) {
          targetFilter.valueSetString = filter.valueSet;
        }
        if (Object.hasOwn(filter, '_valueSet')) {
          targetFilter._valueSetString = structuredClone(filter._valueSet);
        }
        if (typeof targetFilter.valueSetString === 'string') {
          const original = targetFilter.valueSetString;
          const stripped = stripCanonicalVersion(original);
          targetFilter.valueSetString = stripped;
          if (stripped !== original) {
            messages.push(warningMessage(
              `${path}.valueSet "${original}" pins a canonical version, which R3 string `
              + `cannot express as a versioned canonical; the version was dropped, leaving `
              + `"${stripped}"`,
            ));
          }
        }
      }

      if (Array.isArray(filter?.code) && filter.code.length > 0) {
        targetFilter.valueCoding = structuredClone(filter.code);
      }

      if (!hasPrimitiveValueOrExtension(filter, 'path')) {
        addDataAbsentReasonExtension(targetFilter, 'path');
        messages.push(warningMessage(
          `${path}.path is required in R3 but the R4 source provides only `
          + `${hasAnyContent(filter, ['searchParam', '_searchParam'])
            ? 'searchParam' : 'no path'}; `
          + 'data-absent-reason "unknown" was added because a search parameter code cannot be '
          + 'safely invented as a FHIRPath expression',
        ));
      }
    });

    (requirement?.dateFilter || []).forEach((filter, filterIndex) => {
      const targetFilter = targetRequirement.dateFilter?.[filterIndex];
      if (!targetFilter || hasPrimitiveValueOrExtension(filter, 'path')) return;
      addDataAbsentReasonExtension(targetFilter, 'path');
      messages.push(warningMessage(
        `${basePath}.dateFilter[${filterIndex}].path is required in R3 but the R4 source `
        + `provides only ${hasAnyContent(filter, ['searchParam', '_searchParam'])
          ? 'searchParam' : 'no path'}; data-absent-reason "unknown" was added because a `
        + 'search parameter code cannot be safely invented as a FHIRPath expression',
      ));
    });
  });
}

/**
 * Normalize required ParameterDefinition/DataRequirement type codes.
 *
 * @param {Object} target Converted Library, mutated in place.
 * @param {Object} source Source Library.
 * @param {string} sourceVersion Source version.
 * @param {string} targetVersion Target version.
 * @param {Array<Object>} messages Diagnostic messages to append.
 */
function normalizeRequiredTypes(target, source, sourceVersion, targetVersion, messages) {
  const policy = REQUIRED_TYPE_POLICIES[`${sourceVersion}->${targetVersion}`];
  const actions = normalizeLibraryRequiredTypes(target, source, policy);
  messages.push(...describeLibraryTypeActions(actions, sourceVersion, targetVersion));
}

/**
 * Report R4-only content that STU3 cannot represent.
 *
 * @param {Object} source R4 Library source.
 * @param {Array<Object>} messages Diagnostic messages to append.
 */
function reportR4OnlyContent(source, messages) {
  const paths = new Set();

  if (hasAnyContent(source, ['subtitle', '_subtitle'])) paths.add('Library.subtitle');
  if (hasAnyContent(source, ['subjectCodeableConcept', 'subjectReference'])) {
    paths.add('Library.subject[x]');
  }

  for (const requirement of source?.dataRequirement || []) {
    if (hasAnyContent(requirement, ['subjectCodeableConcept', 'subjectReference'])) {
      paths.add('Library.dataRequirement.subject[x]');
    }
    if (hasAnyContent(requirement, ['limit', '_limit'])) {
      paths.add('Library.dataRequirement.limit');
    }
    if (hasAnyContent(requirement, ['sort'])) paths.add('Library.dataRequirement.sort');
    for (const filter of requirement?.codeFilter || []) {
      if (hasAnyContent(filter, ['searchParam', '_searchParam'])) {
        paths.add('Library.dataRequirement.codeFilter.searchParam');
      }
    }
    for (const filter of requirement?.dateFilter || []) {
      if (hasAnyContent(filter, ['searchParam', '_searchParam'])) {
        paths.add('Library.dataRequirement.dateFilter.searchParam');
      }
    }
  }

  for (const artifact of source?.relatedArtifact || []) {
    if (hasAnyContent(artifact, ['label', '_label'])) {
      paths.add('Library.relatedArtifact.label');
    }
  }

  if (paths.size > 0) {
    messages.push(warningMessage(
      `R4-only Library content was dropped because R3 has no equivalent: `
      + [...paths].sort().join(', '),
    ));
  }
}

/**
 * Convert STU3 Library post-FML output into valid R4 shape.
 *
 * @param {Object} target FML-converted R4 Library, mutated in place.
 * @param {Object} ctx Hop context.
 * @returns {{resource: Object, status: string, messages: Array<Object>}} Result.
 */
function convertR3ToR4(target, ctx) {
  const messages = [];
  const source = ctx?.sourceResource || {};

  rebuildR4Contributors(target, source, messages);
  normalizeLibraryTypeSystem(target, 'R3', 'R4', messages);
  normalizeParameterProfiles(target, source, 'R3->R4', messages);
  normalizeRelatedArtifactResources(target, source, 'R3->R4', messages);
  normalizeR4DataRequirements(target, source, messages);
  normalizeRequiredTypes(target, source, 'R3', 'R4', messages);

  if (typeof target?.name === 'string' && !R4_LIB_0_NAME.test(target.name)) {
    messages.push(warningMessage(
      `Library.name "${target.name}" does not satisfy R4 warning invariant lib-0 `
      + '(name should be usable as an identifier for machine processing); R3 does not '
      + 'impose this rule. The name was left unchanged because it identifies the resource',
    ));
  }

  return { resource: target, status: statusFromMessages(messages), messages };
}

/**
 * Convert R4 Library post-FML output into valid STU3 shape.
 *
 * @param {Object} target FML-converted STU3 Library, mutated in place.
 * @param {Object} ctx Hop context.
 * @returns {{resource: Object, status: string, messages: Array<Object>}} Result.
 */
function convertR4ToR3(target, ctx) {
  const messages = [];
  const source = ctx?.sourceResource || {};

  removeUnrepresentableUsageContexts(target, source, messages);
  reportR4OnlyContent(source, messages);
  rebuildR3Contributors(target, source, messages);
  normalizeLibraryTypeSystem(target, 'R4', 'R3', messages);
  normalizeParameterProfiles(target, source, 'R4->R3', messages);
  normalizeRelatedArtifactResources(target, source, 'R4->R3', messages);
  normalizeR3DataRequirements(target, source, messages);
  normalizeRequiredTypes(target, source, 'R4', 'R3', messages);
  repairR4ToR3MetaAndExtensions(target, source, messages);

  return { resource: target, status: statusFromMessages(messages), messages };
}

/** R3 -> R4 Library postprocessor descriptor. */
export const conv_R3_to_R4 = {
  name: 'Library_R3_to_R4',
  coverage: COVERAGE.BEST_EFFORT,
  description:
    'Rebuilds contributor buckets, repairs Reference-to-canonical fields, normalizes required '
    + 'ParameterDefinition and DataRequirement FHIR types and the LibraryType code system '
    + 'canonical, reports CodeableConcept detail lost from code filters and invalid '
    + 'contributors that cannot be bucketed, and reports R4 warning invariant lib-0. Does not '
    + 'handle inter-version extensions.',
  execute: convertR3ToR4,
};

/** R4 -> R3 Library postprocessor descriptor. */
export const conv_R4_to_R3 = {
  name: 'Library_R4_to_R3',
  coverage: COVERAGE.BEST_EFFORT,
  description:
    'Rebuilds valid R3 contributors, repairs canonical-to-Reference fields and DataRequirement '
    + 'narrowing, normalizes required ParameterDefinition and DataRequirement FHIR types and '
    + 'the LibraryType code system canonical, removes Reference-valued UsageContext entries, '
    + 'reports R4 Meta.source loss, removes invalid ordinary Extensions, and reports other '
    + 'R4-only content. Does not handle '
    + 'inter-version extensions.',
  execute: convertR4ToR3,
};
