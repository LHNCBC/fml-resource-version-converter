/**
 * Tests for reviewed Library conversion between R3 and R4.
 */
import { strict as assert } from 'node:assert';
import { COVERAGE } from '../../../../src/converter/coverage.js';
import { MESSAGE_TYPE, STATUS } from '../../../../src/converter/diagnostics.js';
import { singleHopConverter } from '../../../../src/converter/singleHopConverter.js';

/**
 * Build a minimal Library valid in both versions.
 *
 * @returns {Object} Fresh Library fixture.
 */
function makeLibrary() {
  return {
    resourceType: 'Library',
    id: 'library-example',
    url: 'http://example.org/fhir/Library/example',
    name: 'ExampleLibrary',
    status: 'active',
    type: { text: 'Logic library' },
  };
}

describe('postprocessors/R3_R4 Library', function () {
  describe('R3 -> R4 through singleHopConverter.convert', function () {
    it('registers known FML gaps and best-effort final coverage', function () {
      const result = singleHopConverter.convert(makeLibrary(), 'R3', 'R4');

      assert.equal(result.coverage, COVERAGE.BEST_EFFORT);
      assert.equal(result.fml_base_conv.coverage, COVERAGE.KNOWN_GAPS);
      assert.equal(result.postprocessors.length, 1);
      assert.equal(result.postprocessors[0].name, 'Library_R3_to_R4');
      assert.equal(result.postprocessors[0].coverage, COVERAGE.BEST_EFFORT);
    });

    it('rebuilds contributor buckets without the malformed inter-version extension', function () {
      const source = makeLibrary();
      source.contributor = [
        {
          id: 'author-id',
          extension: [{ url: 'http://example.org/contributor-note', valueString: 'lead' }],
          type: 'author',
          name: 'Alice Author',
          _name: { id: 'author-name-id' },
          contact: [
            { telecom: [{ system: 'email', value: 'alice@example.org' }] },
            { telecom: [{ system: 'phone', value: '555-0100' }] },
          ],
        },
        { type: 'reviewer', name: 'Rita Reviewer' },
      ];

      const result = singleHopConverter.convert(source, 'R3', 'R4');

      assert.equal(result.status, STATUS.OK);
      assert.deepEqual(result.resource.author, [{
        id: 'author-id',
        extension: [{ url: 'http://example.org/contributor-note', valueString: 'lead' }],
        name: 'Alice Author',
        _name: { id: 'author-name-id' },
        telecom: [
          { system: 'email', value: 'alice@example.org' },
          { system: 'phone', value: '555-0100' },
        ],
      }]);
      assert.deepEqual(result.resource.reviewer, [{ name: 'Rita Reviewer' }]);
      assert.equal('contributor' in result.resource, false);
      assert.equal(
        result.resource.author[0].extension.some(extension =>
          extension.url.includes('extension-Contributor.name')),
        false,
      );
    });

    it('reports invalid contributors that cannot be assigned to an R4 bucket', function () {
      const source = makeLibrary();
      source.contributor = [
        { type: 'author', name: 'Alice Author' },
        { type: 'sponsor', name: 'Invalid type' },
        { name: 'Missing type' },
      ];

      const result = singleHopConverter.convert(source, 'R3', 'R4');
      const warnings = result.postprocessors[0].messages.filter(message =>
        message.type === MESSAGE_TYPE.WARNING);

      assert.equal(result.status, STATUS.WARNING);
      assert.deepEqual(result.resource.author, [{ name: 'Alice Author' }]);
      assert.equal(warnings.length, 2);
      assert.match(warnings[0].text, /contributor\[1\].*type "sponsor" is not one of/);
      assert.match(warnings[1].text, /contributor\[2\].*required R3 type code is absent/);
    });

    it('updates the LibraryType code-system canonical while preserving other codings',
      function () {
        const source = makeLibrary();
        source.type = {
          coding: [
            {
              system: 'http://hl7.org/fhir/library-type',
              _system: { id: 'library-system-id' },
              code: 'logic-library',
            },
            { system: 'http://example.org/library-type', code: 'custom' },
          ],
        };

        const result = singleHopConverter.convert(source, 'R3', 'R4');
        const messages = result.postprocessors[0].messages;

        assert.equal(result.status, STATUS.OK);
        assert.equal(
          result.resource.type.coding[0].system,
          'http://terminology.hl7.org/CodeSystem/library-type',
        );
        assert.deepEqual(result.resource.type.coding[0]._system, { id: 'library-system-id' });
        assert.equal(result.resource.type.coding[1].system, 'http://example.org/library-type');
        assert.equal(messages.length, 1);
        assert.equal(messages[0].type, MESSAGE_TYPE.INFO);
        assert.match(messages[0].text, /LibraryType code system canonical changed/);
      });

    it('repairs Reference-to-canonical fields and preserves display as rendered-value',
      function () {
      const source = makeLibrary();
      source.parameter = [{
        name: 'input',
        use: 'in',
        min: 0,
        max: '1',
        type: 'Observation',
        profile: {
          id: 'profile-id',
          reference: 'StructureDefinition/example',
          display: 'Example profile',
          _display: { id: 'display-id' },
        },
      }];
      source.relatedArtifact = [{
        type: 'documentation',
        resource: {
          reference: 'Library/dependency',
          _reference: {
            extension: [{ url: 'http://example.org/reference-note', valueString: 'local' }],
          },
        },
      }];

      const result = singleHopConverter.convert(source, 'R3', 'R4');

      assert.equal(result.status, STATUS.OK);
      assert.equal(result.resource.parameter[0].profile, 'StructureDefinition/example');
      assert.equal(result.resource.parameter[0]._profile.id, 'profile-id');
      assert.deepEqual(result.resource.parameter[0]._profile.extension, [{
        url: 'http://hl7.org/fhir/StructureDefinition/rendered-value',
        valueString: 'Example profile',
        _valueString: { id: 'display-id' },
      }]);
      assert.equal(result.resource.relatedArtifact[0].resource, 'Library/dependency');
      assert.deepEqual(result.resource.relatedArtifact[0]._resource.extension, [{
        url: 'http://example.org/reference-note',
        valueString: 'local',
      }]);
    });

    it('normalizes required resource types and drops unrepresentable entries', function () {
      const source = makeLibrary();
      source.parameter = [
        { name: 'body', use: 'in', min: 0, max: '1', type: 'BodySite' },
        { name: 'legacy', use: 'in', min: 0, max: '1', type: 'DataElement' },
        { name: 'shared', use: 'in', min: 0, max: '1', type: 'Observation' },
      ];
      source.dataRequirement = [
        { type: 'ProcedureRequest' },
        { type: 'ProcessRequest' },
      ];

      const result = singleHopConverter.convert(source, 'R3', 'R4');
      const text = result.postprocessors[0].messages.map(message => message.text).join('\n');

      assert.equal(result.status, STATUS.WARNING);
      assert.deepEqual(result.resource.parameter.map(entry => entry.type), [
        'BodyStructure',
        'Observation',
      ]);
      assert.deepEqual(
        result.resource.dataRequirement.map(entry => entry.type),
        ['ServiceRequest'],
      );
      assert.match(text, /parameter\[0\]\.type was renamed from "BodySite" to "BodyStructure"/);
      assert.match(text, /parameter\[1\].*"DataElement".*no R4 type equivalent/);
      assert.match(text, /dataRequirement\[0\]\.type was renamed.*"ServiceRequest"/);
      assert.match(text, /dataRequirement\[1\].*"ProcessRequest".*no R4 type equivalent/);
    });

    it('reports CodeableConcept detail lost while retaining every Coding', function () {
      const source = makeLibrary();
      source.dataRequirement = [{
        type: 'Observation',
        codeFilter: [{
          path: 'code',
          valueCodeableConcept: [{
            id: 'concept-id',
            text: 'Both codes',
            coding: [
              { system: 'http://example.org/codes', code: 'a' },
              { system: 'http://example.org/codes', code: 'b' },
            ],
          }],
        }],
      }];

      const result = singleHopConverter.convert(source, 'R3', 'R4');
      const warning = result.postprocessors[0].messages.find(message =>
        message.text.includes('valueCodeableConcept[0]'));

      assert.equal(result.status, STATUS.WARNING);
      assert.equal(warning.type, MESSAGE_TYPE.WARNING);
      assert.deepEqual(result.resource.dataRequirement[0].codeFilter[0].code, [
        { system: 'http://example.org/codes', code: 'a' },
        { system: 'http://example.org/codes', code: 'b' },
      ]);
    });

    it('reports R4 warning invariant lib-0 without mutating name', function () {
      const source = makeLibrary();
      source.name = 'not-valid';

      const result = singleHopConverter.convert(source, 'R3', 'R4');

      assert.equal(result.status, STATUS.WARNING);
      assert.equal(result.resource.name, 'not-valid');
      assert.match(result.postprocessors[0].messages[0].text, /warning invariant lib-0/);
    });
  });

  describe('R4 -> R3 through singleHopConverter.convert', function () {
    it('removes Reference-valued UsageContext while preserving supported siblings', function () {
      const source = makeLibrary();
      source.useContext = [{
        code: { system: 'http://example.org/context', code: 'age' },
        valueCodeableConcept: { text: 'Adults' },
      }, {
        code: { system: 'http://example.org/context', code: 'focus' },
        valueReference: { reference: 'PlanDefinition/example' },
      }];

      const result = singleHopConverter.convert(source, 'R4', 'R3');

      assert.equal(result.status, STATUS.WARNING);
      assert.equal(result.resource.useContext.length, 1);
      assert.equal(result.resource.useContext[0].valueCodeableConcept.text, 'Adults');
      assert.ok(result.postprocessors[0].messages.some(message =>
        message.type === MESSAGE_TYPE.WARNING
        && /Library\.useContext\[1\]\.valueReference/.test(message.text)));
    });

    it('rebuilds valid contributors and marks an absent required name', function () {
      const source = makeLibrary();
      source.author = [{
        id: 'author-id',
        extension: [{ url: 'http://example.org/note', valueString: 'lead' }],
        name: 'Alice Author',
        _name: { id: 'name-id' },
        telecom: [{ system: 'email', value: 'alice@example.org' }],
      }];
      source.editor = [{ telecom: [{ system: 'phone', value: '555-0101' }] }];

      const result = singleHopConverter.convert(source, 'R4', 'R3');
      const [author, editor] = result.resource.contributor;

      assert.equal(result.status, STATUS.WARNING);
      assert.deepEqual(author, {
        type: 'author',
        id: 'author-id',
        extension: [{ url: 'http://example.org/note', valueString: 'lead' }],
        name: 'Alice Author',
        _name: { id: 'name-id' },
        contact: [{ telecom: [{ system: 'email', value: 'alice@example.org' }] }],
      });
      assert.equal(editor.type, 'editor');
      assert.deepEqual(editor.contact, [{
        telecom: [{ system: 'phone', value: '555-0101' }],
      }]);
      assert.deepEqual(editor._name.extension, [{
        url: 'http://hl7.org/fhir/StructureDefinition/data-absent-reason',
        valueCode: 'unknown',
      }]);
      assert.match(result.postprocessors[0].messages[0].text, /Contributor\.name is required/);
    });

    it('restores the R3 LibraryType code-system canonical', function () {
      const source = makeLibrary();
      source.type = {
        coding: [{
          system: 'http://terminology.hl7.org/CodeSystem/library-type',
          _system: { id: 'library-system-id' },
          code: 'logic-library',
        }],
      };

      const result = singleHopConverter.convert(source, 'R4', 'R3');

      assert.equal(result.status, STATUS.OK);
      assert.equal(result.resource.type.coding[0].system, 'http://hl7.org/fhir/library-type');
      assert.deepEqual(result.resource.type.coding[0]._system, { id: 'library-system-id' });
      assert.equal(result.postprocessors[0].messages.length, 1);
      assert.equal(result.postprocessors[0].messages[0].type, MESSAGE_TYPE.INFO);
      assert.match(
        result.postprocessors[0].messages[0].text,
        /LibraryType code system canonical changed between R4 and R3/,
      );
    });

    it('repairs canonical-to-Reference fields and removes canonical version pins', function () {
      const source = makeLibrary();
      source.parameter = [{
        name: 'input',
        use: 'in',
        min: 0,
        max: '1',
        type: 'Observation',
        profile: 'http://example.org/StructureDefinition/input|2.0#part',
        _profile: {
          id: 'profile-id',
          extension: [{ url: 'http://example.org/profile-note', valueString: 'note' }],
        },
      }];
      source.relatedArtifact = [{
        type: 'documentation',
        resource: 'http://example.org/Library/dependency|1.0',
        _resource: { id: 'resource-id' },
      }];

      const result = singleHopConverter.convert(source, 'R4', 'R3');

      assert.deepEqual(result.resource.parameter[0].profile, {
        reference: 'http://example.org/StructureDefinition/input#part',
        id: 'profile-id',
        extension: [{ url: 'http://example.org/profile-note', valueString: 'note' }],
      });
      assert.deepEqual(result.resource.relatedArtifact[0].resource, {
        reference: 'http://example.org/Library/dependency',
        id: 'resource-id',
      });
      const text = result.postprocessors[0].messages.map(message => message.text).join('\n');
      assert.match(text, /parameter\[0\]\.profile.*version was dropped/);
      assert.match(text, /relatedArtifact\[0\]\.resource.*version was dropped/);
    });

    it('repairs DataRequirement choices and required paths while reporting R4-only fields',
      function () {
      const source = makeLibrary();
      source.subtitle = 'R4 subtitle';
      source.subjectReference = { reference: 'Patient/example' };
      source.relatedArtifact = [{ type: 'documentation', label: 'Guide' }];
      source.dataRequirement = [{
        type: 'Observation',
        profile: ['http://example.org/StructureDefinition/observation|3.0#slice'],
        _profile: [{ id: 'profile-array-id' }],
        subjectCodeableConcept: { text: 'Adults' },
        limit: 10,
        sort: [{ path: 'date', direction: 'descending' }],
        codeFilter: [{
          searchParam: 'code',
          valueSet: 'http://example.org/ValueSet/codes|1.0',
          _valueSet: { id: 'value-set-id' },
          code: [
            { id: 'coding-a', system: 'http://example.org/codes', code: 'a' },
            { id: 'coding-b', code: 'b' },
          ],
        }],
        dateFilter: [{ searchParam: 'date', valueDateTime: '2026-08-14' }],
      }];

      const result = singleHopConverter.convert(source, 'R4', 'R3');
      const requirement = result.resource.dataRequirement[0];
      const codeFilter = requirement.codeFilter[0];
      const dateFilter = requirement.dateFilter[0];
      const text = result.postprocessors[0].messages.map(message => message.text).join('\n');

      assert.equal(result.status, STATUS.WARNING);
      assert.deepEqual(requirement.profile, [
        'http://example.org/StructureDefinition/observation#slice',
      ]);
      assert.deepEqual(requirement._profile, [{ id: 'profile-array-id' }]);
      assert.equal(codeFilter.valueSetString, 'http://example.org/ValueSet/codes');
      assert.deepEqual(codeFilter._valueSetString, { id: 'value-set-id' });
      assert.deepEqual(codeFilter.valueCoding, source.dataRequirement[0].codeFilter[0].code);
      assert.equal('valueCode' in codeFilter, false);
      assert.equal(codeFilter._path.extension[0].valueCode, 'unknown');
      assert.equal(dateFilter._path.extension[0].valueCode, 'unknown');
      for (const path of [
        'Library.subtitle',
        'Library.subject[x]',
        'Library.dataRequirement.subject[x]',
        'Library.dataRequirement.limit',
        'Library.dataRequirement.sort',
        'Library.dataRequirement.codeFilter.searchParam',
        'Library.dataRequirement.dateFilter.searchParam',
        'Library.relatedArtifact.label',
      ]) {
        assert.match(text, new RegExp(path.replaceAll('.', '\\.').replace('[x]', '\\[x\\]')));
      }
    });

    it('approximates or removes every R4-only datatype in required type bindings', function () {
      const source = makeLibrary();
      const unsupported = [
        'Expression',
        'MarketingStatus',
        'MoneyQuantity',
        'Population',
        'ProdCharacteristic',
        'ProductShelfLife',
        'SubstanceAmount',
      ];
      source.parameter = [
        {
          name: 'canonical-input',
          use: 'in',
          min: 0,
          max: '1',
          type: 'canonical',
          _type: { id: 'canonical-type-id' },
        },
        { name: 'url-input', use: 'in', min: 0, max: '1', type: 'url' },
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
        { type: 'canonical' },
        { type: 'url' },
        { type: 'Expression' },
        { type: 'Observation' },
      ];

      const result = singleHopConverter.convert(source, 'R4', 'R3');
      const text = result.postprocessors[0].messages.map(message => message.text).join('\n');

      assert.deepEqual(result.resource.parameter.map(entry => entry.type), [
        'uri',
        'uri',
        'string',
      ]);
      assert.deepEqual(result.resource.parameter[0]._type, { id: 'canonical-type-id' });
      assert.deepEqual(result.resource.dataRequirement.map(entry => entry.type), [
        'uri',
        'uri',
        'Observation',
      ]);
      assert.match(text, /parameter\[0\]\.type "canonical".*approximated as "uri"/);
      assert.match(text, /parameter\[1\]\.type "url".*approximated as "uri"/);
      for (const type of unsupported) {
        assert.match(text, new RegExp(`required type "${type}".*no R3 type equivalent`));
      }
      assert.match(text, /dataRequirement\[2\].*"Expression".*no R3 type equivalent/);
    });

    it('handles exact, unsupported, and ambiguous required resource types', function () {
      const source = makeLibrary();
      source.parameter = [
        { name: 'body', use: 'in', min: 0, max: '1', type: 'BodyStructure' },
        { name: 'catalog', use: 'in', min: 0, max: '1', type: 'CatalogEntry' },
        { name: 'request', use: 'in', min: 0, max: '1', type: 'ServiceRequest' },
        { name: 'shared', use: 'in', min: 0, max: '1', type: 'Observation' },
      ];

      const result = singleHopConverter.convert(source, 'R4', 'R3');
      const text = result.postprocessors[0].messages.map(message => message.text).join('\n');

      assert.deepEqual(result.resource.parameter.map(entry => entry.type), [
        'BodySite',
        'Observation',
      ]);
      assert.match(text, /parameter\[0\]\.type was renamed from "BodyStructure" to "BodySite"/);
      assert.match(text, /parameter\[1\].*"CatalogEntry".*no R3 type equivalent/);
      assert.match(text, /parameter\[2\].*"ServiceRequest".*maps ambiguously/);
    });
  });
});
