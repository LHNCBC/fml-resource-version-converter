
// Util functions for use in the command line tool or in the mocha tests.

import * as path from "path";

export {
  newPathFrom
}


/**
 * Create a new file path based on a given file path.
 * Whether the created file path is absolute or relative depends on if the newDir (if specified) or
 * the srcFilePath, is absolute or not.
 * If neither newDir nor suffix is provided, the same path will be returned.
 * @param srcFilePath the file path to be based on, required
 * @param newDir the directory for the newly created file (path), optional, default to the input file's directory.
 * @param suffix an suffix to be added to the end (but before the extension, if any) of the file base name
 * @param ext an optional file name extension, only used to decide where the suffix should be added.
 */
function newPathFrom(srcFilePath, newDir, suffix, ext) {
  newDir = newDir || path.dirname(srcFilePath);
  return path.join(newDir, path.basename(srcFilePath, ext || '') + (suffix || '') + (ext || ''));
}


