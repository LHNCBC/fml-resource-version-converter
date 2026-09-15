/**
 * @fileoverview Package-default multi-hop converter binding.
 *
 * @module converter/chainedConverter
 */

import { chainedConverter as defaultChainedConverter } from './defaultConverters.js';

/**
 * The package-default multi-hop converter. `convert(resource, fromVer, toVer,
 * options)` plans adjacent hops and returns the final resource plus ordered hop
 * reports, rolled-up coverage, and status.
 *
 * @type {{convert: Function}}
 */
export const chainedConverter = defaultChainedConverter;
