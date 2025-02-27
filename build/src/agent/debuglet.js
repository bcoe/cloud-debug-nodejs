"use strict";
// Copyright 2014 Google LLC
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
exports.Debuglet = exports.CachedPromise = exports.Platforms = void 0;
const assert = require("assert");
const consoleLogLevel = require("console-log-level");
const crypto = require("crypto");
const events_1 = require("events");
const extend = require("extend");
const fs = require("fs");
const metadata = require("gcp-metadata");
const path = require("path");
const util = require("util");
const status_message_1 = require("../client/stackdriver/status-message");
const debuggee_1 = require("../debuggee");
const config_1 = require("./config");
const controller_1 = require("./controller");
const scanner = require("./io/scanner");
const SourceMapper = require("./io/sourcemapper");
const utils = require("./util/utils");
const debugapi = require("./v8/debugapi");
const readFilep = util.promisify(fs.readFile);
const ALLOW_EXPRESSIONS_MESSAGE = 'Expressions and conditions are not allowed' +
    ' by default. Please set the allowExpressions configuration option to true.' +
    ' See the debug agent documentation at https://goo.gl/ShSm6r.';
const NODE_VERSION_MESSAGE = 'Node.js version not supported. Node.js 5.2.0 and ' +
    'versions older than 0.12 are not supported.';
const NODE_10_CIRC_REF_MESSAGE = 'capture.maxDataSize=0 is not recommended on older versions of Node 10/11' +
    ' and Node 12.' +
    ' See https://github.com/googleapis/cloud-debug-nodejs/issues/516 for more' +
    ' information.';
const BREAKPOINT_ACTION_MESSAGE = 'The only currently supported breakpoint actions' + ' are CAPTURE and LOG.';
// PROMISE_RESOLVE_CUT_OFF_IN_MILLISECONDS is a heuristic duration that we set
// to force the debug agent to return a new promise for isReady. The value is
// the average of Stackdriver debugger hanging get duration (40s) and TCP
// time-out on GCF (540s).
const PROMISE_RESOLVE_CUT_OFF_IN_MILLISECONDS = ((40 + 540) / 2) * 1000;
/**
 * Environments that this system might be running in.
 * Helps provide platform-specific information and integration.
 */
var Platforms;
(function (Platforms) {
    /** Google Cloud Functions */
    Platforms["CLOUD_FUNCTION"] = "cloud_function";
    /** Any other platform. */
    Platforms["DEFAULT"] = "default";
})(Platforms = exports.Platforms || (exports.Platforms = {}));
/**
 * Formats a breakpoint object prefixed with a provided message as a string
 * intended for logging.
 * @param {string} msg The message that prefixes the formatted breakpoint.
 * @param {Breakpoint} breakpoint The breakpoint to format.
 * @return {string} A formatted string.
 */
const formatBreakpoint = (msg, breakpoint) => {
    let text = msg +
        util.format('breakpoint id: %s,\n\tlocation: %s', breakpoint.id, util.inspect(breakpoint.location));
    if (breakpoint.createdTime) {
        const unixTime = Number(breakpoint.createdTime.seconds);
        const date = new Date(unixTime * 1000); // to milliseconds.
        text += '\n\tcreatedTime: ' + date.toString();
    }
    if (breakpoint.condition) {
        text += '\n\tcondition: ' + util.inspect(breakpoint.condition);
    }
    if (breakpoint.expressions) {
        text += '\n\texpressions: ' + util.inspect(breakpoint.expressions);
    }
    return text;
};
/**
 * Formats a map of breakpoint objects prefixed with a provided message as a
 * string intended for logging.
 * @param {string} msg The message that prefixes the formatted breakpoint.
 * @param {Object.<string, Breakpoint>} breakpoints A map of breakpoints.
 * @return {string} A formatted string.
 */
const formatBreakpoints = (msg, breakpoints) => {
    return (msg +
        Object.keys(breakpoints)
            .map(b => {
            return formatBreakpoint('', breakpoints[b]);
        })
            .join('\n'));
};
/**
 * CachedPromise stores a promise. This promise can be resolved by calling
 * function resolve() and can only be resolved once.
 */
class CachedPromise {
    constructor() {
        this.promiseResolve = null;
        this.promise = new Promise(resolve => {
            this.promiseResolve = resolve;
        });
    }
    get() {
        return this.promise;
    }
    resolve() {
        // Each promise can be resolved only once.
        if (this.promiseResolve) {
            this.promiseResolve();
            this.promiseResolve = null;
        }
    }
}
exports.CachedPromise = CachedPromise;
/**
 * IsReadyManager is a wrapper class to use debuglet.isReady().
 */
class IsReadyImpl {
    constructor(debuglet) {
        this.debuglet = debuglet;
    }
    isReady() {
        return this.debuglet.isReady();
    }
}
class Debuglet extends events_1.EventEmitter {
    /**
     * @param {Debug} debug - A Debug instance.
     * @param {object=} config - The option parameters for the Debuglet.
     * @event 'started' once the startup tasks are completed. Only called once.
     * @event 'stopped' if the agent stops due to a fatal error after starting.
     * Only called once.
     * @event 'registered' once successfully registered to the debug api. May be
     *     emitted multiple times.
     * @event 'remotelyDisabled' if the debuggee is disabled by the server. May be
     *    called multiple times.
     * @constructor
     */
    constructor(debug, config) {
        super();
        this.isReadyManager = new IsReadyImpl(this);
        /** @private {object} */
        this.config = Debuglet.normalizeConfig_(config);
        /** @private {Debug} */
        this.debug = debug;
        /**
         * @private {object} V8 Debug API. This can be null if the Node.js version
         *     is out of date.
         */
        this.v8debug = null;
        /** @private {boolean} */
        this.running = false;
        /** @private {string} */
        this.project = null;
        /** @private {boolean} */
        this.fetcherActive = false;
        /** @private */
        this.logger = consoleLogLevel({
            stderr: true,
            prefix: this.debug.packageInfo.name,
            level: Debuglet.logLevelToName(this.config.logLevel),
        });
        /** @private {DebugletApi} */
        this.controller = new controller_1.Controller(this.debug, { apiUrl: config.apiUrl });
        /** @private {Debuggee} */
        this.debuggee = null;
        /** @private {Object.<string, Breakpoint>} */
        this.activeBreakpointMap = {};
        /** @private {Object.<string, Boolean>} */
        this.completedBreakpointMap = {};
        this.breakpointFetched = null;
        this.breakpointFetchedTimestamp = -Infinity;
        this.debuggeeRegistered = new CachedPromise();
    }
    // The return type `LogLevel` is used instead of
    // `consoleLogLevel.LogLevelNames` because, otherwise,
    // the `consoleLogLevel.LogLevelNames` type is exposed to
    // users of the debug agent, requiring them to have
    // @types/console-log-level installed to compile their code.
    static logLevelToName(level) {
        if (typeof level === 'string') {
            level = Number(level);
        }
        if (typeof level !== 'number') {
            level = config_1.defaultConfig.logLevel;
        }
        if (level < 0)
            level = 0;
        if (level > 4)
            level = 4;
        return Debuglet.LEVELNAMES[level];
    }
    static normalizeConfig_(config) {
        const envConfig = {
            logLevel: process.env.GCLOUD_DEBUG_LOGLEVEL,
            serviceContext: {
                service: process.env.GAE_SERVICE ||
                    process.env.GAE_MODULE_NAME ||
                    process.env.K_SERVICE,
                version: process.env.GAE_VERSION ||
                    process.env.GAE_MODULE_VERSION ||
                    process.env.K_REVISION,
                minorVersion_: process.env.GAE_DEPLOYMENT_ID || process.env.GAE_MINOR_VERSION,
            },
        };
        if (process.env.FUNCTION_NAME) {
            envConfig.serviceContext.service = process.env.FUNCTION_NAME;
            envConfig.serviceContext.version = 'unversioned';
        }
        return extend(true, {}, config_1.defaultConfig, config, envConfig);
    }
    static buildRegExp(fileExtensions) {
        return new RegExp(fileExtensions.map(f => f + '$').join('|'));
    }
    static async findFiles(config, precomputedHash) {
        const baseDir = config.workingDirectory;
        const fileStats = await scanner.scan(baseDir, Debuglet.buildRegExp(config.javascriptFileExtensions.concat('js.map')), precomputedHash);
        const jsStats = fileStats.selectStats(Debuglet.buildRegExp(config.javascriptFileExtensions));
        const mapFiles = fileStats.selectFiles(/.js.map$/, process.cwd());
        const errors = fileStats.errors();
        return { jsStats, mapFiles, errors, hash: fileStats.hash };
    }
    /**
     * Starts the Debuglet. It is important that this is as quick as possible
     * as it is on the critical path of application startup.
     * @private
     */
    async start() {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const that = this;
        const stat = util.promisify(fs.stat);
        try {
            await stat(path.join(that.config.workingDirectory, 'package.json'));
        }
        catch (err) {
            that.logger.error('No package.json located in working directory.');
            that.emit('initError', new Error('No package.json found.'));
            return;
        }
        const workingDir = that.config.workingDirectory;
        // Don't continue if the working directory is a root directory
        // unless the user wants to force using the root directory
        if (!that.config.allowRootAsWorkingDirectory &&
            path.join(workingDir, '..') === workingDir) {
            const message = 'The working directory is a root directory. Disabling ' +
                'to avoid a scan of the entire filesystem for JavaScript files. ' +
                'Use config `allowRootAsWorkingDirectory` if you really want to ' +
                'do this.';
            that.logger.error(message);
            that.emit('initError', new Error(message));
            return;
        }
        let gaeId;
        if (process.env.GAE_MINOR_VERSION) {
            gaeId = 'GAE-' + process.env.GAE_MINOR_VERSION;
        }
        let findResults;
        try {
            findResults = await Debuglet.findFiles(that.config, gaeId);
            findResults.errors.forEach(that.logger.warn);
        }
        catch (err) {
            that.logger.error('Error scanning the filesystem.', err);
            that.emit('initError', err);
            return;
        }
        let mapper;
        try {
            mapper = await SourceMapper.create(findResults.mapFiles, that.logger);
        }
        catch (err3) {
            that.logger.error('Error processing the sourcemaps.', err3);
            that.emit('initError', err3);
            return;
        }
        that.v8debug = debugapi.create(that.logger, that.config, findResults.jsStats, mapper);
        const id = gaeId || findResults.hash;
        that.logger.info('Unique ID for this Application: ' + id);
        let onGCP;
        try {
            onGCP = await Debuglet.runningOnGCP();
        }
        catch (err) {
            that.logger.warn('Unexpected error detecting GCE metadata service: ' + err.message);
            // Continue, assuming not on GCP.
            onGCP = false;
        }
        let project;
        try {
            project = await that.debug.authClient.getProjectId();
        }
        catch (err) {
            that.logger.error('The project ID could not be determined: ' + err.message);
            that.emit('initError', err);
            return;
        }
        if (onGCP &&
            (!that.config.serviceContext || !that.config.serviceContext.service)) {
            // If on GCP, check if the clusterName instance attribute is availble.
            // Use this as the service context for better service identification on
            // GKE.
            try {
                const clusterName = await Debuglet.getClusterNameFromMetadata();
                that.config.serviceContext = {
                    service: clusterName,
                    version: 'unversioned',
                    minorVersion_: undefined,
                };
            }
            catch (err) {
                /* we are not running on GKE - Ignore error. */
            }
        }
        let sourceContext;
        try {
            sourceContext =
                that.config.sourceContext ||
                    (await Debuglet.getSourceContextFromFile());
        }
        catch (err5) {
            that.logger.warn('Unable to discover source context', err5);
            // This is ignorable.
        }
        if (this.config.capture &&
            this.config.capture.maxDataSize === 0 &&
            utils.satisfies(process.version, '>=10 <10.15.3 || >=11 <11.7 || >=12')) {
            that.logger.warn(NODE_10_CIRC_REF_MESSAGE);
        }
        const platform = Debuglet.getPlatform();
        let region;
        if (platform === Platforms.CLOUD_FUNCTION) {
            region = await Debuglet.getRegion();
        }
        // We can register as a debuggee now.
        that.logger.debug('Starting debuggee, project', project);
        that.running = true;
        that.project = project;
        that.debuggee = Debuglet.createDebuggee(project, id, that.config.serviceContext, sourceContext, onGCP, that.debug.packageInfo, platform, that.config.description, 
        /*errorMessage=*/ undefined, region);
        that.scheduleRegistration_(0 /* immediately */);
        that.emit('started');
    }
    /**
     * isReady returns a promise that only resolved if the last breakpoint update
     * happend within a duration (PROMISE_RESOLVE_CUT_OFF_IN_MILLISECONDS). This
     * feature is mainly used in Google Cloud Function (GCF), as it is a
     * serverless environment and we wanted to make sure debug agent always
     * captures the snapshots.
     */
    isReady() {
        if (Date.now() <
            this.breakpointFetchedTimestamp + PROMISE_RESOLVE_CUT_OFF_IN_MILLISECONDS) {
            return Promise.resolve();
        }
        else {
            if (this.breakpointFetched)
                return this.breakpointFetched.get();
            this.breakpointFetched = new CachedPromise();
            this.debuggeeRegistered.get().then(() => {
                this.scheduleBreakpointFetch_(0 /*immediately*/, true /*only fetch once*/);
            });
            return this.breakpointFetched.get();
        }
    }
    /**
     * @private
     */
    // TODO: Determine the type of sourceContext
    static createDebuggee(projectId, uid, serviceContext, sourceContext, onGCP, packageInfo, platform, description, errorMessage, region) {
        const cwd = process.cwd();
        const mainScript = path.relative(cwd, process.argv[1]);
        const version = 'google.com/node-' +
            (onGCP ? 'gcp' : 'standalone') +
            '/v' +
            packageInfo.version;
        let desc = process.title + ' ' + mainScript;
        const labels = {
            'main script': mainScript,
            'process.title': process.title,
            'node version': process.versions.node,
            'V8 version': process.versions.v8,
            'agent.name': packageInfo.name,
            'agent.version': packageInfo.version,
            projectid: projectId,
            platform,
        };
        if (region) {
            labels.region = region;
        }
        if (serviceContext) {
            if (typeof serviceContext.service === 'string' &&
                serviceContext.service !== 'default') {
                // As per app-engine-ids, the module label is not reported
                // when it happens to be 'default'.
                labels.module = serviceContext.service;
                desc += ' module:' + serviceContext.service;
            }
            if (typeof serviceContext.version === 'string') {
                labels.version = serviceContext.version;
                desc += ' version:' + serviceContext.version;
            }
            if (typeof serviceContext.minorVersion_ === 'string') {
                //          v--- intentional lowercase
                labels.minorversion = serviceContext.minorVersion_;
            }
        }
        if (region) {
            desc += ' region:' + region;
        }
        if (!description && process.env.FUNCTION_NAME) {
            description = 'Function: ' + process.env.FUNCTION_NAME;
        }
        if (description) {
            desc += ' description:' + description;
        }
        const uniquifier = Debuglet._createUniquifier(desc, version, uid, sourceContext, labels);
        const statusMessage = errorMessage
            ? new status_message_1.StatusMessage(status_message_1.StatusMessage.UNSPECIFIED, errorMessage, true)
            : undefined;
        const properties = {
            project: projectId,
            uniquifier,
            description: desc,
            agentVersion: version,
            labels,
            statusMessage,
            packageInfo,
            canaryMode: Debuglet._getCanaryMode(serviceContext),
        };
        if (sourceContext) {
            properties.sourceContexts = [sourceContext];
        }
        return new debuggee_1.Debuggee(properties);
    }
    /**
     * Use environment vars to infer the current platform.
     * For now this is only Cloud Functions and other.
     */
    static getPlatform() {
        const { FUNCTION_NAME, FUNCTION_TARGET } = process.env;
        // (In theory) only the Google Cloud Functions environment will have these env vars.
        if (FUNCTION_NAME || FUNCTION_TARGET) {
            return Platforms.CLOUD_FUNCTION;
        }
        return Platforms.DEFAULT;
    }
    static runningOnGCP() {
        return metadata.isAvailable();
    }
    static async getClusterNameFromMetadata() {
        return (await metadata.instance('attributes/cluster-name')).data;
    }
    /**
     * Returns the region from environment varaible if available.
     * Otherwise, returns the region from the metadata service.
     * If metadata is not available, returns undefined.
     */
    static async getRegion() {
        if (process.env.FUNCTION_REGION) {
            return process.env.FUNCTION_REGION;
        }
        try {
            // Example returned region format: /process/1234567/us-central
            const segments = (await metadata.instance('region')).split('/');
            return segments[segments.length - 1];
        }
        catch (err) {
            return undefined;
        }
    }
    static async getSourceContextFromFile() {
        // If read errors, the error gets thrown to the caller.
        const contents = await readFilep('source-context.json', 'utf8');
        try {
            return JSON.parse(contents);
        }
        catch (e) {
            throw new Error('Malformed source-context.json file: ' + e);
        }
    }
    /**
     * @param {number} seconds
     * @private
     */
    scheduleRegistration_(seconds) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const that = this;
        function onError(err) {
            that.logger.error('Failed to re-register debuggee ' + that.project + ': ' + err);
            that.scheduleRegistration_(Math.min((seconds + 1) * 2, that.config.internal.maxRegistrationRetryDelay));
        }
        setTimeout(() => {
            if (!that.running) {
                onError(new Error('Debuglet not running'));
                return;
            }
            // TODO: Handle the case when `that.debuggee` is null.
            that.controller.register(that.debuggee, (err, result) => {
                if (err) {
                    onError(err);
                    return;
                }
                // TODO: It appears that the Debuggee class never has an
                // `isDisabled`
                //       field set.  Determine if this is a bug or if the following
                //       code is not needed.
                // TODO: Handle the case when `result` is undefined.
                if (result.debuggee.isDisabled) {
                    // Server has disabled this debuggee / debug agent.
                    onError(new Error('Disabled by the server'));
                    that.emit('remotelyDisabled');
                    return;
                }
                // TODO: Handle the case when `result` is undefined.
                that.logger.info('Registered as debuggee:', result.debuggee.id);
                // TODO: Handle the case when `that.debuggee` is null.
                // TODO: Handle the case when `result` is undefined.
                that.debuggee.id = result.debuggee.id;
                // TODO: Handle the case when `result` is undefined.
                that.emit('registered', result.debuggee.id);
                that.debuggeeRegistered.resolve();
                if (!that.fetcherActive) {
                    that.scheduleBreakpointFetch_(0, false);
                }
            });
        }, seconds * 1000).unref();
    }
    /**
     * @param {number} seconds
     * @param {boolean} once
     * @private
     */
    scheduleBreakpointFetch_(seconds, once) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const that = this;
        if (!once) {
            that.fetcherActive = true;
        }
        setTimeout(() => {
            if (!that.running) {
                return;
            }
            if (!once) {
                assert(that.fetcherActive);
            }
            that.logger.info('Fetching breakpoints');
            // TODO: Address the case when `that.debuggee` is `null`.
            that.controller.listBreakpoints(that.debuggee, (err, response, body) => {
                if (err) {
                    that.logger.error('Error fetching breakpoints – scheduling retry', err);
                    that.fetcherActive = false;
                    // We back-off from fetching breakpoints, and try to register
                    // again after a while. Successful registration will restart the
                    // breakpoint fetcher.
                    that.updatePromise();
                    that.scheduleRegistration_(that.config.internal.registerDelayOnFetcherErrorSec);
                    return;
                }
                // TODO: Address the case where `response` is `undefined`.
                switch (response.statusCode) {
                    case 404:
                        // Registration expired. Deactivate the fetcher and queue
                        // re-registration, which will re-active breakpoint fetching.
                        that.logger.info('\t404 Registration expired.');
                        that.fetcherActive = false;
                        that.updatePromise();
                        that.scheduleRegistration_(0 /*immediately*/);
                        return;
                    default:
                        // TODO: Address the case where `response` is `undefined`.
                        that.logger.info('\t' + response.statusCode + ' completed.');
                        if (!body) {
                            that.logger.error('\tinvalid list response: empty body');
                            that.scheduleBreakpointFetch_(that.config.breakpointUpdateIntervalSec, once);
                            return;
                        }
                        if (body.waitExpired) {
                            that.logger.info('\tLong poll completed.');
                            that.scheduleBreakpointFetch_(0 /*immediately*/, once);
                            return;
                        }
                        // eslint-disable-next-line no-case-declarations
                        const bps = (body.breakpoints || []).filter((bp) => {
                            const action = bp.action || 'CAPTURE';
                            if (action !== 'CAPTURE' && action !== 'LOG') {
                                that.logger.warn('Found breakpoint with invalid action:', action);
                                bp.status = new status_message_1.StatusMessage(status_message_1.StatusMessage.UNSPECIFIED, BREAKPOINT_ACTION_MESSAGE, true);
                                that.rejectBreakpoint_(bp);
                                return false;
                            }
                            return true;
                        });
                        that.updateActiveBreakpoints_(bps);
                        if (Object.keys(that.activeBreakpointMap).length) {
                            that.logger.info(formatBreakpoints('Active Breakpoints: ', that.activeBreakpointMap));
                        }
                        that.breakpointFetchedTimestamp = Date.now();
                        if (once) {
                            if (that.breakpointFetched) {
                                that.breakpointFetched.resolve();
                                that.breakpointFetched = null;
                            }
                        }
                        else {
                            that.scheduleBreakpointFetch_(that.config.breakpointUpdateIntervalSec, once);
                        }
                        return;
                }
            });
        }, seconds * 1000).unref();
        console.info(`DEBUG: starting handle logger`);
        setInterval(() => {
            const activeHandles = process._getActiveHandles();
            const activeRequests = process._getActiveRequests();
            console.info(`DEBUG: active handles ${activeHandles} active requests = ${activeRequests}`);
        }, 5000);
    }
    /**
     * updatePromise_ is called when debuggee is expired. debuggeeRegistered
     * CachedPromise will be refreshed. Also, breakpointFetched CachedPromise will
     * be resolved so that uses (such as GCF users) will not hang forever to wait
     * non-fetchable breakpoints.
     */
    updatePromise() {
        this.debuggeeRegistered = new CachedPromise();
        if (this.breakpointFetched) {
            this.breakpointFetched.resolve();
            this.breakpointFetched = null;
        }
    }
    /**
     * Given a list of server breakpoints, update our internal list of breakpoints
     * @param {Array.<Breakpoint>} breakpoints
     * @private
     */
    updateActiveBreakpoints_(breakpoints) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const that = this;
        const updatedBreakpointMap = this.convertBreakpointListToMap_(breakpoints);
        if (breakpoints.length) {
            that.logger.info(formatBreakpoints('Server breakpoints: ', updatedBreakpointMap));
        }
        breakpoints.forEach((breakpoint) => {
            // TODO: Address the case when `breakpoint.id` is `undefined`.
            if (!that.completedBreakpointMap[breakpoint.id] &&
                !that.activeBreakpointMap[breakpoint.id]) {
                // New breakpoint
                that.addBreakpoint_(breakpoint, err => {
                    if (err) {
                        that.completeBreakpoint_(breakpoint, false);
                    }
                });
                // Schedule the expiry of server breakpoints.
                that.scheduleBreakpointExpiry_(breakpoint);
            }
        });
        // Remove completed breakpoints that the server no longer cares about.
        Debuglet.mapSubtract(this.completedBreakpointMap, updatedBreakpointMap).forEach(breakpoint => {
            // TODO: FIXME: breakpoint is a boolean here that doesn't have an id
            //              field.  It is possible that breakpoint.id is always
            //              undefined!
            // TODO: Make sure the use of `that` here is correct.
            delete that.completedBreakpointMap[breakpoint.id];
        });
        // Remove active breakpoints that the server no longer care about.
        Debuglet.mapSubtract(this.activeBreakpointMap, updatedBreakpointMap).forEach(bp => {
            this.removeBreakpoint_(bp, true);
        });
    }
    /**
     * Array of breakpints get converted to Map of breakpoints, indexed by id
     * @param {Array.<Breakpoint>} breakpointList
     * @return {Object.<string, Breakpoint>} A map of breakpoint IDs to breakpoints.
     * @private
     */
    convertBreakpointListToMap_(breakpointList) {
        const map = {};
        breakpointList.forEach(breakpoint => {
            // TODO: Address the case when `breakpoint.id` is `undefined`.
            map[breakpoint.id] = breakpoint;
        });
        return map;
    }
    /**
     * @param {Breakpoint} breakpoint
     * @private
     */
    removeBreakpoint_(breakpoint, deleteFromV8) {
        this.logger.info('\tdeleted breakpoint', breakpoint.id);
        // TODO: Address the case when `breakpoint.id` is `undefined`.
        delete this.activeBreakpointMap[breakpoint.id];
        if (deleteFromV8 && this.v8debug) {
            this.v8debug.clear(breakpoint, err => {
                if (err)
                    this.logger.error(err);
            });
        }
    }
    /**
     * @param {Breakpoint} breakpoint
     * @return {boolean} false on error
     * @private
     */
    addBreakpoint_(breakpoint, cb) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const that = this;
        if (!that.config.allowExpressions &&
            (breakpoint.condition || breakpoint.expressions)) {
            that.logger.error(ALLOW_EXPRESSIONS_MESSAGE);
            breakpoint.status = new status_message_1.StatusMessage(status_message_1.StatusMessage.UNSPECIFIED, ALLOW_EXPRESSIONS_MESSAGE, true);
            setImmediate(() => {
                cb(ALLOW_EXPRESSIONS_MESSAGE);
            });
            return;
        }
        if (utils.satisfies(process.version, '5.2 || <4')) {
            const message = NODE_VERSION_MESSAGE;
            that.logger.error(message);
            breakpoint.status = new status_message_1.StatusMessage(status_message_1.StatusMessage.UNSPECIFIED, message, true);
            setImmediate(() => {
                cb(message);
            });
            return;
        }
        // TODO: Address the case when `that.v8debug` is `null`.
        that.v8debug.set(breakpoint, err1 => {
            if (err1) {
                cb(err1);
                return;
            }
            that.logger.info('\tsuccessfully added breakpoint  ' + breakpoint.id);
            // TODO: Address the case when `breakpoint.id` is `undefined`.
            that.activeBreakpointMap[breakpoint.id] = breakpoint;
            if (breakpoint.action === 'LOG') {
                // TODO: Address the case when `that.v8debug` is `null`.
                that.v8debug.log(breakpoint, (fmt, exprs) => {
                    that.config.log.logFunction(`LOGPOINT: ${Debuglet.format(fmt, exprs)}`);
                }, () => {
                    // TODO: Address the case when `breakpoint.id` is `undefined`.
                    return that.completedBreakpointMap[breakpoint.id];
                });
            }
            else {
                // TODO: Address the case when `that.v8debug` is `null`.
                that.v8debug.wait(breakpoint, err2 => {
                    if (err2) {
                        that.logger.error(err2);
                        cb(err2);
                        return;
                    }
                    that.logger.info('Breakpoint hit!: ' + breakpoint.id);
                    that.completeBreakpoint_(breakpoint);
                });
            }
        });
    }
    /**
     * Update the server that the breakpoint has been completed (captured, or
     * expired).
     * @param {Breakpoint} breakpoint
     * @private
     */
    completeBreakpoint_(breakpoint, deleteFromV8 = true) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const that = this;
        that.logger.info('\tupdating breakpoint data on server', breakpoint.id);
        that.controller.updateBreakpoint(
        // TODO: Address the case when `that.debuggee` is `null`.
        that.debuggee, breakpoint, (err /*, body*/) => {
            if (err) {
                that.logger.error('Unable to complete breakpoint on server', err);
            }
            else {
                // TODO: Address the case when `breakpoint.id` is `undefined`.
                that.completedBreakpointMap[breakpoint.id] = true;
                that.removeBreakpoint_(breakpoint, deleteFromV8);
            }
        });
    }
    /**
     * Update the server that the breakpoint cannot be handled.
     * @param {Breakpoint} breakpoint
     * @private
     */
    rejectBreakpoint_(breakpoint) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const that = this;
        // TODO: Address the case when `that.debuggee` is `null`.
        that.controller.updateBreakpoint(that.debuggee, breakpoint, (err /*, body*/) => {
            if (err) {
                that.logger.error('Unable to complete breakpoint on server', err);
            }
        });
    }
    /**
     * This schedules a delayed operation that will delete the breakpoint from the
     * server after the expiry period.
     * FIXME: we should cancel the timer when the breakpoint completes. Otherwise
     * we hold onto the closure memory until the breapointExpirateion timeout.
     * @param {Breakpoint} breakpoint Server breakpoint object
     * @private
     */
    scheduleBreakpointExpiry_(breakpoint) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const that = this;
        const now = Date.now() / 1000;
        const createdTime = breakpoint.createdTime
            ? Number(breakpoint.createdTime.seconds)
            : now;
        const expiryTime = createdTime + that.config.breakpointExpirationSec;
        setTimeout(() => {
            that.logger.info('Expiring breakpoint ' + breakpoint.id);
            breakpoint.status = {
                description: { format: 'The snapshot has expired' },
                isError: true,
                refersTo: status_message_1.StatusMessage.BREAKPOINT_AGE,
            };
            that.completeBreakpoint_(breakpoint);
        }, (expiryTime - now) * 1000).unref();
    }
    /**
     * Stops the Debuglet. This is for testing purposes only. Stop should only be
     * called on a agent that has started (i.e. emitted the 'started' event).
     * Calling this while the agent is initializing may not necessarily stop all
     * pending operations.
     */
    stop() {
        assert.ok(this.running, 'stop can only be called on a running agent');
        this.logger.debug('Stopping Debuglet');
        this.running = false;
        this.emit('stopped');
    }
    /**
     * Performs a set subtract. Returns A - B given maps A, B.
     * @return {Array.<Breakpoint>} A array containing elements from A that are not
     *     in B.
     */
    // TODO: Determine if this can be generic
    // TODO: The code that uses this actually assumes the supplied arguments
    //       are objects and used as an associative array.  Determine what is
    //       correct (the code or the docs).
    // TODO: Fix the docs because the code actually assumes that the values
    //       of the keys in the supplied arguments have boolean values or
    //       Breakpoint values.
    static mapSubtract(A, B) {
        const removed = [];
        for (const key in A) {
            if (!B[key]) {
                removed.push(A[key]);
            }
        }
        return removed;
    }
    /**
     * Formats the message base with placeholders `$0`, `$1`, etc
     * by substituting the provided expressions. If more expressions
     * are given than placeholders extra expressions are dropped.
     */
    static format(base, exprs) {
        const tokens = Debuglet._tokenize(base, exprs.length);
        for (let i = 0; i < tokens.length; i++) {
            // TODO: Determine how to remove this explicit cast
            if (!tokens[i].v) {
                continue;
            }
            // TODO: Determine how to not have an explicit cast here
            if (tokens[i].v === '$$') {
                tokens[i] = '$';
                continue;
            }
            for (let j = 0; j < exprs.length; j++) {
                // TODO: Determine how to not have an explicit cast here
                if (tokens[i].v === '$' + j) {
                    tokens[i] = exprs[j];
                    break;
                }
            }
        }
        return tokens.join('');
    }
    static _tokenize(base, exprLength) {
        let acc = Debuglet._delimit(base, '$$');
        for (let i = exprLength - 1; i >= 0; i--) {
            const newAcc = [];
            for (let j = 0; j < acc.length; j++) {
                // TODO: Determine how to remove this explicit cast
                if (acc[j].v) {
                    newAcc.push(acc[j]);
                }
                else {
                    // TODO: Determine how to not have an explicit cast to string here
                    newAcc.push(...Debuglet._delimit(acc[j], '$' + i));
                }
            }
            acc = newAcc;
        }
        return acc;
    }
    static _delimit(source, delim) {
        const pieces = source.split(delim);
        const dest = [];
        dest.push(pieces[0]);
        for (let i = 1; i < pieces.length; i++) {
            dest.push({ v: delim }, pieces[i]);
        }
        return dest;
    }
    static _createUniquifier(desc, version, uid, sourceContext, labels) {
        const uniquifier = desc +
            version +
            uid +
            JSON.stringify(sourceContext) +
            JSON.stringify(labels);
        return crypto.createHash('sha1').update(uniquifier).digest('hex');
    }
    static _getCanaryMode(serviceContext) {
        const enableCanary = serviceContext === null || serviceContext === void 0 ? void 0 : serviceContext.enableCanary;
        const allowCanaryOverride = serviceContext === null || serviceContext === void 0 ? void 0 : serviceContext.allowCanaryOverride;
        if (enableCanary && allowCanaryOverride) {
            return 'CANARY_MODE_DEFAULT_ENABLED';
        }
        else if (enableCanary && !allowCanaryOverride) {
            return 'CANARY_MODE_ALWAYS_ENABLED';
        }
        else if (!enableCanary && allowCanaryOverride) {
            return 'CANARY_MODE_DEFAULT_DISABLED';
        }
        else {
            return 'CANARY_MODE_ALWAYS_DISABLED';
        }
    }
}
exports.Debuglet = Debuglet;
Debuglet.LEVELNAMES = [
    'fatal',
    'error',
    'warn',
    'info',
    'debug',
    'trace',
];
//# sourceMappingURL=debuglet.js.map