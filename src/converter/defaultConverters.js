/**
 * @fileoverview Package-default converters bound to complete runtime data.
 *
 * This is the single default composition point. All public conversion and
 * registry entry points below share one engine factory and registry created
 * from the committed all-directions runtime module.
 *
 * @module converter/defaultConverters
 */

import runtimeAll from '../runtime/data_modules/all.js';
import { converterFactory } from './converterFactory.js';

const bindings = converterFactory.create(runtimeAll);

/** Package-default adjacent-hop converter. */
export const { singleHopConverter } = bindings;

/** Package-default multi-hop converter. */
export const { chainedConverter } = bindings;

/** Package-default registry reader. */
export const { getRegistryEntry } = bindings;
