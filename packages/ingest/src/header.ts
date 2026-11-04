// SUBJECT COMPANY CIK from an EDGAR filing header. The .hdr.sgml file tags
// it <SUBJECT-COMPANY> ... <CIK>; the -index-headers.html page spells it
// "SUBJECT COMPANY:" ... "CENTRAL INDEX KEY:".
export function headerSubject(text: string): string | null {
  const block = text.split(/<SUBJECT-COMPANY>|SUBJECT COMPANY:/)[1];
  return block?.match(/(?:<CIK>|CENTRAL INDEX KEY:\s*)(\d{10})/)?.[1] ?? null;
}
