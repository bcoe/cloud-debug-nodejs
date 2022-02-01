"use strict";
// Copyright 2015 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
Object.defineProperty(exports, "__esModule", { value: true });
exports.scan = void 0;
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
// TODO: Make this more precise.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const findit = require('findit2');
// TODO: Make this more precise.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const split = require('split');
class ScanResultsImpl {
    /**
     * Encapsulates the results of a filesystem scan with methods
     * to easily select scan information or filenames for a
     * specific subset of the files listed in the scan results.
     *
     * @param stats An object that contains filenames
     *  as keys where each key maps to an object containing the
     *  hash and number of lines for the specified file.  This
     *  information is accessed via the `hash` and `lines`
     *  attributes respectively
     * @param hash A hashcode computed from the contents of all the files.
     */
    constructor(stats, errorMap, hash) {
        this.stats = stats;
        this.errorMap = errorMap;
        this.hash = hash;
    }
    errors() {
        return this.errorMap;
    }
    /**
     * Used to get all of the file scan results.
     */
    all() {
        return this.stats;
    }
    /**
     * Used to get the file scan results for only the files
     * whose filenames match the specified regex.
     *
     * @param {regex} regex The regex that tests a filename
     *  to determine if the scan results for that filename
     *  should be included in the returned results.
     */
    selectStats(regex) {
        const obj = {};
        Object.keys(this.stats).forEach(key => {
            if (regex.test(key)) {
                obj[key] = this.stats[key];
            }
        });
        return obj;
    }
    /**
     * Used to get the only the file paths in the scan results
     * where the filenames match the specified regex and are
     * returned with the each relative to the specified base
     * directory.
     *
     * @param {regex} regex The regex that tests a filename to
     *  determine if the scan results for that filename should
     *  be included in the returned results.
     * @param {string} baseDir The absolute path to the directory
     *  from which all of the returned paths should be relative
     *  to.
     */
    selectFiles(regex, baseDir) {
        // ensure the base directory has only a single trailing path separator
        baseDir = path.normalize(baseDir + path.sep);
        return Object.keys(this.stats)
            .filter(file => {
            return file && regex.test(file);
        })
            .map(file => {
            return path.normalize(file).replace(baseDir, '');
        });
    }
}
async function scan(baseDir, regex, precomputedHash) {
    const fileList = await findFiles(baseDir, regex);
    return computeStats(fileList, precomputedHash);
}
exports.scan = scan;
/**
 * This function accept an array of filenames and computes a unique hash-code
 * based on the contents.
 *
 * @param fileList array of filenames
 * @param precomputedHash if available, hashing operations will be omitted
 * during scan
 */
// TODO: Typescript: Fix the docs associated with this function to match the
// call signature
function computeStats(fileList, precomputedHash) {
    // eslint-disable-next-line no-async-promise-executor
    return new Promise(async (resolve) => {
        // return a valid, if fake, result when there are no js files to hash.
        if (fileList.length === 0) {
            resolve(new ScanResultsImpl({}, new Map(), 'EMPTY-no-js-files'));
            return;
        }
        // TODO: Address the case where the array contains `undefined`.
        const hashes = [];
        const statistics = {};
        const errors = new Map();
        for (const filename of fileList) {
            try {
                const fileStats = await statsForFile(filename, !precomputedHash);
                if (!precomputedHash) {
                    hashes.push(fileStats.hash);
                }
                statistics[filename] = fileStats;
            }
            catch (err) {
                errors.set(filename, err);
            }
        }
        let hash;
        if (!precomputedHash) {
            // Sort the hashes to get a deterministic order as the files may
            // not be in the same order each time we scan the disk.
            const buffer = hashes.sort().join();
            const sha1 = crypto.createHash('sha1').update(buffer).digest('hex');
            hash = 'SHA1-' + sha1;
        }
        else {
            hash = precomputedHash;
        }
        resolve(new ScanResultsImpl(statistics, errors, hash));
    });
}
/**
 * Given a base-directory, this function scans the subtree and finds all the js
 * files. .git and node_module subdirectories are ignored.
 * @param {!string} baseDir top-level directory to scan
 * @param {!regex} regex the regular expression that specifies the types of
 *  files to find based on their filename
 * @param {!function(?Error, Array<string>)} callback error-back callback
 */
function findFiles(baseDir, regex) {
    return new Promise((resolve, reject) => {
        let error;
        if (!baseDir) {
            reject(new Error('hasher.findJSFiles requires a baseDir argument'));
            return;
        }
        const find = findit(baseDir);
        const fileList = [];
        find.on('error', (err) => {
            error = err;
            return;
        });
        find.on('directory', (dir, ignore, stop) => {
            const base = path.basename(dir);
            if (base === '.git' || base === 'node_modules') {
                stop(); // do not descend
            }
        });
        find.on('file', (file) => {
            if (regex.test(file)) {
                fileList.push(file);
            }
        });
        find.on('end', () => {
            // Note: the `end` event fires even after an error
            if (error) {
                reject(error);
            }
            else {
                resolve(fileList);
            }
        });
    });
}
/**
 * Compute a sha hash for the given file and record line counts along the way.
 * @param {string} filename
 * @param {Boolean} shouldHash whether a hash should be computed
 * @param {function} cb errorback style callback which returns the sha string
 * @private
 */
function statsForFile(filename, shouldHash) {
    return new Promise((resolve, reject) => {
        const reader = fs.createReadStream(filename);
        reader.on('error', err => {
            reject(err);
        });
        reader.on('open', () => {
            let shasum;
            if (shouldHash) {
                shasum = crypto.createHash('sha1');
            }
            let lines = 0;
            let error;
            const byLine = reader.pipe(split());
            byLine.on('error', (e) => {
                error = e;
            });
            byLine.on('data', (d) => {
                if (shouldHash) {
                    shasum.update(d);
                }
                lines++;
            });
            byLine.on('end', () => {
                if (error) {
                    reject(error);
                }
                else {
                    const hash = shouldHash ? shasum.digest('hex') : undefined;
                    resolve({ hash, lines });
                }
            });
        });
    });
}
//# sourceMappingURL=scanner.js.map