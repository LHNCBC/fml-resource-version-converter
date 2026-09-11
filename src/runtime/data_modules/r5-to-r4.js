import r5Model from 'fhirpath/fhir-context/r5/index.js';
import mapping from '../../../data/runtime/fml-mappings/R5toR4.js';
import sourceTable from '../../../data/runtime/fhir-tables/R5.js';
import targetTable from '../../../data/runtime/fhir-tables/R4.js';
import {
  assembleRuntimeData,
  createFhirPathModel,
} from '../assembler.js';

export default assembleRuntimeData({
  id: 'runtime/r5-to-r4',
  mappingEnvelopes: [mapping],
  fhirTableEnvelopes: [sourceTable, targetTable],
  fhirPathModels: [createFhirPathModel('fhirpath/r5', ['R5'], r5Model)],
});
