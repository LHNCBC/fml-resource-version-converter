# Agent Guidelines

## Commands
Run from the project root (Node >= 20.11.0):

```bash
npm test                            # run the full mocha suite
node bin/convert.js R4 R5 in.json   # CLI conversion, result to stdout

npm run build:coverage       # maintainer: regenerate COVERAGE.md (do not edit it by hand)
npm run check:package        # maintainer: validate package contents; report size
npm run install:test-browser # maintainer: one-time Chromium install for the harness below
npm run test:installed-package
                             # maintainer: smoke-test the packed package
node tools/check-data.js     # maintainer: check bundled cross-version data; report ambiguities
```

Maintainer data commands - `download:fhir-specs`, `build:runtime-data`,
`copy:runtime-data`, `check:runtime-data-integrity`, and
`check:runtime-data-freshness` - are documented in `DATA-MAINTENANCE.md`.

## General
- The .scratch/ directory is a work area for use to communicate between the
  developer and the AI.
  - It's git-ignored and is not going into the build.
  - .scratch/AI/: this is your scratch area, put your stuff here.
  - For FHIR specification investigation, extract only the needed ZIP entries
    into .scratch/AI/ and reuse them; do not repeatedly unzip the archives.
  - .scratch/human/: this is my area. You can read from here, but
    DO NOT write/update anything there unless explicitly asked.
- DO NOT show your own probe/scratch files in the "files changed" list unless
  explicitly asked.
- Check my instructions before execution to see if they make sense.
- If, at any point, you feel that my instructions are off, please
  pause and confirm with me first.
- When you completed your response, please so indicate, e.g.,
  "Completed" with a green checkmark or similar.

## Workflow
- Questions: If I'm asking you a question, answer that question but do NOT make
  changes until explicitly instructed.
- Tasks: If I'm asking you to propose a plan, just respond with a proposal,
  do NOT execute without explicit approval.
- If I said 'go ahead and do ...', then you may execute the task and don't ask
  for approval unless you see a reason to do so.
- Edits: Use IDE editor tools (not from terminal) whenever
  possible to avoid causing content out of sync.
  Always prompt for my approval (keep/decline) for each change.
- After edits: run tests; stop and report if they fail.
- New files: Propose before creating.
- Destructive actions: Always ask before deleting or renaming files.
- Context: Read relevant files before editing; don't guess.
- Do NOT stage changes unless explicitly asked to do so.

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
- The FML engine code (under src/fml_base_conv) should execute the FML
  transformations faithfully, and that it does not need to, and should not,
  implement any business logic or fixes that are specific to some resource
  type(s). In other words, the engine should be absolutely pure.
