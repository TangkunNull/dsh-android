/**
 * Host-side ApiProxy implementation. Signature discipline: unary takes the
 * narrow RpcRequest<P> and echoes request.rpcId on the RpcResponse<T>.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ModelSelection } from '@deepseek-ai/dsh-agent';
import type { ApiProxy } from './api/index.ts';
/** Resolved Agent model and project-directory defaults consumed by the API implementation. */
export interface ApiProxyDefaults {
    /**
     * The model selection a session starts from when its own log names none. Read on
     * every access rather than captured, so a default saved during this process
     * reaches the sessions that have not run a turn yet.
     */
    defaultModelSelection: () => ModelSelection;
    /**
     * Record a selection as the new default. Either absent, or a closure that
     * may itself decline — the gateway plugin always passes one, and it no-ops
     * when the deployment mounts no settings provider or when the write races
     * service teardown. A switch then stays process-local. A rejection is
     * reported and swallowed: the switch already applies to its own session,
     * and undoing it because storage failed would be the worse outcome.
     */
    saveDefaultModelSelection?: (selection: ModelSelection) => Promise<void>;
    /** Default project directory for new sessions whose create request carries no cwd. */
    cwd: string;
    /** Native open-with-default-application; injectable for carrier tests. */
    openPath?: (path: string, signal: AbortSignal) => Promise<void>;
    /** Native text-editor handoff; injectable for settings-document tests. */
    openTextFile?: (path: string, signal: AbortSignal) => Promise<void>;
    /**
     * Whether handing a path to the native opener can work at all — the
     * `hasDocument` capability the preset roster reports, and the switch
     * between opening a preset directory and answering its path as text.
     * Absent, an injected `openPath` counts as openable and everything else
     * falls back to platform detection ({@link canOpenNativePath}).
     */
    canOpenPath?: () => boolean;
}
/**
 * Implement ApiProxy over a composed host context.
 * @param ctx - a context with the Host spine and Workspace registry mounted.
 * @param defaults - Agent model and project-directory defaults.
 * @returns the ApiProxy implementation.
 */
export declare function createApiProxy(ctx: Context, defaults: ApiProxyDefaults): ApiProxy;
//# sourceMappingURL=api-proxy.d.ts.map