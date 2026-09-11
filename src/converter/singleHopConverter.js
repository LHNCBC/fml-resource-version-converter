/**
 * @fileoverview Package-default single-hop converter binding.
 *
 * @module converter/singleHopConverter
 */

import { singleHopConverter as defaultSingleHopConverter } from './defaultConverters.js';

/**
 * The package-default adjacent-version converter. `convert(resource, fromVer,
 * toVer, options)` returns a flat result containing the converted resource,
 * coverage, status, and processor/FML reports.
 *
 * @type {{convert: Function}}
 */
export const singleHopConverter = defaultSingleHopConverter;
