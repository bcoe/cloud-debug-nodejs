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
exports.V8Inspector = void 0;
class V8Inspector {
    constructor(session) {
        this.session = session;
    }
    setBreakpointByUrl(options) {
        const result = {};
        this.session.post('Debugger.setBreakpointByUrl', options, (error, response) => {
            if (error)
                result.error = error;
            result.response = response;
        });
        return result;
    }
    removeBreakpoint(breakpointId) {
        const result = {};
        this.session.post('Debugger.removeBreakpoint', { breakpointId }, (error) => {
            if (error)
                result.error = error;
        });
        return result;
    }
    evaluateOnCallFrame(options) {
        const result = {};
        this.session.post('Debugger.evaluateOnCallFrame', options, (error, response) => {
            if (error)
                result.error = error;
            result.response = response;
        });
        return result;
    }
    getProperties(options) {
        const result = {};
        this.session.post('Runtime.getProperties', options, (error, response) => {
            if (error)
                result.error = error;
            result.response = response;
        });
        return result;
    }
}
exports.V8Inspector = V8Inspector;
//# sourceMappingURL=v8inspector.js.map