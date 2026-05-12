// Vercel Edge handler. Pulls hono's vercel adapter from this package's own
// deps (api/[[...path]].ts at the repo root has no node_modules since it
// isn't a workspace member, so the import has to live here).
import { handle } from "hono/vercel";
import { app } from "./index.js";

export default handle(app);
