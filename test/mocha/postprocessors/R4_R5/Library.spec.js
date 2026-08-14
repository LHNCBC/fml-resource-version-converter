/**
 * Tests for reviewed Library conversion between R4 and R5.
 */
import { strict as assert } from 'node:assert';
import { COVERAGE } from '../../../../src/converter/coverage.js';
import { MESSAGE_TYPE, STATUS } from '../../../../src/converter/diagnostics.js';
import { singleHopConverter } from '../../../../src/converter/singleHopConverter.js';
import { conv_R4_to_R5, conv_R5_to_R4 } from '../../../../src/postprocessors/R4_R5/Library.js';

/**
 * Build a Library containing representative fields shared by R4 and R5.
 *
 * @returns {Object} Fresh Library fixture.
 */
function makeSharedLibrary() {
  return {
    resourceType: 'Library',
    id: 'shared-library',
    meta: { tag: [{ system: 'http://example.org/tags', code: 'reviewed' }] },
    url: 'http://example.org/fhir/Library/shared',
    version: '1.0.0',
    name: 'SharedLibrary',
    title: 'Shared library',
    status: 'active',
    type: { text: 'Logic library' },
    subjectCodeableConcept: { text: 'All patients' },
    publisher: 'Example Publisher',
    usage: 'Use for conversion tests.',
    content: [{
      contentType: 'text/plain',
      url: 'http://example.org/library.cql',
      size: 10,
      title: 'CQL source',
    }],
    relatedArtifact: [{
      type: 'documentation',
      label: 'Documentation',
      display: 'Implementation guide',
      citation: 'Example citation',
      resource: 'http://example.org/fhir/ImplementationGuide/example|1.0.0',
    }],
  };
}

/**
 * Build an R5 Library exercising every R5-only path reachable from Library.
 *
 * @returns {Object} Fresh R5 Library fixture.
 */
function makeR5LossLibrary() {
  const source = makeSharedLibrary();
  source.content[0].size = '10';
  source.versionAlgorithmCoding = {
    system: 'http://example.org/version-algorithm',
    code: 'semver',
  };
  source.copyrightLabel = 'Copyright Example Publisher';
  Object.assign(source.content[0], {
    duration: 3.5,
    frames: 30,
    height: 1080,
    pages: 4,
    width: 1920,
  });
  source.dataRequirement = [{
    type: 'Observation',
    valueFilter: [{
      path: 'value',
      comparator: 'eq',
      valueDateTime: '2026-08-13',
    }],
  }];
  source.relatedArtifact = [{
    ...source.relatedArtifact[0],
    classifier: [{ text: 'Clinical guidance' }],
    publicationDate: '2026-08-13',
    publicationStatus: 'active',
    resourceReference: { reference: 'DocumentReference/1' },
    document: {
      contentType: 'video/mp4',
      url: 'http://example.org/walkthrough.mp4',
      duration: 60.5,
      frames: 1800,
      height: 720,
      pages: 2,
      width: 1280,
    },
  }];

  return source;
}

describe('postprocessors/R4_R5 Library', function () {
  describe('R4 -> R5 through singleHopConverter.convert', function () {
    it('registers known FML gaps and best-effort final coverage', function () {
      const result = singleHopConverter.convert(makeSharedLibrary(), 'R4', 'R5');

      assert.equal(result.coverage, COVERAGE.BEST_EFFORT);
      assert.equal(result.fml_base_conv.coverage, COVERAGE.KNOWN_GAPS);
      assert.equal(result.postprocessors.length, 1);
      assert.equal(result.postprocessors[0].name, 'Library_R4_to_R5');
      assert.equal(result.postprocessors[0].coverage, COVERAGE.BEST_EFFORT);
    });

    it('preserves representative shared root and embedded-datatype content', function () {
      const source = makeSharedLibrary();
      const result = singleHopConverter.convert(source, 'R4', 'R5');

      assert.equal(result.status, STATUS.OK);
      assert.deepEqual(result.postprocessors[0].messages, []);
      for (const field of ['url', 'version', 'name', 'title', 'status', 'publisher', 'usage']) {
        assert.equal(result.resource[field], source[field], `lost Library.${field}`);
      }
      assert.deepEqual(result.resource.subjectCodeableConcept, source.subjectCodeableConcept);
      assert.equal(result.resource.content[0].size, '10');
      for (const field of ['contentType', 'url', 'title']) {
        assert.equal(result.resource.content[0][field], source.content[0][field]);
      }
      assert.deepEqual(result.resource.relatedArtifact, source.relatedArtifact);
      assert.deepEqual(result.resource.meta.tag, source.meta.tag);
      assert.deepEqual(result.resource.meta.profile, [
        'http://hl7.org/fhir/5.0/StructureDefinition/Library',
      ]);
    });

    it('reports and drops RelatedArtifact.url without conflating it with resource', function () {
      const source = makeSharedLibrary();
      source.relatedArtifact = [
        {
          type: 'documentation',
          url: 'http://example.org/guide.html',
          resource: 'http://example.org/fhir/ImplementationGuide/example',
        },
        { type: 'documentation', url: 'http://example.org/second-guide.html' },
      ];
      const result = singleHopConverter.convert(source, 'R4', 'R5');
      const warning = result.postprocessors[0].messages[0];

      assert.equal(result.status, STATUS.WARNING);
      assert.equal(warning.type, MESSAGE_TYPE.WARNING);
      assert.match(warning.text, /R4-only Library content was dropped because R5 has no equivalent/);
      assert.match(warning.text, /Library\.relatedArtifact\.url/);
      assert.equal((warning.text.match(/Library\.relatedArtifact\.url/g) || []).length, 1);
      assert.equal('url' in result.resource.relatedArtifact[0], false);
      assert.equal('url' in result.resource.relatedArtifact[1], false);
      assert.equal(result.resource.relatedArtifact[0].resource, source.relatedArtifact[0].resource);
      assert.equal('resource' in result.resource.relatedArtifact[1], false);
    });

    it('reports R4 identity values that trip R5 warning invariants without rewriting them', function () {
      const source = makeSharedLibrary();
      source.name = 'A';
      source.url = 'http://example.org/fhir/Library/example#fragment';
      const result = singleHopConverter.convert(source, 'R4', 'R5');
      const text = result.postprocessors[0].messages.map(message => message.text).join('\n');

      assert.equal(result.status, STATUS.WARNING);
      assert.equal(result.resource.name, source.name);
      assert.equal(result.resource.url, source.url);
      assert.match(text, /Library\.name "A".*R5 warning invariant cnl-0/);
      assert.match(text, /Library\.url .*R5 warning invariant cnl-1/);
      assert.match(text, /left unchanged because it identifies the resource/);
    });

    it('normalizes required FHIR types in ParameterDefinition and '
      + 'DataRequirement', function () {
      const source = makeSharedLibrary();
      source.parameter = [
        {
          name: 'device',
          use: 'in',
          min: 0,
          max: '1',
          type: 'DeviceUseStatement',
          _type: { id: 'parameter-type-metadata' },
        },
        { name: 'catalog', use: 'in', min: 0, max: '1', type: 'CatalogEntry' },
        { name: 'observation', use: 'in', min: 0, max: '1', type: 'Observation' },
      ];
      source.dataRequirement = [
        {
          type: 'DeviceUseStatement',
          _type: { id: 'device-type-metadata' },
          mustSupport: ['status'],
        },
        { type: 'MedicinalProduct' },
        { type: 'RequestGroup' },
        { type: 'SubstanceSpecification' },
        { type: 'CatalogEntry' },
        { type: 'Observation' },
      ];
      const result = singleHopConverter.convert(source, 'R4', 'R5');
      const messages = result.postprocessors[0].messages;

      assert.deepEqual(result.resource.parameter.map(entry => entry.type), [
        'DeviceUsage',
        'Observation',
      ]);
      assert.deepEqual(result.resource.parameter[0]._type, source.parameter[0]._type);
      assert.deepEqual(result.resource.dataRequirement.map(entry => entry.type), [
        'DeviceUsage',
        'MedicinalProductDefinition',
        'RequestOrchestration',
        'SubstanceDefinition',
        'Observation',
      ]);
      assert.deepEqual(result.resource.dataRequirement[0]._type, source.dataRequirement[0]._type);
      assert.deepEqual(result.resource.dataRequirement[0].mustSupport, ['status']);
      assert.ok(messages.some(message =>
        message.type === MESSAGE_TYPE.INFO
        && /parameter\[0\].type was renamed from "DeviceUseStatement" to "DeviceUsage"/
          .test(message.text)));
      assert.ok(messages.some(message =>
        message.type === MESSAGE_TYPE.WARNING
        && /parameter\[1\].*type "CatalogEntry" is defined only in R4/
          .test(message.text)));
      assert.ok(messages.some(message =>
        message.type === MESSAGE_TYPE.INFO
        && /dataRequirement\[0\].type was renamed from "DeviceUseStatement" to "DeviceUsage"/
          .test(message.text)));
    });

    it('removes every R4-only datatype from required type bindings', function () {
      const source = makeSharedLibrary();
      const unsupported = [
        'Any',
        'MoneyQuantity',
        'Population',
        'ProdCharacteristic',
        'SimpleQuantity',
        'SubstanceAmount',
        'Type',
      ];
      source.parameter = [
        ...unsupported.map((type, index) => ({
          name: `unsupported-${index}`,
          use: 'in',
          min: 0,
          max: '1',
          type,
        })),
        { name: 'shared', use: 'in', min: 0, max: '1', type: 'string' },
      ];
      source.dataRequirement = [
        ...unsupported.map(type => ({ type })),
        { type: 'Observation' },
      ];

      const result = singleHopConverter.convert(source, 'R4', 'R5');
      const text = result.postprocessors[0].messages.map(message => message.text).join('\n');

      assert.deepEqual(result.resource.parameter.map(entry => entry.type), ['string']);
      assert.deepEqual(result.resource.dataRequirement.map(entry => entry.type), ['Observation']);
      for (const type of unsupported) {
        assert.match(text, new RegExp(`required type "${type}".*no R5 type equivalent`));
      }
    });
  });

  describe('R5 -> R4 through singleHopConverter.convert', function () {
    let result;
    let source;

    before(function () {
      source = makeR5LossLibrary();
      result = singleHopConverter.convert(source, 'R5', 'R4');
    });

    it('registers known FML gaps and best-effort final coverage', function () {
      assert.equal(result.coverage, COVERAGE.BEST_EFFORT);
      assert.equal(result.fml_base_conv.coverage, COVERAGE.KNOWN_GAPS);
      assert.equal(result.postprocessors.length, 1);
      assert.equal(result.postprocessors[0].name, 'Library_R5_to_R4');
      assert.equal(result.postprocessors[0].coverage, COVERAGE.BEST_EFFORT);
    });

    it('reports every R5-only root and nested path that was dropped', function () {
      const warning = result.postprocessors[0].messages.find(message =>
        message.type === MESSAGE_TYPE.WARNING && /content was dropped/.test(message.text));

      assert.ok(warning);
      assert.match(warning.text, /R5-only Library content was dropped because R4 has no equivalent/);
      for (const path of [
        'Library.versionAlgorithm\\[x\\]',
        'Library.copyrightLabel',
        'Library.content.duration',
        'Library.content.frames',
        'Library.content.height',
        'Library.content.pages',
        'Library.content.width',
        'Library.dataRequirement.valueFilter',
        'Library.relatedArtifact.classifier',
        'Library.relatedArtifact.publicationDate',
        'Library.relatedArtifact.publicationStatus',
        'Library.relatedArtifact.resourceReference',
        'Library.relatedArtifact.document.duration',
        'Library.relatedArtifact.document.frames',
        'Library.relatedArtifact.document.height',
        'Library.relatedArtifact.document.pages',
        'Library.relatedArtifact.document.width',
      ]) {
        assert.match(warning.text, new RegExp(path));
      }
    });

    it('actually removes the R5-only content while preserving shared content', function () {
      assert.equal(result.status, STATUS.WARNING);
      assert.equal('versionAlgorithmCoding' in result.resource, false);
      assert.equal('copyrightLabel' in result.resource, false);
      for (const field of ['duration', 'frames', 'height', 'pages', 'width']) {
        assert.equal(field in result.resource.content[0], false);
        assert.equal(field in result.resource.relatedArtifact[0].document, false);
      }
      assert.equal('valueFilter' in result.resource.dataRequirement[0], false);
      for (const field of [
        'classifier', 'publicationDate', 'publicationStatus', 'resourceReference',
      ]) {
        assert.equal(field in result.resource.relatedArtifact[0], false);
      }

      assert.equal(result.resource.url, source.url);
      assert.equal(result.resource.name, source.name);
      assert.equal(result.resource.content[0].size, 10);
      assert.equal(result.resource.relatedArtifact[0].resource, source.relatedArtifact[0].resource);
      assert.equal(
        result.resource.relatedArtifact[0].document.url,
        source.relatedArtifact[0].document.url,
      );
      assert.deepEqual(result.resource.meta.profile, [
        'http://hl7.org/fhir/4.0/StructureDefinition/Library',
      ]);
    });

    it('does not warn when the R5 source contains only R4-compatible content', function () {
      const converted = singleHopConverter.convert(makeSharedLibrary(), 'R5', 'R4');

      assert.equal(converted.status, STATUS.OK);
      assert.deepEqual(converted.postprocessors[0].messages, []);
    });

    it('normalizes required FHIR types in ParameterDefinition and '
      + 'DataRequirement', function () {
      const typedSource = makeSharedLibrary();
      typedSource.content[0].size = '10';
      typedSource.parameter = [
        { name: 'device', use: 'in', min: 0, max: '1', type: 'DeviceUsage' },
        { name: 'actor', use: 'in', min: 0, max: '1', type: 'ActorDefinition' },
        { name: 'observation', use: 'in', min: 0, max: '1', type: 'Observation' },
      ];
      typedSource.dataRequirement = [
        { type: 'DeviceUsage' },
        { type: 'MedicinalProductDefinition' },
        { type: 'RequestOrchestration' },
        { type: 'SubstanceDefinition' },
        { type: 'ActorDefinition' },
        { type: 'Observation', mustSupport: ['status'] },
      ];
      const converted = singleHopConverter.convert(typedSource, 'R5', 'R4');
      const messages = converted.postprocessors[0].messages;

      assert.deepEqual(converted.resource.parameter.map(entry => entry.type), [
        'DeviceUseStatement',
        'Observation',
      ]);
      assert.deepEqual(converted.resource.dataRequirement.map(entry => entry.type), [
        'DeviceUseStatement',
        'MedicinalProduct',
        'RequestGroup',
        'SubstanceSpecification',
        'Observation',
      ]);
      assert.deepEqual(converted.resource.dataRequirement[4].mustSupport, ['status']);
      assert.ok(messages.some(message =>
        message.type === MESSAGE_TYPE.INFO
        && /parameter\[0\].type was renamed from "DeviceUsage" to "DeviceUseStatement"/
          .test(message.text)));
      assert.ok(messages.some(message =>
        message.type === MESSAGE_TYPE.WARNING
        && /parameter\[1\].*type "ActorDefinition" is defined only in R5/
          .test(message.text)));
      assert.ok(messages.some(message =>
        message.type === MESSAGE_TYPE.INFO
        && /dataRequirement\[2\].type was renamed from "RequestOrchestration" to "RequestGroup"/
          .test(message.text)));
    });

    it('approximates or removes every R5-only datatype in required type bindings', function () {
      const typedSource = makeSharedLibrary();
      const unsupported = [
        'Availability',
        'BackboneType',
        'Base',
        'CodeableReference',
        'DataType',
        'ExtendedContactDetail',
        'MonetaryComponent',
        'PrimitiveType',
        'RatioRange',
        'VirtualServiceDetail',
      ];
      typedSource.content[0].size = '10';
      typedSource.parameter = [
        {
          name: 'wide-integer',
          use: 'in',
          min: 0,
          max: '1',
          type: 'integer64',
          _type: { id: 'integer64-type-id' },
        },
        ...unsupported.map((type, index) => ({
          name: `unsupported-${index}`,
          use: 'in',
          min: 0,
          max: '1',
          type,
        })),
        { name: 'shared', use: 'in', min: 0, max: '1', type: 'string' },
      ];
      typedSource.dataRequirement = [
        { type: 'integer64' },
        { type: 'RatioRange' },
        { type: 'Observation' },
      ];

      const converted = singleHopConverter.convert(typedSource, 'R5', 'R4');
      const text = converted.postprocessors[0].messages
        .map(message => message.text)
        .join('\n');

      assert.deepEqual(converted.resource.parameter.map(entry => entry.type), [
        'integer',
        'string',
      ]);
      assert.deepEqual(converted.resource.parameter[0]._type, { id: 'integer64-type-id' });
      assert.deepEqual(converted.resource.dataRequirement.map(entry => entry.type), [
        'integer',
        'Observation',
      ]);
      assert.match(text, /parameter\[0\]\.type "integer64".*approximated as "integer"/);
      for (const type of unsupported) {
        assert.match(text, new RegExp(`required type "${type}".*no R4 type equivalent`));
      }
      assert.match(text, /dataRequirement\[1\].*"RatioRange".*no R4 type equivalent/);
    });

    it('drops R5-only RelatedArtifact relationship codes but keeps aligned shared entries', function () {
      const typedSource = makeSharedLibrary();
      typedSource.content[0].size = '10';
      typedSource.relatedArtifact = [
        { type: 'cite-as', display: 'Preferred citation' },
        { type: 'documentation', display: 'Documentation' },
        { type: 'amends', display: 'Amended artifact' },
      ];
      const converted = singleHopConverter.convert(typedSource, 'R5', 'R4');
      const warnings = converted.postprocessors[0].messages.filter(message =>
        message.type === MESSAGE_TYPE.WARNING);

      assert.deepEqual(converted.resource.relatedArtifact, [
        { type: 'documentation', display: 'Documentation' },
      ]);
      assert.equal(warnings.length, 2);
      assert.match(warnings[0].text, /relatedArtifact\[0\].*type code "cite-as"/);
      assert.match(warnings[1].text, /relatedArtifact\[2\].*type code "amends"/);
      assert.ok(warnings.every(message => /type is required/.test(message.text)));
    });

    it('drops every R5-only RelatedArtifact type and preserves all eight shared codes', function () {
      const r5OnlyTypes = [
        'amended-with', 'amends', 'appended-with', 'appends', 'cite-as', 'cited-by',
        'cites', 'comment-in', 'comments-on', 'contained-in', 'contains', 'correction-in',
        'corrects', 'created-with', 'documents', 'part-of', 'replaced-with', 'replaces',
        'retracted-by', 'retracts', 'signs', 'similar-to', 'specification-of',
        'supported-with', 'supports', 'transformed-into', 'transformed-with', 'transforms',
      ];
      const sharedTypes = [
        'depends-on', 'successor', 'citation', 'documentation', 'derived-from',
        'justification', 'predecessor', 'composed-of',
      ];
      const typedSource = makeSharedLibrary();
      typedSource.content[0].size = '10';
      typedSource.relatedArtifact = [...r5OnlyTypes, ...sharedTypes].map(type => ({ type }));
      const converted = singleHopConverter.convert(typedSource, 'R5', 'R4');
      const typeWarnings = converted.postprocessors[0].messages.filter(message =>
        /RelatedArtifact\.type code/.test(message.text));

      assert.deepEqual(converted.resource.relatedArtifact.map(artifact => artifact.type), sharedTypes);
      assert.equal(typeWarnings.length, r5OnlyTypes.length);
      for (const type of r5OnlyTypes) {
        assert.ok(typeWarnings.some(message => message.text.includes(`"${type}"`)), type);
      }
    });
  });

  describe('processor edge cases', function () {
    it('detects extension-only R4 RelatedArtifact.url content', function () {
      const target = { resourceType: 'Library' };
      const source = {
        resourceType: 'Library',
        relatedArtifact: [{
          type: 'documentation',
          _url: {
            extension: [{
              url: 'http://example.org/fhir/StructureDefinition/artifact-location',
              valueUrl: 'http://example.org/guide',
            }],
          },
        }],
      };
      const converted = conv_R4_to_R5.execute(target, { sourceResource: source });

      assert.equal(converted.resource, target);
      assert.equal(converted.status, STATUS.WARNING);
      assert.match(converted.messages[0].text, /Library\.relatedArtifact\.url/);
    });

    it('detects extension-only R5 primitive additions in every nesting context', function () {
      const target = { resourceType: 'Library' };
      const extension = {
        extension: [{
          url: 'http://example.org/fhir/StructureDefinition/test',
          valueString: 'present',
        }],
      };
      const source = {
        resourceType: 'Library',
        _versionAlgorithmString: extension,
        _copyrightLabel: extension,
        content: [{ _duration: extension }],
        relatedArtifact: [{
          _publicationDate: extension,
          _publicationStatus: extension,
          document: { _width: extension },
        }],
      };
      const converted = conv_R5_to_R4.execute(target, { sourceResource: source });
      const text = converted.messages[0].text;

      assert.equal(converted.resource, target);
      assert.equal(converted.status, STATUS.WARNING);
      for (const path of [
        'Library.versionAlgorithm[x]',
        'Library.copyrightLabel',
        'Library.content.duration',
        'Library.relatedArtifact.publicationDate',
        'Library.relatedArtifact.publicationStatus',
        'Library.relatedArtifact.document.width',
      ]) {
        assert.ok(text.includes(path), `missing ${path}`);
      }
    });

    it('does not mutate a compatible target in either direction', function () {
      const targetR5 = { resourceType: 'Library', name: 'CompatibleLibrary' };
      const targetR4 = { resourceType: 'Library', name: 'CompatibleLibrary' };
      const beforeR5 = structuredClone(targetR5);
      const beforeR4 = structuredClone(targetR4);
      const upgrade = conv_R4_to_R5.execute(targetR5, {
        sourceResource: { resourceType: 'Library' },
      });
      const downgrade = conv_R5_to_R4.execute(targetR4, {
        sourceResource: { resourceType: 'Library' },
      });

      assert.deepEqual(targetR5, beforeR5);
      assert.deepEqual(targetR4, beforeR4);
      assert.equal(upgrade.status, STATUS.OK);
      assert.equal(downgrade.status, STATUS.OK);
    });
  });
});
