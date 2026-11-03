// Server-side reads go through the Hono app in-process (no HTTP hop): the
// same handlers serve /api/* to the browser via app/api/[...path]/route.ts.
import "server-only";
import { app } from "@takeover/api";

export async function api<T>(path: string): Promise<T> {
  const res = await app.request(`/api${path}`);
  if (!res.ok) throw new Error(`api ${path}: ${res.status}`);
  return (await res.json()) as T;
}
