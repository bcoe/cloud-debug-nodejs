import { DebugAgentConfig, StackdriverConfig } from './agent/config';
import { Debuglet, IsReady } from './agent/debuglet';
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
export declare function start(options?: DebugAgentConfig | StackdriverConfig): Debuglet | IsReady;
export declare function get(): Debuglet | undefined;
