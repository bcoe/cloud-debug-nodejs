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
exports.Controller = void 0;
/*!
 * @module debug/controller
 */
const common_1 = require("@google-cloud/common");
const assert = require("assert");
const qs = require("querystring");
const url_1 = require("url");
class Controller extends common_1.ServiceObject {
    /**
     * @constructor
     */
    constructor(debug, config) {
        super({ parent: debug, baseUrl: '/controller' });
        /** @private {string} */
        this.nextWaitToken = null;
        this.agentId = null;
        this.apiUrl = `https://${debug.apiEndpoint}/v2/controller`;
        if (config && config.apiUrl) {
            this.apiUrl = config.apiUrl + new url_1.URL(this.apiUrl).pathname;
        }
    }
    /**
     * Register to the API (implementation)
     *
     * @param {!function(?Error,Object=)} callback
     * @private
     */
    register(debuggee, callback) {
        const options = {
            uri: this.apiUrl + '/debuggees/register',
            method: 'POST',
            json: true,
            body: { debuggee },
        };
        this.request(options, (err, body, response) => {
            if (err) {
                callback(err);
            }
            else if (response.statusCode !== 200) {
                callback(new Error('unable to register, statusCode ' + response.statusCode));
            }
            else if (!body.debuggee) {
                callback(new Error('invalid response body from server'));
            }
            else {
                debuggee.id = body.debuggee.id;
                this.agentId = body.agentId;
                callback(null, body);
            }
        });
    }
    /**
     * Fetch the list of breakpoints from the server. Assumes we have registered.
     * @param {!function(?Error,Object=,Object=)} callback accepting (err, response,
     * body)
     */
    listBreakpoints(debuggee, callback) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const that = this;
        assert(debuggee.id, 'should have a registered debuggee');
        const query = { successOnTimeout: true };
        if (that.nextWaitToken) {
            query.waitToken = that.nextWaitToken;
        }
        if (that.agentId) {
            query.agentId = that.agentId;
        }
        const uri = this.apiUrl +
            '/debuggees/' +
            encodeURIComponent(debuggee.id) +
            '/breakpoints?' +
            qs.stringify(query);
        that.request({ uri, json: true }, (err, body, response) => {
            if (!response) {
                callback(err || new Error('unknown error - request response missing'));
                return;
            }
            else if (response.statusCode === 404) {
                // The v2 API returns 404 (google.rpc.Code.NOT_FOUND) when the agent
                // registration expires. We should re-register.
                callback(null, response);
                return;
            }
            else if (response.statusCode !== 200) {
                callback(new Error('unable to list breakpoints, status code ' + response.statusCode));
                return;
            }
            else {
                body = body || {};
                that.nextWaitToken = body.nextWaitToken;
                callback(null, response, body);
            }
        });
    }
    /**
     * Update the server about breakpoint state
     * @param {!Debuggee} debuggee
     * @param {!Breakpoint} breakpoint
     * @param {!Function} callback accepting (err, body)
     */
    updateBreakpoint(debuggee, breakpoint, callback) {
        assert(debuggee.id, 'should have a registered debuggee');
        breakpoint.action = 'CAPTURE';
        breakpoint.isFinalState = true;
        const options = {
            uri: this.apiUrl +
                '/debuggees/' +
                encodeURIComponent(debuggee.id) +
                // TODO: Address the case where `breakpoint.id` is `undefined`.
                '/breakpoints/' +
                encodeURIComponent(breakpoint.id),
            json: true,
            method: 'PUT',
            body: { debuggeeId: debuggee.id, breakpoint },
        };
        // We need to have a try/catch here because a JSON.stringify will be done
        // by request. Some V8 debug mirror objects get a throw when we attempt to
        // stringify them. The try-catch keeps it resilient and avoids crashing the
        // user's app.
        try {
            this.request(options, (err, body /*, response */) => {
                callback(err, body);
            });
        }
        catch (error) {
            callback(error);
        }
    }
}
exports.Controller = Controller;
//# sourceMappingURL=controller.js.map