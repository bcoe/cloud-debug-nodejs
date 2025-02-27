/// <reference types="node" />
import * as inspector from 'inspector';
import consoleLogLevel = require('console-log-level');
import * as stackdriver from '../../types/stackdriver';
import { ResolvedDebugAgentConfig } from '../config';
import { ScanStats } from '../io/scanner';
import * as v8 from '../../types/v8';
export declare const messages: {
    INVALID_BREAKPOINT: string;
    SOURCE_FILE_NOT_FOUND: string;
    SOURCE_FILE_AMBIGUOUS: string;
    V8_BREAKPOINT_ERROR: string;
    V8_BREAKPOINT_CLEAR_ERROR: string;
    SYNTAX_ERROR_IN_CONDITION: string;
    ERROR_EVALUATING_CONDITION: string;
    ERROR_COMPILING_CONDITION: string;
    DISALLOWED_EXPRESSION: string;
    SOURCE_MAP_READ_ERROR: string;
    V8_BREAKPOINT_DISABLED: string;
    CAPTURE_BREAKPOINT_DATA: string;
    INVALID_LINE_NUMBER: string;
    COULD_NOT_FIND_OUTPUT_FILE: string;
};
export interface LegacyListener {
    enabled: boolean;
    listener: (args: v8.ExecutionState, eventData: v8.BreakEvent) => void;
}
export interface InspectorListener {
    enabled: boolean;
    listener: (args: inspector.Debugger.CallFrame[]) => void;
}
export declare function findScripts(scriptPath: string, config: ResolvedDebugAgentConfig, fileStats: ScanStats, logger: consoleLogLevel.Logger): string[];
/**
 * Given an list of available files and a script path to match, this function
 * tries to resolve the script to a (hopefully unique) match in the file list
 * disregarding the full path to the script. This can be useful because repo
 * file paths (that the UI has) may not necessarily be suffixes of the absolute
 * paths of the deployed files. This happens when the user deploys a
 * subdirectory of the repo.
 *
 * For example consider a file named `a/b.js` in the repo. If the
 * directory contents of `a` are deployed rather than the whole repo, we are not
 * going to have any file named `a/b.js` in the running Node process.
 *
 * We incrementally consider more components of the path until we find a unique
 * match, or return all the potential matches.
 *
 * @example
 * ```
 * findScriptsFuzzy('a/b.js', ['/d/b.js']) // -> ['/d/b.js']
 * ```
 * @example
 * ```
 * findScriptsFuzzy('a/b.js', ['/c/b.js', '/d/b.js']); // -> []
 * ```
 * @example
 * ```
 * findScriptsFuzzy('a/b.js', ['/x/a/b.js', '/y/a/b.js'])
 *                 // -> ['x/a/b.js', 'y/a/b.js']
 *
 * ```
 * @param {string} scriptPath partial path to the script.
 * @param {array<string>} fileList an array of absolute paths of filenames
 *     available.
 * @return {array<string>} list of files that match.
 */
export declare function findScriptsFuzzy(scriptPath: string, fileList: string[]): string[];
/**
 * @param {!string} scriptPath path of a script
 */
export declare function pathToRegExp(scriptPath: string): RegExp;
/**
 * Formats a provided message and a high-resolution interval of the format
 * [seconds, nanoseconds] (for example, from process.hrtime()) prefixed with a
 * provided message as a string intended for logging.
 * @param {string} msg The mesage that prefixes the formatted interval.
 * @param {number[]} interval The interval to format.
 * @return {string} A formatted string.
 */
export declare const formatInterval: (msg: string, interval: number[]) => string;
export declare function setErrorStatusAndCallback(fn: (err: Error | null) => void, breakpoint: stackdriver.Breakpoint, refersTo: stackdriver.Reference, message: string): void;
/**
 * Produces a compilation function based on the file extension of the
 * script path in which the breakpoint is set.
 *
 * @param {Breakpoint} breakpoint
 */
export declare function getBreakpointCompiler(breakpoint: stackdriver.Breakpoint): ((uncompiled: string) => string) | null;
export declare function removeFirstOccurrenceInArray<T>(array: T[], element: T): void;
/**
 * Used to determine whether the specified node version satisfies the
 * given semver range.  This method is able to properly handle nightly
 * builds.  For example,
 *    satisfies('v10.0.0-nightly201804132a6ab9b37b', '>=10')
 * returns `true`.
 *
 * @param version The node version.
 * @param semverRange The semver range to check against
 */
export declare function satisfies(nodeVersion: string, semverRange: string): boolean;
/**
 * Used to determine if the specified file is a JavaScript file
 * by determining if it has a `.js` file extension.
 *
 * @param filepath The path of the file to analyze.
 */
export declare function isJavaScriptFile(filepath: string): boolean;
