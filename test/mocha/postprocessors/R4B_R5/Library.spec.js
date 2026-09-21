/**
 * Tests for reviewed Library conversion between R4B and R5.
 */
import { strict as assert } from 'node:assert';
import { COVERAGE } from '../../../../src/converter/coverage.js';
import { STATUS } from '../../../../src/converter/diagnostics.js';
import { singleHopConverter } from '../../../../src/converter/singleHopConverter.js';
import {
  conv_R4_to_R5,
  conv_R5_to_R4,
} from '../../../../src/postprocessors/R4_R5/Library.js';
import {
  conv_R4B_to_R5,
  conv_R5_to_R4B,
} from '../../../../src/postprocessors/R4B_R5/Library.js';

const compatibleLibrary = {
  resourceType: 'Library',
  url: 'http://example.org/fhir/Library/shared',
  name: 'SharedLibrary',
  status: 'active',
  type: { text: 'Logic library' },
  content: [{ contentType: 'text/plain', size: 10 }],
};

describe('postprocessors/R4B_R5 Library', function () {
  it('reuses the R4 transforms with R4B-specific descriptors', function () {
    assert.equal(conv_R4B_to_R5.execute, conv_R4_to_R5.execute);
    assert.equal(conv_R5_to_R4B.execute, conv_R5_to_R4.execute);
    assert.equal(conv_R4B_to_R5.coverage, COVERAGE.BEST_EFFORT);
    assert.equal(conv_R5_to_R4B.coverage, COVERAGE.BEST_EFFORT);
    assert.equal(conv_R4B_to_R5.name, 'Library_R4B_to_R5');
    assert.equal(conv_R5_to_R4B.name, 'Library_R5_to_R4B');
    assert.match(conv_R4B_to_R5.description, /R4B names or URLs/);
    assert.match(conv_R5_to_R4B.description, /invalid in R4B/);
  });

  it('converts compatible shared content without warnings in both directions', function () {
    for (const [fromVer, toVer, profileVersion, size] of [
      ['R4B', 'R5', '5.0', '10'],
      ['R5', 'R4B', '4.3', 10],
    ]) {
      const result = singleHopConverter.convert(compatibleLibrary, fromVer, toVer);

      assert.equal(result.coverage, COVERAGE.BEST_EFFORT);
      assert.equal(result.fml_base_conv.coverage, COVERAGE.KNOWN_GAPS);
      assert.equal(result.postprocessors.length, 1);
      assert.equal(result.status, STATUS.OK);
      assert.deepEqual(result.postprocessors[0].messages, []);
      assert.equal(result.resource.url, compatibleLibrary.url);
      assert.equal(result.resource.content[0].size, size);
      assert.deepEqual(result.resource.meta.profile, [
        `http://hl7.org/fhir/${profileVersion}/StructureDefinition/Library`,
      ]);
    }
  });

  it('reports the R4B-only RelatedArtifact.url loss using actual hop versions', function () {
    const source = {
      ...compatibleLibrary,
      relatedArtifact: [{
        type: 'documentation',
        url: 'http://example.org/guide.html',
      }],
    };
    const result = singleHopConverter.convert(source, 'R4B', 'R5');
    const text = result.postprocessors[0].messages.map(message => message.text).join('\n');

    assert.equal(result.status, STATUS.WARNING);
    assert.match(text, /R4B-only Library content was dropped because R5 has no equivalent/);
    assert.match(text, /Library\.relatedArtifact\.url/);
    assert.equal('url' in result.resource.relatedArtifact[0], false);
  });

  it('reports R4B identity values that trip R5 warning invariants', function () {
    const source = {
      ...compatibleLibrary,
      name: 'A',
      url: 'http://example.org/fhir/Library/example|1',
    };
    const result = singleHopConverter.convert(source, 'R4B', 'R5');
    const text = result.postprocessors[0].messages.map(message => message.text).join('\n');

    assert.equal(result.resource.name, source.name);
    assert.equal(result.resource.url, source.url);
    assert.match(text, /R5 warning invariant cnl-0.*R4B permits this name/);
    assert.match(text, /R5 warning invariant cnl-1.*R4B does not impose this rule/);
  });

  it('reports R5-only root and nested losses using R4B in the diagnostic', function () {
    const source = {
      ...compatibleLibrary,
      content: [{ contentType: 'video/mp4', size: '10', duration: 2.5, frames: 60 }],
      versionAlgorithmString: 'semver',
      copyrightLabel: 'Copyright label',
      dataRequirement: [{
        type: 'Observation',
        valueFilter: [{ path: 'value', comparator: 'eq', valueDateTime: '2026-08-13' }],
      }],
      relatedArtifact: [{
        type: 'documentation',
        classifier: [{ text: 'Guidance' }],
        resourceReference: { reference: 'DocumentReference/1' },
        document: { contentType: 'video/mp4', width: 1280 },
      }],
    };
    const result = singleHopConverter.convert(source, 'R5', 'R4B');
    const text = result.postprocessors[0].messages.map(message => message.text).join('\n');

    assert.equal(result.coverage, COVERAGE.BEST_EFFORT);
    assert.equal(result.postprocessors[0].name, 'Library_R5_to_R4B');
    assert.match(text, /R5-only Library content was dropped because R4B has no equivalent/);
    for (const path of [
      'Library.versionAlgorithm[x]',
      'Library.copyrightLabel',
      'Library.content.duration',
      'Library.content.frames',
      'Library.dataRequirement.valueFilter',
      'Library.relatedArtifact.classifier',
      'Library.relatedArtifact.resourceReference',
      'Library.relatedArtifact.document.width',
    ]) {
      assert.ok(text.includes(path), `missing ${path}`);
    }
    assert.equal('duration' in result.resource.content[0], false);
    assert.equal('valueFilter' in result.resource.dataRequirement[0], false);
    assert.equal('resourceReference' in result.resource.relatedArtifact[0], false);
    assert.deepEqual(result.resource.meta.profile, [
      'http://hl7.org/fhir/4.3/StructureDefinition/Library',
    ]);
  });

  it('uses R4B-specific required resource type policies in both directions', function () {
    const upgradeSource = {
      ...compatibleLibrary,
      parameter: [
        { name: 'device', use: 'in', min: 0, max: '1', type: 'DeviceUseStatement' },
        { name: 'catalog', use: 'in', min: 0, max: '1', type: 'CatalogEntry' },
        {
          name: 'medicinal',
          use: 'in',
          min: 0,
          max: '1',
          type: 'MedicinalProductDefinition',
        },
      ],
      dataRequirement: [
        { type: 'DeviceUseStatement' },
        { type: 'RequestGroup' },
        { type: 'CatalogEntry' },
        { type: 'MedicinalProductDefinition' },
      ],
    };
    const upgrade = singleHopConverter.convert(upgradeSource, 'R4B', 'R5');

    assert.deepEqual(upgrade.resource.parameter.map(entry => entry.type), [
      'DeviceUsage',
      'MedicinalProductDefinition',
    ]);
    assert.deepEqual(upgrade.resource.dataRequirement.map(entry => entry.type), [
      'DeviceUsage',
      'RequestOrchestration',
      'MedicinalProductDefinition',
    ]);

    const downgradeSource = {
      ...compatibleLibrary,
      content: [{ contentType: 'text/plain', size: '10' }],
      parameter: [
        { name: 'device', use: 'in', min: 0, max: '1', type: 'DeviceUsage' },
        { name: 'actor', use: 'in', min: 0, max: '1', type: 'ActorDefinition' },
        {
          name: 'medicinal',
          use: 'in',
          min: 0,
          max: '1',
          type: 'MedicinalProductDefinition',
        },
      ],
      dataRequirement: [
        { type: 'DeviceUsage' },
        { type: 'RequestOrchestration' },
        { type: 'ActorDefinition' },
        { type: 'MedicinalProductDefinition' },
      ],
    };
    const downgrade = singleHopConverter.convert(downgradeSource, 'R5', 'R4B');

    assert.deepEqual(downgrade.resource.parameter.map(entry => entry.type), [
      'DeviceUseStatement',
      'MedicinalProductDefinition',
    ]);
    assert.deepEqual(downgrade.resource.dataRequirement.map(entry => entry.type), [
      'DeviceUseStatement',
      'RequestGroup',
      'MedicinalProductDefinition',
    ]);
    assert.ok(downgrade.postprocessors[0].messages.some(message =>
      /type "ActorDefinition" is defined only in R5 and has no R4B type equivalent/
        .test(message.text)));
  });

  it('uses R4B-specific datatype policies in both directions', function () {
    const r4bOnlyTypes = [
      'Any',
      'MoneyQuantity',
      'Population',
      'ProdCharacteristic',
      'SimpleQuantity',
      'Type',
    ];
    const upgradeSource = {
      ...compatibleLibrary,
      parameter: [
        ...r4bOnlyTypes.map((type, index) => ({
          name: `unsupported-${index}`,
          use: 'in',
          min: 0,
          max: '1',
          type,
        })),
        { name: 'shared', use: 'in', min: 0, max: '1', type: 'string' },
      ],
      dataRequirement: [
        ...r4bOnlyTypes.map(type => ({ type })),
        { type: 'Observation' },
      ],
    };

    const upgrade = singleHopConverter.convert(upgradeSource, 'R4B', 'R5');
    const upgradeText = upgrade.postprocessors[0].messages
      .map(message => message.text)
      .join('\n');

    assert.deepEqual(upgrade.resource.parameter.map(entry => entry.type), ['string']);
    assert.deepEqual(upgrade.resource.dataRequirement.map(entry => entry.type), ['Observation']);
    for (const type of r4bOnlyTypes) {
      assert.match(upgradeText, new RegExp(`required type "${type}".*no R5 type equivalent`));
    }

    const r5OnlyTypes = [
      'Availability',
      'BackboneType',
      'Base',
      'DataType',
      'ExtendedContactDetail',
      'MonetaryComponent',
      'PrimitiveType',
      'VirtualServiceDetail',
    ];
    const downgradeSource = {
      ...compatibleLibrary,
      content: [{ contentType: 'text/plain', size: '10' }],
      parameter: [
        { name: 'wide-integer', use: 'in', min: 0, max: '1', type: 'integer64' },
        ...r5OnlyTypes.map((type, index) => ({
          name: `unsupported-${index}`,
          use: 'in',
          min: 0,
          max: '1',
          type,
        })),
        {
          name: 'codeable-reference',
          use: 'in',
          min: 0,
          max: '1',
          type: 'CodeableReference',
        },
        { name: 'ratio-range', use: 'in', min: 0, max: '1', type: 'RatioRange' },
        { name: 'shared', use: 'in', min: 0, max: '1', type: 'string' },
      ],
    };

    const downgrade = singleHopConverter.convert(downgradeSource, 'R5', 'R4B');
    const downgradeText = downgrade.postprocessors[0].messages
      .map(message => message.text)
      .join('\n');

    // CodeableReference and RatioRange were added in R4B, so they survive the
    // hop; every R5-only type is removed instead of emitting an invalid code.
    assert.deepEqual(downgrade.resource.parameter.map(entry => entry.type), [
      'integer',
      'CodeableReference',
      'RatioRange',
      'string',
    ]);
    assert.match(downgradeText, /type "integer64".*approximated as "integer"/);
    for (const type of r5OnlyTypes) {
      assert.match(downgradeText, new RegExp(`required type "${type}".*no R4B type equivalent`));
    }
  });

  it('drops an R5-only RelatedArtifact relationship code from the R4B target', function () {
    const source = {
      ...compatibleLibrary,
      content: [{ contentType: 'text/plain', size: '10' }],
      relatedArtifact: [
        { type: 'supports', display: 'Supporting artifact' },
        { type: 'citation', display: 'Citation' },
      ],
    };
    const result = singleHopConverter.convert(source, 'R5', 'R4B');

    assert.deepEqual(result.resource.relatedArtifact, [
      { type: 'citation', display: 'Citation' },
    ]);
    assert.ok(result.postprocessors[0].messages.some(message =>
      /R4B does not define the R5 RelatedArtifact.type code "supports"/.test(message.text)));
  });
});
