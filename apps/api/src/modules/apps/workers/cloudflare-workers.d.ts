// SPDX-License-Identifier: FSL-1.1-ALv2
// The one piece of `cloudflare:workers` worker-entry.ts uses. The module is
// provided by the Workers runtime and stays external in the Worker build.
declare module "cloudflare:workers" {
  export abstract class WorkerEntrypoint<Env = unknown> {
    protected ctx: unknown
    protected env: Env
    constructor(ctx: unknown, env: Env)
  }
}
