import r4Model from 'fhirpath/fhir-context/r4/index.js';
import mapping from '../../../data/runtime/fml-mappings/R4toR3.js';
import sourceTable from '../../../data/runtime/fhir-tables/R4.js';
import targetTable from '../../../data/runtime/fhir-tables/STU3.js';
import {
  assembleRuntimeData,
  createFhirPathModel,
} from '../assembler.js';

export default assembleRuntimeData({
  id: 'runtime/r4-to-r3',
  mappingEnvelopes: [mapping],
  fhirTableEnvelopes: [sourceTable, targetTable],
  fhirPathModels: [createFhirPathModel('fhirpath/r4', ['R4'], r4Model)],
});
