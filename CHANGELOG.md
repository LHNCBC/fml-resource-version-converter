# Change Log

This log documents the significant changes for each release.
This project follows [Semantic Versioning](http://semver.org/).

## [1.2.0] - 2026-06-05
### Added
- FHIR resource version conversion engine that executes the HL7 fhir-cross-version
  mapping files to convert/map FHIR resources between versions. This has not been
  integrated into the Questionniare version converter itself yet. See README.md for details.
- Other minor updates and refactorings.

### Changed
- Added options to enable (default) or disable conversion history tagging.
- Added inter-version extension (and recovery) between R4 and R5

## [1.1.0] - 2025-08-07
### Changed
- Added options to enable (default) or disable conversion history tagging.
- Added inter-version extension (and recovery) between R4 and R5

## [1.0.2] - 2025-04-10
### Changed
- Added homepage and repository to the package.json

## [1.0.1] - 2025-03-12
### Changed
- Updated license in package.json

## [1.0.0] - 2025-02-10
### New
- First version with a library and a command line interface
