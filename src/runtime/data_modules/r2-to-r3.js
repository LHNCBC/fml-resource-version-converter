import dstu2Model from 'fhirpath/fhir-context/dstu2/index.js';
import mapping from '../../../data/runtime/fml-mappings/R2toR3.js';
import sourceTable from '../../../data/runtime/fhir-tables/DSTU2.js';
import targetTable from '../../../data/runtime/fhir-tables/STU3.js';
import {
  assembleRuntimeData,
  createFhirPathModel,
} from '../assembler.js';

export default assembleRuntimeData({
  id: 'runtime/r2-to-r3',
  mappingEnvelopes: [mapping],
  fhirTableEnvelopes: [sourceTable, targetTable],
  fhirPathModels: [createFhirPathModel('fhirpath/dstu2', ['R2'], dstu2Model)],
});
