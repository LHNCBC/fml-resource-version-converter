# Conversion Ambiguity Report

In this package, a conversion starts by selecting a mapping file from the
bundled HL7 FML fhir-cross-version mapping files based on the source resource
type and the from-to version pair. In some cases, however, there are inherent ambiguities in
making such selections without deep clinical knowledge, which this converter
does not have.

This report lists all the known ambiguities in the current version of the
FML mappings. There are two types of ambiguities, and a specific conversion
may exhibit both.

- **Type A: 1-to-N source-target selection**
A source resource type may be mapped to more than one target resource type;
see the details below.

- **Type B: Multiple mapping files for a given source-target pair**
There is more than one mapping file to choose from for the same source-target resource
type pair; see the details below.

### ServiceRequest, R4 -> R3 (Type A)
- **Step 1 (Type A):** the target type cannot be uniquely identified -- the
  source may be mapped to either ProcedureRequest or ReferralRequest.
- **Step 2:** once the target type is explicitly specified, exactly one mapping
  file applies -- ServiceRequestPR.fml for ProcedureRequest and
  ServiceRequestRR.fml for ReferralRequest -- so there is no further ambiguity.

### ProcedureRequest, R3 -> R2 (Types A and B)
- **Step 1 (Type A):** the target type cannot be uniquely identified -- the
  source may be mapped to either DiagnosticOrder or ProcedureRequest.
- **Step 2 (Type B):** if the target type DiagnosticOrder is explicitly
  specified, the choice between the two mapping files DiagnosticOrder.fml and
  ProcedureRequestDO.fml remains ambiguous.
  - If ProcedureRequest is specified as the target type instead,
    ProcedureRequest.fml is the only candidate and there is no further
    ambiguity.

## Resolution

**Type A is handled for the main resource** with the `targetResourceType` option
or the `--target-resource-type` command-line argument. Specify a target when
there is ambiguity; the converter validates it against the bundled mappings.
Contained resources and Bundle entries are not yet converted recursively. Their
target-selection needs will be addressed when that support is added.

**Type B is deferred** until there is a demonstrated need. Resolving it would
require a further selector naming a specific mapping file, which would become
permanent public API surface. That is not justified at present:

- **It occurs exactly once.** Across all eight mapping directions, the only
  Type B collision is ProcedureRequest R3 -> R2 targeting DiagnosticOrder.
  Every other direction is free of it.
- **It occurs only on a legacy hop.** R2 has long been discontinued and R3 is
  nearing the end of its support. R2 -> R3 (migrating older data forward) may
  still be of some significance and is free of any ambiguity, whereas
  practical significance of R3 -> R2 is less certain.
- **The two mapping files are not redundant**, so consolidating them is not an
  option. They are distinct HL7 artifacts, and ProcedureRequestDO.fml itself
  notes that telling the two target types apart "requires special knowledge",
  which is precisely the clinical knowledge this converter does not have.
- **The current behavior is safe.** The conversion fails closed with an error
  naming both candidate mapping files; it never silently returns a result
  produced by an arbitrarily chosen mapping file.

If a future refresh of the HL7 mapping files introduces a Type B collision on
an actively supported version pair, or if this specific case of R3 -> R2
conversion can be justified, this decision should be revisited.
