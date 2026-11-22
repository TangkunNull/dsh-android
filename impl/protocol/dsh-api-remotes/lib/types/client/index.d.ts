/** Platform-neutral assembly of generated Host Remote contributions. */
import type { Context } from '@deepseek-ai/cordis';
import type { TypeRTClientRemote } from '@deepseek-ai/dsh-type-meta';
export type { TypeRTClientRemote as ClientRemote } from '@deepseek-ai/dsh-type-meta';
export type {} from '@deepseek-ai/dsh-goal/remote';
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Generated Remote namespaces selected by this Client assembly. */
        remote: TypeRTClientRemote;
    }
}
/** Required service: the typed Client Remote contribution mount. */
export declare const inject: string[];
/**
 * Mount the Host capabilities explicitly selected for this Client assembly.
 * @param ctx - Client Cordis root carrying the typed API service.
 * @returns disposer after every selected Remote namespace is ready.
 */
export declare function apply(ctx: Context): Promise<() => Promise<void>>;
//# sourceMappingURL=index.d.ts.map