# Agent Guidelines

## Commands
Run from the project root (Node >= 20.11.0):

```bash
npm test                            # run the full mocha suite
node bin/convert.js R4 R5 in.json   # CLI conversion, result to stdout

npm run build:coverage       # maintainer: regenerate COVERAGE.md (do not edit it by hand)
npm run download:fhir-specs  # maintainer: download/verify declared FHIR spec zips
npm run build:runtime-data -- fml-mappings --runtime-data-root DIR
                             # maintainer: build one runtime-data component
npm run build:runtime-data:all -- --runtime-data-root DIR
                             # maintainer: build both runtime-data components
npm run migrate:runtime-data -- fml-mappings --from-runtime-data-root DIR --to-runtime-data-root DIR
                             # maintainer: copy one generated component
npm run check:runtime-data -- --runtime-data-root DIR --complete
                             # maintainer: validate a complete runtime-data root
npm run check:runtime-data-sources
                             # maintainer: rebuild in temp and compare sources
npm run check:package         # maintainer: validate package contents and size
npm run test:installed-package
                             # maintainer: smoke-test the packed package
node tools/check-data.js     # maintainer: check bundled cross-version data; report ambiguities
```

## General
- The .scratch/ directory is a work area for use to communicate between the
  developer and the AI.
  - It's git-ignored and is not going into the build.
  - .scratch/AI/: this is your scratch area, put your stuff here.
  - For FHIR specification investigation, extract only the needed ZIP entries
    into .scratch/AI/ and reuse them; do not repeatedly unzip the archives.
  - .scratch/human/: this is my area. You can read from here, but
    DO NOT write/update anything there unless explicitly asked to.

- Check my instructions before execution to see if they make sense.
- If, at any point, you feel that my instructions are off, please
  pause and confirm with me first.
- When you completed your response, please so indicate, e.g.,
  "Completed" with a green checkmark or similar.

## Workflow
- Questions: Answer, but do NOT make changes until instructed.
- Tasks: Propose a plan, wait for approval, and then execute.
- Edits: Use IDE editor tools (not from terminal) whenever
  possible to avoid causing content out of sync.
  Always prompt for my approval (keep/decline) for each change.
- After edits: run tests; stop and report if they fail.
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
- The FML engine code (under src/fml_base_conv) should execute the FML
  transformations faithfully, and that it does not need to, and should not,
  implement any business logic or fixes that are specific to some resource
  type(s). In other words, the engine should be absolutely pure.
