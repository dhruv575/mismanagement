// Same env loading rules as the ingest package, but only the variables the
// API actually uses at request time. Edge runtimes don't read .env at boot --
// Vercel injects vars from the project settings. Local dev uses dotenv via
// dev.ts.
export function getDatabaseUrl(): string {
  const v = process.env.DATABASE_URL;
  if (!v) throw new Error("DATABASE_URL not set");
  return v;
}
