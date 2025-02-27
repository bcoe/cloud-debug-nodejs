"use strict";
// Copyright 2017 Google LLC
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
exports.InspectorDebugApi = exports.BreakpointData = void 0;
const acorn = require("acorn");
// eslint-disable-next-line node/no-unsupported-features/node-builtins
const inspector = require("inspector");
const path = require("path");
const status_message_1 = require("../../client/stackdriver/status-message");
const sourcemapper_1 = require("../io/sourcemapper");
const state = require("../state/inspector-state");
const utils = require("../util/utils");
const debugapi = require("./debugapi");
const v8inspector_1 = require("./v8inspector");
/**
 * In older versions of Node, the script source as seen by the Inspector
 * backend is wrapped in `require('module').wrapper`, and in new versions
 * (Node 10.16+, Node 11.11+, Node 12+) it's not. This affects line-1
 * breakpoints.
 */
const USE_MODULE_PREFIX = utils.satisfies(process.version, '<10.16 || >=11 <11.11');
class BreakpointData {
    constructor(id, apiBreakpoint, parsedCondition, locationStr, compile) {
        this.id = id;
        this.apiBreakpoint = apiBreakpoint;
        this.parsedCondition = parsedCondition;
        this.locationStr = locationStr;
        this.compile = compile;
    }
}
exports.BreakpointData = BreakpointData;
class InspectorDebugApi {
    constructor(logger, config, jsFiles, sourcemapper) {
        this.breakpoints = {};
        // TODO: listeners, scrpitmapper, location mapper and breakpointmapper can use
        // Map in the future after resolving Map.prototype.get(key) returns V or
        // undefined.
        this.listeners = {};
        // scriptmapper maps scriptId to actual script path.
        this.scriptMapper = {};
        // locationmapper maps location string to a list of stackdriver breakpoint id.
        this.locationMapper = {};
        // breakpointmapper maps v8/inspector breakpoint id to a list of
        // stackdriver breakpoint id.
        this.breakpointMapper = {};
        this.numBreakpoints = 0;
        this.numBreakpointHitsBeforeReset = 0;
        this.logger = logger;
        this.config = config;
        this.fileStats = jsFiles;
        this.sourcemapper = sourcemapper;
        this.scriptMapper = {};
        this.v8 = this.createV8Data();
    }
    /** Creates a new V8 Debugging session and the related data. */
    createV8Data() {
        const session = new inspector.Session();
        session.connect();
        session.on('Debugger.scriptParsed', script => {
            this.scriptMapper[script.params.scriptId] = script.params;
        });
        session.post('Debugger.enable');
        session.post('Debugger.setBreakpointsActive', { active: true });
        session.on('Debugger.paused', message => {
            try {
                this.handleDebugPausedEvent(message.params);
            }
            catch (error) {
                this.logger.error(error);
            }
        });
        return {
            session,
            inspectorOptions: {
                // Well-Formatted URL is required in Node 10.11.1+.
                useWellFormattedUrl: utils.satisfies(process.version, '>10.11.0'),
            },
            inspector: new v8inspector_1.V8Inspector(session),
            setBreakpointsParams: {},
        };
    }
    set(breakpoint, cb) {
        if (!breakpoint ||
            typeof breakpoint.id === 'undefined' || // 0 is a valid id
            !breakpoint.location ||
            !breakpoint.location.path ||
            !breakpoint.location.line) {
            return utils.setErrorStatusAndCallback(cb, breakpoint, status_message_1.StatusMessage.UNSPECIFIED, utils.messages.INVALID_BREAKPOINT);
        }
        const baseScriptPath = path.normalize(breakpoint.location.path);
        let mapInfoInput = null;
        try {
            mapInfoInput = this.sourcemapper.getMapInfoInput(baseScriptPath);
        }
        catch (error) {
            if (error instanceof sourcemapper_1.MultiFileMatchError) {
                this.logger.warn(`Unable to unambiguously find ${baseScriptPath}. Multiple matches: ${error.files}`);
                return utils.setErrorStatusAndCallback(cb, breakpoint, status_message_1.StatusMessage.BREAKPOINT_SOURCE_LOCATION, utils.messages.SOURCE_FILE_AMBIGUOUS);
            }
            else {
                throw error;
            }
        }
        if (mapInfoInput === null) {
            const extension = path.extname(baseScriptPath);
            if (!this.config.javascriptFileExtensions.includes(extension)) {
                return utils.setErrorStatusAndCallback(cb, breakpoint, status_message_1.StatusMessage.BREAKPOINT_SOURCE_LOCATION, utils.messages.COULD_NOT_FIND_OUTPUT_FILE);
            }
            this.setInternal(breakpoint, null /* mapInfo */, null /* compile */, cb);
        }
        else {
            const line = breakpoint.location.line;
            const column = 0;
            const mapInfo = this.sourcemapper.getMapInfoOutput(line, column, mapInfoInput);
            const compile = utils.getBreakpointCompiler(breakpoint);
            if (breakpoint.condition && compile) {
                try {
                    breakpoint.condition = compile(breakpoint.condition);
                }
                catch (e) {
                    this.logger.info('Unable to compile condition >> ' + breakpoint.condition + ' <<');
                    return utils.setErrorStatusAndCallback(cb, breakpoint, status_message_1.StatusMessage.BREAKPOINT_CONDITION, utils.messages.ERROR_COMPILING_CONDITION);
                }
            }
            this.setInternal(breakpoint, mapInfo, compile, cb);
        }
    }
    clear(breakpoint, cb) {
        if (typeof breakpoint.id === 'undefined') {
            return utils.setErrorStatusAndCallback(cb, breakpoint, status_message_1.StatusMessage.BREAKPOINT_CONDITION, utils.messages.V8_BREAKPOINT_CLEAR_ERROR);
        }
        const breakpointData = this.breakpoints[breakpoint.id];
        if (!breakpointData) {
            return utils.setErrorStatusAndCallback(cb, breakpoint, status_message_1.StatusMessage.BREAKPOINT_CONDITION, utils.messages.V8_BREAKPOINT_CLEAR_ERROR);
        }
        const locationStr = breakpointData.locationStr;
        const v8BreakpointId = breakpointData.id;
        // delete current breakpoint from locationmapper and breakpointmapper.
        utils.removeFirstOccurrenceInArray(this.locationMapper[locationStr], breakpoint.id);
        if (this.locationMapper[locationStr].length === 0) {
            delete this.locationMapper[locationStr];
        }
        utils.removeFirstOccurrenceInArray(this.breakpointMapper[v8BreakpointId], breakpoint.id);
        if (this.breakpointMapper[v8BreakpointId].length === 0) {
            delete this.breakpointMapper[v8BreakpointId];
        }
        let result = {};
        if (!this.breakpointMapper[breakpointData.id]) {
            // When breakpointmapper does not countain current v8/inspector breakpoint
            // id, we should remove this breakpoint from v8.
            result = this.v8.inspector.removeBreakpoint(breakpointData.id);
            delete this.v8.setBreakpointsParams[breakpointData.id];
        }
        delete this.breakpoints[breakpoint.id];
        delete this.listeners[breakpoint.id];
        this.numBreakpoints--;
        setImmediate(() => {
            if (result.error) {
                cb(result.error);
            }
            cb(null);
        });
    }
    wait(breakpoint, callback) {
        // TODO: Address the case whree `breakpoint.id` is `null`.
        const listener = this.onBreakpointHit.bind(this, breakpoint, (err) => {
            this.listeners[breakpoint.id].enabled = false;
            // This method is called from the debug event listener, which
            // swallows all exception. We defer the callback to make sure
            // the user errors aren't silenced.
            setImmediate(() => {
                callback(err || undefined);
            });
        });
        this.listeners[breakpoint.id] = { enabled: true, listener };
    }
    log(breakpoint, print, shouldStop) {
        // TODO: Address the case whree `breakpoint.id` is `null`.
        let logsThisSecond = 0;
        let timesliceEnd = Date.now() + 1000;
        // TODO: Determine why the Error argument is not used.
        const listener = this.onBreakpointHit.bind(this, breakpoint, () => {
            const currTime = Date.now();
            if (currTime > timesliceEnd) {
                logsThisSecond = 0;
                timesliceEnd = currTime + 1000;
            }
            print(
            // TODO: Address the case where `breakpoint.logMessageFormat` is
            // `null`.
            breakpoint.logMessageFormat, breakpoint.evaluatedExpressions.map((obj) => JSON.stringify(obj)));
            logsThisSecond++;
            if (shouldStop()) {
                this.listeners[breakpoint.id].enabled = false;
            }
            else {
                if (logsThisSecond >= this.config.log.maxLogsPerSecond) {
                    this.listeners[breakpoint.id].enabled = false;
                    setTimeout(() => {
                        // listeners[num] may have been deleted by `clear` during the
                        // async hop. Make sure it is valid before setting a property
                        // on it.
                        if (!shouldStop() && this.listeners[breakpoint.id]) {
                            this.listeners[breakpoint.id].enabled = true;
                        }
                    }, this.config.log.logDelaySeconds * 1000);
                }
            }
        });
        this.listeners[breakpoint.id] = { enabled: true, listener };
    }
    disconnect() {
        this.v8.session.disconnect();
    }
    numBreakpoints_() {
        // Tracks the number of stackdriver breakpoints.
        return Object.keys(this.breakpoints).length;
    }
    numListeners_() {
        return Object.keys(this.listeners).length;
    }
    /**
     * Internal breakpoint set function. At this point we have looked up source
     * maps (if necessary), and scriptPath happens to be a JavaScript path.
     *
     * @param {!Breakpoint} breakpoint Debug API Breakpoint object
     * @param {!MapInfoOutput|null} mapInfo A map that has a "file" attribute for
     *    the path of the output file associated with the given input file
     * @param {function(string)=} compile optional compile function that can be
     *    be used to compile source expressions to JavaScript
     * @param {function(?Error)} cb error-back style callback
     */
    // TODO: Fix the documented types to match the function's input types
    // TODO: Unify this function with setInternal in v8debugapi.ts.
    setInternal(breakpoint, mapInfo, compile, cb) {
        // Parse and validate conditions and watch expressions for correctness and
        // immutability
        let ast = null;
        if (breakpoint.condition) {
            try {
                // We parse as ES6; even though the underlying V8 version may only
                // support a subset. This should be fine as the objective of the parse
                // is to heuristically find side-effects. V8 will raise errors later
                // if the syntax is invalid. It would have been nice if V8 had made
                // the parser API available us :(.
                ast = acorn.parse(breakpoint.condition, {
                    sourceType: 'script',
                    ecmaVersion: 6,
                });
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const validator = require('../util/validator.js');
                if (!validator.isValid(ast)) {
                    return utils.setErrorStatusAndCallback(cb, breakpoint, status_message_1.StatusMessage.BREAKPOINT_CONDITION, utils.messages.DISALLOWED_EXPRESSION);
                }
            }
            catch (e) {
                const message = utils.messages.SYNTAX_ERROR_IN_CONDITION + e.message;
                return utils.setErrorStatusAndCallback(cb, breakpoint, status_message_1.StatusMessage.BREAKPOINT_CONDITION, message);
            }
        }
        // Presently it is not possible to precisely disambiguate the script
        // path from the path provided by the debug server. The issue is that we
        // don't know the repository root relative to the root filesystem or
        // relative to the working-directory of the process. We want to make sure
        // that we are setting the breakpoint that the user intended instead of a
        // breakpoint in a file that happens to have the same name but is in a
        // different directory. Until this is addressed between the server and the
        // debuglet, we are going to assume that repository root === the starting
        // working directory.
        let matchingScript;
        // TODO: Address the case where `breakpoint.location` is `null`.
        const scriptPath = mapInfo
            ? mapInfo.file
            : path.normalize(breakpoint.location.path);
        const scripts = utils.findScripts(scriptPath, this.config, this.fileStats, this.logger);
        if (scripts.length === 0) {
            return utils.setErrorStatusAndCallback(cb, breakpoint, status_message_1.StatusMessage.BREAKPOINT_SOURCE_LOCATION, utils.messages.SOURCE_FILE_NOT_FOUND);
        }
        else if (scripts.length === 1) {
            // Found the script
            matchingScript = scripts[0];
        }
        else {
            this.logger.warn(`Unable to unambiguously find ${scriptPath}. Potential matches: ${scripts}`);
            return utils.setErrorStatusAndCallback(cb, breakpoint, status_message_1.StatusMessage.BREAKPOINT_SOURCE_LOCATION, utils.messages.SOURCE_FILE_AMBIGUOUS);
        }
        // The breakpoint protobuf message presently doesn't have a column
        // property but it may have one in the future.
        // TODO: Address the case where `breakpoint.location` is `null`.
        let column = mapInfo && mapInfo.column
            ? mapInfo.column
            : breakpoint.location.column || 1;
        const line = mapInfo
            ? mapInfo.line
            : breakpoint.location.line;
        // In older versions of Node, since Node.js wraps modules with a function
        // expression, we need to special case breakpoints on the first line.
        if (USE_MODULE_PREFIX && line === 1) {
            column += debugapi.MODULE_WRAP_PREFIX_LENGTH - 1;
        }
        // TODO: Address the case where `breakpoint.location` is `null`.
        // TODO: Address the case where `fileStats[matchingScript]` is `null`.
        if (line >= this.fileStats[matchingScript].lines) {
            return utils.setErrorStatusAndCallback(cb, breakpoint, status_message_1.StatusMessage.BREAKPOINT_SOURCE_LOCATION, utils.messages.INVALID_LINE_NUMBER +
                matchingScript +
                ':' +
                line +
                '. Loaded script contained ' +
                this.fileStats[matchingScript].lines +
                ' lines. Please ensure' +
                ' that the snapshot was set in the same code version as the' +
                ' deployed source.');
        }
        const result = this.setAndStoreBreakpoint(breakpoint, line, column, matchingScript);
        if (!result) {
            return utils.setErrorStatusAndCallback(cb, breakpoint, status_message_1.StatusMessage.BREAKPOINT_SOURCE_LOCATION, utils.messages.V8_BREAKPOINT_ERROR);
        }
        this.breakpoints[breakpoint.id] = new BreakpointData(result.v8BreakpointId, breakpoint, ast, result.locationStr, compile);
        this.numBreakpoints++;
        setImmediate(() => {
            cb(null);
        }); // success.
    }
    setAndStoreBreakpoint(breakpoint, line, column, matchingScript) {
        // location Str will be a JSON string of Stackdriver breakpoint location.
        // It will be used as key at locationmapper to ensure there will be no
        // duplicate breakpoints at the same location.
        const locationStr = JSON.stringify(breakpoint.location);
        let v8BreakpointId; // v8/inspector breakpoint id
        if (!this.locationMapper[locationStr]) {
            // The first time when a breakpoint was set to this location.
            const rawUrl = this.v8.inspectorOptions.useWellFormattedUrl
                ? `file://${matchingScript}`
                : matchingScript;
            // on windows on Node 11+, the url must start with file:///
            // (notice 3 slashes) and have all backslashes converted into forward slashes
            const url = process.platform === 'win32' && utils.satisfies(process.version, '>=11')
                ? rawUrl.replace(/^file:\/\//, 'file:///').replace(/\\/g, '/')
                : rawUrl;
            const params = {
                lineNumber: line - 1,
                url,
                columnNumber: column - 1,
                condition: breakpoint.condition || undefined,
            };
            const res = this.v8.inspector.setBreakpointByUrl(params);
            if (res.error || !res.response) {
                // Error case.
                return null;
            }
            v8BreakpointId = res.response.breakpointId;
            this.v8.setBreakpointsParams[v8BreakpointId] = params;
            this.locationMapper[locationStr] = [];
            this.breakpointMapper[v8BreakpointId] = [];
        }
        else {
            // Breakpoint found at this location. Acquire the v8/inspector breakpoint
            // id.
            v8BreakpointId = this.breakpoints[this.locationMapper[locationStr][0]].id;
        }
        // Adding current stackdriver breakpoint id to location mapper and
        // breakpoint mapper.
        this.locationMapper[locationStr].push(breakpoint.id);
        this.breakpointMapper[v8BreakpointId].push(breakpoint.id);
        return { v8BreakpointId, locationStr };
    }
    onBreakpointHit(breakpoint, callback, callFrames) {
        // Breakpoint Hit
        const start = process.hrtime();
        try {
            this.captureBreakpointData(breakpoint, callFrames);
        }
        catch (err) {
            return utils.setErrorStatusAndCallback(callback, breakpoint, status_message_1.StatusMessage.BREAKPOINT_SOURCE_LOCATION, utils.messages.CAPTURE_BREAKPOINT_DATA + err);
        }
        const end = process.hrtime(start);
        this.logger.info(utils.formatInterval('capture time: ', end));
        callback(null);
    }
    captureBreakpointData(breakpoint, callFrames) {
        const expressionErrors = [];
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const that = this;
        // TODO: Address the case where `breakpoint.id` is `null`.
        if (breakpoint.expressions && this.breakpoints[breakpoint.id].compile) {
            for (let i = 0; i < breakpoint.expressions.length; i++) {
                try {
                    // TODO: Address the case where `breakpoint.id` is `null`.
                    breakpoint.expressions[i] =
                        // TODO: Address the case where `compile` is `null`.
                        this.breakpoints[breakpoint.id].compile(breakpoint.expressions[i]);
                }
                catch (e) {
                    this.logger.info('Unable to compile watch expression >> ' +
                        breakpoint.expressions[i] +
                        ' <<');
                    expressionErrors.push({
                        name: breakpoint.expressions[i],
                        status: new status_message_1.StatusMessage(status_message_1.StatusMessage.VARIABLE_VALUE, 'Error Compiling Expression', true),
                    });
                    breakpoint.expressions.splice(i, 1);
                    i--;
                }
            }
        }
        if (breakpoint.action === 'LOG') {
            // TODO: This doesn't work with compiled languages if there is an error
            // compiling one of the expressions in the loop above.
            if (!breakpoint.expressions) {
                breakpoint.evaluatedExpressions = [];
            }
            else {
                const frame = callFrames[0];
                const evaluatedExpressions = breakpoint.expressions.map(exp => {
                    // returnByValue is set to true here so that the JSON string of the
                    // value will be returned to log.
                    const result = state.evaluate(exp, frame, that.v8.inspector, true);
                    if (result.error) {
                        return result.error;
                    }
                    else {
                        return result.object.value;
                    }
                });
                breakpoint.evaluatedExpressions = evaluatedExpressions;
            }
        }
        else {
            const captured = state.capture(callFrames, breakpoint, this.config, this.scriptMapper, this.v8.inspector);
            if (breakpoint.location &&
                utils.isJavaScriptFile(breakpoint.location.path)) {
                breakpoint.location.line = callFrames[0].location.lineNumber + 1;
            }
            breakpoint.stackFrames = captured.stackFrames;
            // TODO: This suggests the Status type and Variable type are the same.
            //       Determine if that is the case.
            breakpoint.variableTable =
                captured.variableTable;
            breakpoint.evaluatedExpressions = expressionErrors.concat(captured.evaluatedExpressions);
        }
    }
    handleDebugPausedEvent(params) {
        try {
            if (!params.hitBreakpoints)
                return;
            const v8BreakpointId = params.hitBreakpoints[0];
            this.breakpointMapper[v8BreakpointId].forEach((id) => {
                if (this.listeners[id].enabled) {
                    this.logger.info('>>>breakpoint hit<<< number: ' + id);
                    this.listeners[id].listener(params.callFrames);
                }
            });
        }
        catch (e) {
            this.logger.warn('Internal V8 error on breakpoint event: ' + e);
        }
        this.tryResetV8Debugger();
    }
    /**
     * Periodically resets breakpoints to prevent memory leaks in V8 (for holding
     * contexts of previous breakpoint hits).
     */
    tryResetV8Debugger() {
        this.numBreakpointHitsBeforeReset += 1;
        if (this.numBreakpointHitsBeforeReset < this.config.resetV8DebuggerThreshold) {
            return;
        }
        this.numBreakpointHitsBeforeReset = 0;
        const storedParams = this.v8.setBreakpointsParams;
        // Re-connect the session to clean the memory usage.
        this.disconnect();
        this.scriptMapper = {};
        this.v8 = this.createV8Data();
        this.v8.setBreakpointsParams = storedParams;
        // Setting the v8 breakpoints again according to the stored parameters.
        for (const params of Object.values(storedParams)) {
            const res = this.v8.inspector.setBreakpointByUrl(params);
            if (res.error || !res.response) {
                this.logger.error('Error upon re-setting breakpoint: ' + res);
            }
        }
    }
}
exports.InspectorDebugApi = InspectorDebugApi;
//# sourceMappingURL=inspector-debugapi.js.map