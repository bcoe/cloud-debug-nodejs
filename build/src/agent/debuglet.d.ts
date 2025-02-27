/// <reference types="node" />
import { EventEmitter } from 'events';
import { Debug, PackageInfo } from '../client/stackdriver/debug';
import { CanaryMode, Debuggee } from '../debuggee';
import * as stackdriver from '../types/stackdriver';
import { DebugAgentConfig, Logger, LogLevel, ResolvedDebugAgentConfig } from './config';
import * as scanner from './io/scanner';
interface SourceContext {
    [key: string]: string;
}
/**
 * Environments that this system might be running in.
 * Helps provide platform-specific information and integration.
 */
export declare enum Platforms {
    /** Google Cloud Functions */
    CLOUD_FUNCTION = "cloud_function",
    /** Any other platform. */
    DEFAULT = "default"
}
/**
 * CachedPromise stores a promise. This promise can be resolved by calling
 * function resolve() and can only be resolved once.
 */
export declare class CachedPromise {
    private promiseResolve;
    private promise;
    get(): Promise<void>;
    resolve(): void;
}
/**
 * IsReady will return a promise to user after user starting the debug agent.
 * This promise will be resolved when one of the following is true:
 * 1. Time since last listBreakpoint was within a heuristic time.
 * 2. listBreakpoint completed successfully.
 * 3. Debuggee registration expired or failed, listBreakpoint cannot be
 *    completed.
 */
export interface IsReady {
    isReady(): Promise<void>;
}
export interface FindFilesResult {
    jsStats: scanner.ScanStats;
    mapFiles: string[];
    errors: Map<string, Error>;
    hash: string;
}
export declare class Debuglet extends EventEmitter {
    private debug;
    private v8debug;
    private running;
    private project;
    private controller;
    private completedBreakpointMap;
    private breakpointFetchedTimestamp;
    private breakpointFetched;
    private debuggeeRegistered;
    isReadyManager: IsReady;
    config: ResolvedDebugAgentConfig;
    fetcherActive: boolean;
    logger: Logger;
    debuggee: Debuggee | null;
    activeBreakpointMap: {
        [key: string]: stackdriver.Breakpoint;
    };
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
    constructor(debug: Debug, config: DebugAgentConfig);
    static LEVELNAMES: LogLevel[];
    static logLevelToName(level: number): LogLevel;
    static normalizeConfig_(config: DebugAgentConfig): ResolvedDebugAgentConfig;
    static buildRegExp(fileExtensions: string[]): RegExp;
    static findFiles(config: ResolvedDebugAgentConfig, precomputedHash?: string): Promise<FindFilesResult>;
    /**
     * Starts the Debuglet. It is important that this is as quick as possible
     * as it is on the critical path of application startup.
     * @private
     */
    start(): Promise<void>;
    /**
     * isReady returns a promise that only resolved if the last breakpoint update
     * happend within a duration (PROMISE_RESOLVE_CUT_OFF_IN_MILLISECONDS). This
     * feature is mainly used in Google Cloud Function (GCF), as it is a
     * serverless environment and we wanted to make sure debug agent always
     * captures the snapshots.
     */
    isReady(): Promise<void>;
    /**
     * @private
     */
    static createDebuggee(projectId: string, uid: string, serviceContext: {
        service?: string;
        version?: string;
        minorVersion_?: string;
        enableCanary?: boolean;
        allowCanaryOverride?: boolean;
    }, sourceContext: SourceContext | undefined, onGCP: boolean, packageInfo: PackageInfo, platform: string, description?: string, errorMessage?: string, region?: string): Debuggee;
    /**
     * Use environment vars to infer the current platform.
     * For now this is only Cloud Functions and other.
     */
    static getPlatform(): Platforms;
    static runningOnGCP(): Promise<boolean>;
    static getClusterNameFromMetadata(): Promise<string>;
    /**
     * Returns the region from environment varaible if available.
     * Otherwise, returns the region from the metadata service.
     * If metadata is not available, returns undefined.
     */
    static getRegion(): Promise<string | undefined>;
    static getSourceContextFromFile(): Promise<SourceContext>;
    /**
     * @param {number} seconds
     * @private
     */
    scheduleRegistration_(seconds: number): void;
    /**
     * @param {number} seconds
     * @param {boolean} once
     * @private
     */
    scheduleBreakpointFetch_(seconds: number, once: boolean): void;
    /**
     * updatePromise_ is called when debuggee is expired. debuggeeRegistered
     * CachedPromise will be refreshed. Also, breakpointFetched CachedPromise will
     * be resolved so that uses (such as GCF users) will not hang forever to wait
     * non-fetchable breakpoints.
     */
    private updatePromise;
    /**
     * Given a list of server breakpoints, update our internal list of breakpoints
     * @param {Array.<Breakpoint>} breakpoints
     * @private
     */
    updateActiveBreakpoints_(breakpoints: stackdriver.Breakpoint[]): void;
    /**
     * Array of breakpints get converted to Map of breakpoints, indexed by id
     * @param {Array.<Breakpoint>} breakpointList
     * @return {Object.<string, Breakpoint>} A map of breakpoint IDs to breakpoints.
     * @private
     */
    convertBreakpointListToMap_(breakpointList: stackdriver.Breakpoint[]): {
        [key: string]: stackdriver.Breakpoint;
    };
    /**
     * @param {Breakpoint} breakpoint
     * @private
     */
    removeBreakpoint_(breakpoint: stackdriver.Breakpoint, deleteFromV8: boolean): void;
    /**
     * @param {Breakpoint} breakpoint
     * @return {boolean} false on error
     * @private
     */
    addBreakpoint_(breakpoint: stackdriver.Breakpoint, cb: (ob: Error | string) => void): void;
    /**
     * Update the server that the breakpoint has been completed (captured, or
     * expired).
     * @param {Breakpoint} breakpoint
     * @private
     */
    completeBreakpoint_(breakpoint: stackdriver.Breakpoint, deleteFromV8?: boolean): void;
    /**
     * Update the server that the breakpoint cannot be handled.
     * @param {Breakpoint} breakpoint
     * @private
     */
    rejectBreakpoint_(breakpoint: stackdriver.Breakpoint): void;
    /**
     * This schedules a delayed operation that will delete the breakpoint from the
     * server after the expiry period.
     * FIXME: we should cancel the timer when the breakpoint completes. Otherwise
     * we hold onto the closure memory until the breapointExpirateion timeout.
     * @param {Breakpoint} breakpoint Server breakpoint object
     * @private
     */
    scheduleBreakpointExpiry_(breakpoint: stackdriver.Breakpoint): void;
    /**
     * Stops the Debuglet. This is for testing purposes only. Stop should only be
     * called on a agent that has started (i.e. emitted the 'started' event).
     * Calling this while the agent is initializing may not necessarily stop all
     * pending operations.
     */
    stop(): void;
    /**
     * Performs a set subtract. Returns A - B given maps A, B.
     * @return {Array.<Breakpoint>} A array containing elements from A that are not
     *     in B.
     */
    static mapSubtract<T, U>(A: {
        [key: string]: T;
    }, B: {
        [key: string]: U;
    }): T[];
    /**
     * Formats the message base with placeholders `$0`, `$1`, etc
     * by substituting the provided expressions. If more expressions
     * are given than placeholders extra expressions are dropped.
     */
    static format(base: string, exprs: string[]): string;
    static _tokenize(base: string, exprLength: number): Array<{
        v: string;
    } | string>;
    static _delimit(source: string, delim: string): Array<{
        v: string;
    } | string>;
    static _createUniquifier(desc: string, version: string, uid: string, sourceContext: SourceContext | undefined, labels: {
        [key: string]: string;
    }): string;
    static _getCanaryMode(serviceContext: {
        enableCanary?: boolean;
        allowCanaryOverride?: boolean;
    }): CanaryMode;
}
export {};
