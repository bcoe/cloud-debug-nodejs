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
exports.create = exports.MODULE_WRAP_PREFIX_LENGTH = exports.willUseInspector = void 0;
const utils = require("../util/utils");
let debugApiConstructor;
function willUseInspector(nodeVersion) {
    // checking for null and undefined.
    // eslint-disable-next-line eqeqeq
    const version = nodeVersion != null ? nodeVersion : process.version;
    return utils.satisfies(version, '>=10');
}
exports.willUseInspector = willUseInspector;
if (willUseInspector()) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const inspectorapi = require('./inspector-debugapi');
    debugApiConstructor = inspectorapi.InspectorDebugApi;
}
else {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const v8debugapi = require('./legacy-debugapi');
    debugApiConstructor = v8debugapi.V8DebugApi;
}
exports.MODULE_WRAP_PREFIX_LENGTH = require('module')
    .wrap('☃')
    .indexOf('☃');
let singleton;
function create(logger, config, jsFiles, sourcemapper) {
    if (singleton && !config.forceNewAgent_) {
        return singleton;
    }
    else if (singleton) {
        singleton.disconnect();
    }
    singleton = new debugApiConstructor(logger, config, jsFiles, sourcemapper);
    return singleton;
}
exports.create = create;
//# sourceMappingURL=debugapi.js.map