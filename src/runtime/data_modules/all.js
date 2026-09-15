import r2ToR3 from './r2-to-r3.js';
import r3ToR2 from './r3-to-r2.js';
import r3ToR4 from './r3-to-r4.js';
import r4ToR3 from './r4-to-r3.js';
import r4ToR5 from './r4-to-r5.js';
import r5ToR4 from './r5-to-r4.js';
import r4bToR5 from './r4b-to-r5.js';
import r5ToR4b from './r5-to-r4b.js';
import { combineRuntimeData } from '../assembler.js';

export default combineRuntimeData('runtime/all', [
  r2ToR3,
  r3ToR2,
  r3ToR4,
  r4ToR3,
  r4ToR5,
  r5ToR4,
  r4bToR5,
  r5ToR4b,
]);
