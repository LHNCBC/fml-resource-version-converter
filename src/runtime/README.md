# Runtime Data Contracts

This directory contains browser-safe runtime assembly code. Generated artifact
modules under `data/runtime/` are dependency-free data modules: they export an
artifact envelope and do not import a decoder or another project file. Assembly
modules decode and validate those envelopes synchronously.

`schema.js` is the executable authority for the runtime-data formats:

- artifact envelope schema version 1;
- manifest schema version 2, with independent FML and FHIR component sections;
- FML mappings payload schema version 1;
- FHIR table payload schema version 1;
- assembled runtime data schema version 1.

The artifact SHA-256 value covers the UTF-8 bytes of the canonical uncompressed
JSON returned by `canonicalStringify()`. Object keys are sorted recursively;
array order is retained. Payloads use deterministic zlib-wrapped DEFLATE level 9 from
`fflate` and canonical padded Base64. Maintainer generation, alternate-root
loading, and package validation verify the SHA-256 value and canonical form.
The package-owned runtime path trusts those publication checks and avoids
repeating the hash and canonical serialization during application startup. It
still validates the envelope, codec, decoded length, JSON, and payload schema.
The runtime decoder uses no `Buffer`, Node built-ins, or asynchronous
initialization.

The manifest is a maintainer index with independently owned `fmlMappings` and
`fhirTables` sections. Browser runtime modules do not import it.
Artifact envelopes carry the identity, hash, source identities, codec, and
uncompressed length needed for runtime assembly and strict maintainer
validation.

## Artifact regression thresholds

The committed 13-artifact set should remain below 1.1 MB of Base64 payload and
15% of its canonical uncompressed size. A representative R4-to-R5 selection
(the mapping plus R4 and R5 tables) should have a median full initialization
time below 150 ms on the project's Node 20-or-newer maintainer baseline. Full
initialization includes Base64 decoding, decompression, JSON parsing, and
schema validation. These deliberately loose limits catch
substantial regressions without treating local timing noise as a failure.

## Engine factory compatibility

The public `./fml-engine` subpath retains working zero-argument
`createFmlEngineFactory()` construction using the complete committed runtime
data. Runtime options and `xverInputRoot` are not supported.

Alternate runtime roots are trusted maintainer inputs. Their dependency-free
artifact modules are loaded by the Node-only
`tools/runtime-data-root.js` loader, then passed through strict hash,
canonical-form, and schema validation. The loader also requires
a canonical manifest, the complete 13-artifact set, exact manifest-to-envelope
metadata and counts, and the expected direction and table identities. Loading
executes JavaScript from the selected root, so callers must not load untrusted
roots. Once its asynchronous module loading completes, converter construction
and conversion remain synchronous.
