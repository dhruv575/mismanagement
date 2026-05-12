// One-shot remediation for Form 4 rows missing insider_name. The old parser
// silently dropped the reporting-owner fields when fast-xml-parser returned
// an array (multi-co-filer filings). The parser fix in pull-form4.ts now
// merges multiple owners; this script:
//   1. Finds accession_numbers with at least one empty-name row.
//   2. Deletes their rows so the not-exists filter re-claims them.
//   3. Invokes pull-form4 with --since= broad enough to catch them.
import { spawn } from "node:child_process";
import { pool } from "../packages/ingest/src/db.js";

function runForeground(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit", shell: true });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  });
}

async function main(): Promise<void> {
  const r = await pool.query<{ accession_number: string; min_date: string }>(
    `select accession_number, min(filed_at)::text as min_date
     from insider_transactions
     where insider_name is null or insider_name = ''
     group by accession_number`,
  );
  console.log(`${r.rows.length} affected accessions`);
  if (r.rows.length === 0) {
    await pool.end();
    return;
  }
  const minDate = r.rows
    .map((row) => row.min_date)
    .filter((d) => !!d)
    .sort()[0]!;
  console.log(`min filing date: ${minDate}`);

  // Bulk delete in one statement.
  const accns = r.rows.map((row) => row.accession_number);
  const del = await pool.query(
    `delete from insider_transactions where accession_number = any($1::text[])`,
    [accns],
  );
  console.log(`deleted ${del.rowCount} rows; will re-fetch via pull-form4 --since=${minDate}`);

  await pool.end();
  await runForeground("pnpm", [
    "--filter", "@activist/ingest", "exec",
    "tsx", "src/pull-form4.ts",
    `--since=${minDate}`,
    "--concurrency=8",
  ]);
}
main().catch((e) => { console.error(e); process.exit(1); });
