// Vercel Edge entry. Thin shim: the actual handler (and its hono/vercel
// import) lives in apps/api/src/edge.ts because that package has hono
// in its deps. This file only sets the runtime config and re-exports.
//
// Edge runtime is required: the Neon serverless driver tunnels Postgres
// over WebSockets, which is built into V8 isolates but flaky elsewhere.

import handler from "../apps/api/src/edge.js";

export const config = { runtime: "edge" };
export default handler;
