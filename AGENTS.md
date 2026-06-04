# Agent Guidelines

## Workflow
- Questions: Answer, but do NOT make changes until ordered.
- Tasks: Propose a plan, wait for approval, then execute.
- Edits: Use editor tools (not terminal sed/awk). Wait for my approval after each file edit before proceeding.
- After edits: Run tests; stop and report if they fail.
- New files: Propose before creating.
- Destructive actions: Always ask before deleting or renaming files.
- Context: Read relevant files before editing; don't guess.

## Code Style
- Add JSDoc to functions
- Blank lines between functions/blocks
- ASCII only (especially comments)
- Human-readability is a priority

## Testing
- Code must pass tests
- Never skip tests to hide failures

## Boundaries
- Stay within this project directory

## Special Notes
- The FML framework code (under src/fml_base_conv) should execute the FML
  transformations faithfully, and that it does not need to, and should not
  implement the special business logic that the converters outside of this
  framework, e.g., the legacy converter.
- When using tools/compare-converters.js and test/data/test/data/qn-ver-conv-test* files
  for testing/comparision, report such special business logics from the legacy but do
  not consider these as bugs of the FML framework code.
