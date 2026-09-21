import r4Model from 'fhirpath/fhir-context/r4/index.js';
import mapping from '../../../data/runtime/fml-mappings/R4BtoR5.js';
import sourceTable from '../../../data/runtime/fhir-tables/R4B.js';
import targetTable from '../../../data/runtime/fhir-tables/R5.js';
import {
  assembleRuntimeData,
  createFhirPathModel,
} from '../assembler.js';

export default assembleRuntimeData({
  id: 'runtime/r4b-to-r5',
  mappingEnvelopes: [mapping],
  fhirTableEnvelopes: [sourceTable, targetTable],
  fhirPathModels: [createFhirPathModel('fhirpath/r4', ['R4B'], r4Model)],
});
