import stu3Model from 'fhirpath/fhir-context/stu3/index.js';
import mapping from '../../../data/runtime/fml-mappings/R3toR4.js';
import sourceTable from '../../../data/runtime/fhir-tables/STU3.js';
import targetTable from '../../../data/runtime/fhir-tables/R4.js';
import {
  assembleRuntimeData,
  createFhirPathModel,
} from '../assembler.js';

export default assembleRuntimeData({
  id: 'runtime/r3-to-r4',
  mappingEnvelopes: [mapping],
  fhirTableEnvelopes: [sourceTable, targetTable],
  fhirPathModels: [createFhirPathModel('fhirpath/stu3', ['R3'], stu3Model)],
});
