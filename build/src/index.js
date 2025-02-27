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
exports.get = exports.start = void 0;
const debuglet_1 = require("./agent/debuglet");
const debug_1 = require("./client/stackdriver/debug");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pjson = require('../../package.json');
// Singleton.
let debuglet;
/**
 * Start the Debug agent that will make your application available for debugging
 * with Stackdriver Debug.
 *
 * @param options - Authentication and agent configuration.
 *
 * @resource [Introductory video]{@link
 * https://www.youtube.com/watch?v=tyHcK_kAOpw}
 *
 * @example
 * ```
 * debug.startAgent();
 * ```
 */
function start(options) {
    options = options || {};
    const agentConfig = mergeConfigs(options);
    // forceNewAgent_ is for testing purposes only.
    if (debuglet && !agentConfig.forceNewAgent_) {
        throw new Error('Debug Agent has already been started');
    }
    const debug = new debug_1.Debug(options, pjson);
    debuglet = new debuglet_1.Debuglet(debug, agentConfig);
    debuglet.start();
    return agentConfig.testMode_ ? debuglet : debuglet.isReadyManager;
}
exports.start = start;
/**
 * If the given `options` object has a `debug` property
 * of the same type, this function returns the union of the
 * properties in `options.debug` and `options` except that
 * the returned object no longer has a `debug` property.
 * If a field exists in both `options` and `options.debug`,
 * the value in `option.debug` takes precedence.
 */
function mergeConfigs(options) {
    if (!options.debug) {
        return options;
    }
    const result = Object.assign({}, options);
    delete result.debug;
    return Object.assign(result, options.debug);
}
/* Used to access the agent if it has been started.  Returns the agent
 * if the agent has been started.  Otherwise, `undefined` is returned.
 */
function get() {
    return debuglet;
}
exports.get = get;
//# sourceMappingURL=index.js.map