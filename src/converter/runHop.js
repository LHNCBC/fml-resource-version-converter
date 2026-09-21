/**
 * @fileoverview Default-context binding for the shared per-hop converter.
 *
 * @module converter/runHop
 */

import { createRunHop } from './boundConverters.js';
import { converterContext } from './converterContext.js';

/**
 * The package-default hop runner. It mutates the supplied working resource and
 * returns `{ resource, fragment, hopCoverage, status }`; public converters clone
 * caller input before invoking it.
 *
 * @type {Function}
 */
export const runHop = createRunHop(converterContext);
