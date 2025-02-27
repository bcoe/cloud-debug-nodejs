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
exports.V8DebugApi = exports.V8BreakpointData = void 0;
const acorn = require("acorn");
const path = require("path");
const semver = require("semver");
const vm = require("vm");
const status_message_1 = require("../../client/stackdriver/status-message");
const state = require("../state/legacy-state");
const utils = require("../util/utils");
const debugapi = require("./debugapi");
class V8BreakpointData {
    constructor(apiBreakpoint, v8Breakpoint, parsedCondition, 
    // TODO: The code in this method assumes that `compile` exists.  Verify
    // that is correct.
    // TODO: Update this so that `null|` is not needed for `compile`.
    compile) {
        this.apiBreakpoint = apiBreakpoint;
        this.v8Breakpoint = v8Breakpoint;
        this.parsedCondition = parsedCondition;
        this.compile = compile;
    }
}
exports.V8BreakpointData = V8BreakpointData;
class V8DebugApi {
    constructor(logger, config, jsFiles, sourcemapper) {
        this.breakpoints = {};
        this.listeners = {};
        this.numBreakpoints = 0;
        this.sourcemapper = sourcemapper;
        // This constructor is only used in situations where the legacy vm
        // interface is used that has the `runInDebugContext` method.
        this.v8 = vm.runInDebugContext('Debug');
        this.config = config;
        this.fileStats = jsFiles;
        this.v8Version = /(\d+\.\d+\.\d+)\.\d+/.exec(process.versions.v8);
        this.logger = logger;
        this.usePermanentListener = semver.satisfies(this.v8Version[1], '>=4.5');
        this.handleDebugEvents = (evt, execState, eventData) => {
            try {
                switch (evt) {
                    // TODO: Address the case where `v8` is `null`.
                    case this.v8.DebugEvent.Break:
                        eventData.breakPointsHit().forEach(hit => {
                            const num = hit.script_break_point().number();
                            if (this.listeners[num].enabled) {
                                this.logger.info('>>>V8 breakpoint hit<<< number: ' + num);
                                this.listeners[num].listener(execState, eventData);
                            }
                        });
                        break;
                    default:
                }
            }
            catch (e) {
                this.logger.warn('Internal V8 error on breakpoint event: ' + e);
            }
        };
        if (this.usePermanentListener) {
            this.logger.info('activating v8 breakpoint listener (permanent)');
            this.v8.setListener(this.handleDebugEvents);
        }
    }
    set(breakpoint, cb) {
        if (!this.v8 ||
            !breakpoint ||
            typeof breakpoint.id === 'undefined' || // 0 is a valid id
            !breakpoint.location ||
            !breakpoint.location.path ||
            !breakpoint.location.line) {
            return utils.setErrorStatusAndCallback(cb, breakpoint, status_message_1.StatusMessage.UNSPECIFIED, utils.messages.INVALID_BREAKPOINT);
        }
        const baseScriptPath = path.normalize(breakpoint.location.path);
        const mapInfoInput = this.sourcemapper.getMapInfoInput(baseScriptPath);
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
        const v8bp = breakpointData.v8Breakpoint;
        this.v8.clearBreakPoint(v8bp.number());
        delete this.breakpoints[breakpoint.id];
        delete this.listeners[v8bp.number()];
        this.numBreakpoints--;
        if (this.numBreakpoints === 0 && !this.usePermanentListener) {
            // removed last breakpoint
            this.logger.info('deactivating v8 breakpoint listener');
            this.v8.setListener(null);
        }
        setImmediate(() => {
            cb(null);
        });
    }
    wait(breakpoint, callback) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const that = this;
        const num = that.breakpoints[breakpoint.id].v8Breakpoint.number();
        const listener = this.onBreakpointHit.bind(this, breakpoint, (err) => {
            that.listeners[num].enabled = false;
            // This method is called from the debug event listener, which
            // swallows all exception. We defer the callback to make sure the
            // user errors aren't silenced.
            setImmediate(() => {
                callback(err || undefined);
            });
        });
        that.listeners[num] = { enabled: true, listener };
    }
    log(breakpoint, print, shouldStop) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const that = this;
        const num = that.breakpoints[breakpoint.id].v8Breakpoint.number();
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
            // null
            breakpoint.logMessageFormat, breakpoint.evaluatedExpressions.map(obj => JSON.stringify(obj)));
            logsThisSecond++;
            if (shouldStop()) {
                that.listeners[num].enabled = false;
            }
            else {
                if (logsThisSecond >= that.config.log.maxLogsPerSecond) {
                    that.listeners[num].enabled = false;
                    setTimeout(() => {
                        // listeners[num] may have been deleted by `clear` during the
                        // async hop. Make sure it is valid before setting a property
                        // on it.
                        if (!shouldStop() && that.listeners[num]) {
                            that.listeners[num].enabled = true;
                        }
                    }, that.config.log.logDelaySeconds * 1000);
                }
            }
        });
        that.listeners[num] = { enabled: true, listener };
    }
    disconnect() {
        return;
    }
    numBreakpoints_() {
        return Object.keys(this.breakpoints).length;
    }
    numListeners_() {
        return Object.keys(this.listeners).length;
    }
    setInternal(breakpoint, mapInfo, compile, cb) {
        // Parse and validate conditions and watch expressions for correctness and
        // immutability
        let ast = null;
        if (breakpoint.condition) {
            try {
                // We parse as ES6; even though the underlying V8 version may only
                // support a subset. This should be fine as the objective of the parse
                // is to heuristically find side-effects. V8 will raise errors later
                // if the syntax is invalid. It would have been nice if V8 had made the
                // parser API available us :(.
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
            catch (err) {
                return utils.setErrorStatusAndCallback(cb, breakpoint, status_message_1.StatusMessage.BREAKPOINT_CONDITION, utils.messages.SYNTAX_ERROR_IN_CONDITION + err.message);
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
        // The breakpoint protobuf message presently doesn't have a column property
        // but it may have one in the future.
        // TODO: Address the case where `breakpoint.location` is `null`.
        let column = mapInfo && mapInfo.column
            ? mapInfo.column
            : breakpoint.location.column || 1;
        const line = mapInfo
            ? mapInfo.line
            : breakpoint.location.line;
        // We need to special case breakpoints on the first line. Since Node.js
        // wraps modules with a function expression, we adjust
        // to deal with that.
        if (line === 1) {
            column += debugapi.MODULE_WRAP_PREFIX_LENGTH - 1;
        }
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
        const v8bp = this.setByRegExp(matchingScript, line, column);
        if (!v8bp) {
            return utils.setErrorStatusAndCallback(cb, breakpoint, status_message_1.StatusMessage.BREAKPOINT_SOURCE_LOCATION, utils.messages.V8_BREAKPOINT_ERROR);
        }
        if (this.numBreakpoints === 0 && !this.usePermanentListener) {
            // added first breakpoint
            this.logger.info('activating v8 breakpoint listener');
            this.v8.setListener(this.handleDebugEvents);
        }
        this.breakpoints[breakpoint.id] =
            // TODO: Address the case where `ast` is `null`.
            new V8BreakpointData(breakpoint, v8bp, ast, compile);
        this.numBreakpoints++;
        setImmediate(() => {
            cb(null);
        }); // success.
    }
    setByRegExp(scriptPath, line, column) {
        const regexp = utils.pathToRegExp(scriptPath);
        const num = this.v8.setScriptBreakPointByRegExp(regexp, line - 1, column - 1);
        const v8bp = this.v8.findBreakPoint(num);
        return v8bp;
    }
    onBreakpointHit(breakpoint, callback, execState) {
        // TODO: Address the situation where `breakpoint.id` is `null`.
        const v8bp = this.breakpoints[breakpoint.id].v8Breakpoint;
        if (!v8bp.active()) {
            // Breakpoint exists, but not active. We never disable breakpoints, so
            // this is theoretically not possible. Perhaps this is possible if there
            // is a second debugger present? Regardless, report the error.
            return utils.setErrorStatusAndCallback(callback, breakpoint, status_message_1.StatusMessage.BREAKPOINT_SOURCE_LOCATION, utils.messages.V8_BREAKPOINT_DISABLED);
        }
        const result = this.checkCondition(breakpoint, execState);
        if (result.error) {
            return utils.setErrorStatusAndCallback(callback, breakpoint, status_message_1.StatusMessage.BREAKPOINT_CONDITION, utils.messages.ERROR_EVALUATING_CONDITION + result.error);
        }
        else if (!result.value) {
            // Check again next time
            this.logger.info("\tthe breakpoint condition wasn't met");
            return;
        }
        // Breakpoint Hit
        const start = process.hrtime();
        try {
            this.captureBreakpointData(breakpoint, execState);
        }
        catch (err) {
            return utils.setErrorStatusAndCallback(callback, breakpoint, status_message_1.StatusMessage.BREAKPOINT_SOURCE_LOCATION, utils.messages.CAPTURE_BREAKPOINT_DATA + err);
        }
        const end = process.hrtime(start);
        this.logger.info(utils.formatInterval('capture time: ', end));
        callback(null);
    }
    /**
     * Evaluates the breakpoint condition, if present.
     * @return object with either a boolean value or an error property
     */
    checkCondition(breakpoint, execState) {
        if (!breakpoint.condition) {
            return { value: true };
        }
        const result = state.evaluate(breakpoint.condition, execState.frame(0));
        if (result.error) {
            return { error: result.error };
        }
        // TODO: Address the case where `result.mirror` is `null`.
        return {
            value: !!result.mirror.value(),
        }; // intentional !!
    }
    captureBreakpointData(breakpoint, execState) {
        const expressionErrors = [];
        if (breakpoint.expressions && this.breakpoints[breakpoint.id].compile) {
            for (let i = 0; i < breakpoint.expressions.length; i++) {
                try {
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
                const frame = execState.frame(0);
                const evaluatedExpressions = breakpoint.expressions.map(exp => {
                    const result = state.evaluate(exp, frame);
                    // TODO: Address the case where `result.mirror` is `undefined`.
                    return result.error
                        ? result.error
                        : result.mirror.value();
                });
                breakpoint.evaluatedExpressions = evaluatedExpressions;
            }
        }
        else {
            // TODO: Address the case where `breakpoint.expression` is `undefined`.
            const captured = state.capture(execState, breakpoint.expressions, this.config, this.v8);
            if (breakpoint.location &&
                utils.isJavaScriptFile(breakpoint.location.path) &&
                captured.location &&
                captured.location.line) {
                breakpoint.location.line = captured.location.line;
            }
            breakpoint.stackFrames = captured.stackFrames;
            // TODO: This suggests the Status type and Variable type are the same.
            //       Determine if that is the case.
            breakpoint.variableTable =
                captured.variableTable;
            breakpoint.evaluatedExpressions = expressionErrors.concat(captured.evaluatedExpressions);
        }
    }
}
exports.V8DebugApi = V8DebugApi;
//# sourceMappingURL=legacy-debugapi.js.map