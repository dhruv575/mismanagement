import { handle } from "hono/vercel";
import { app } from "@takeover/api";

const handler = handle(app);
export { handler as GET };
