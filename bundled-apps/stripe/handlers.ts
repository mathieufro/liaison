// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Handler bundle entrypoint. Bun.build resolves this at freeze time; every
// export the manifest references must be re-exported by name from src/handlers.
export * from "./src/handlers"
