import { handle } from "hono/vercel";
import { app } from "@mismanagement/api";

const handler = handle(app);
export { handler as GET };
