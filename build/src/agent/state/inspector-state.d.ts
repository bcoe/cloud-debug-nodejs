/// <reference types="node" />
import * as inspector from 'inspector';
import * as stackdriver from '../../types/stackdriver';
import { ResolvedDebugAgentConfig } from '../config';
import { V8Inspector } from '../v8/v8inspector';
/**
 * Checks that the provided expressions will not have side effects and
 * then evaluates the expression in the current execution context.
 *
 * @return an object with error and mirror fields.
 */
export declare function evaluate(expression: string, frame: inspector.Debugger.CallFrame, v8inspector: V8Inspector, returnByValue: boolean): {
    error: string | null;
    object?: inspector.Runtime.RemoteObject;
};
export declare function testAssert(): void;
/**
 * Captures the stack and current execution state.
 *
 * @return an object with stackFrames, variableTable, and
 *         evaluatedExpressions fields
 */
export declare function capture(callFrames: inspector.Debugger.CallFrame[], breakpoint: stackdriver.Breakpoint, config: ResolvedDebugAgentConfig, scriptmapper: {
    [id: string]: {
        url: string;
    };
}, v8Inspector: V8Inspector): stackdriver.Breakpoint;
