# post_processors/

Post-processors that refine the FML engine output where the FML mapping files
are incomplete. They are organized by version pair and resource type.

See `next-step.txt` ("The post-processor contract", "The registry", and "The
proposed source directory structure") for the authoritative design.

## Layout

```
post_processors/
   <V1>_<V2>/                       # one directory per version pair (both directions)
      registry_<V1>_to_<V2>.js      # registry for the V1 -> V2 direction
      registry_<V2>_to_<V1>.js      # registry for the V2 -> V1 direction
      <ResourceType>.js             # both directions for a resource type
                                    #   exports: conv_<V1>_to_<V2>, conv_<V2>_to_<V1>
      TrivialProcessors.js          # optional: trivial cases grouped in one file
                                    #   export pattern: <ResourceType>_<V1>_to_<V2>
```

Notes:
- `<V1>_<V2>` uses concrete FHIR versions, e.g. `R4_R5/`.
- The `_to_` direction marker is used in the registry file names.
- A registry maps every resource type for that direction to a registry entry.
  Resource types not yet reviewed need no explicit entry; a lookup miss yields a
  functional default of `{ fml_coverage: 'not_reviewed', processor: none }`.

## Status

Scaffolding only. Concrete registries and resource-type processors are added
incrementally (Phase 5 onward).


