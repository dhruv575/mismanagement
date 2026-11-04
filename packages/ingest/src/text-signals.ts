// Text measures read from a 10-K, shared by pull-deals (current universe)
// and pull-backtest-text (historical sample) so both count the same way.

export const AI_TERMS = /\b(artificial intelligence|generative AI|AI|machine learning|large language models?|automation)\b/g;
export const HEADCOUNT =
  /(?:approximately|about|over|more than|nearly)?\s*([\d,]{3,9})\s+(?:full[- ]time(?:[- ]equivalent)?\s+|global\s+)?(?:employees|team members|associates|colleagues|people)/i;

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&#822[01];|&[lr]dquo;/g, '"')
    // Accented letters in company names (Gesellschaft f&uuml;r ...).
    .replace(/&([aeiouAEIOU])(uml|acute|grave|circ);/g, (_, ch: string, kind: string) =>
      ch.normalize("NFD") + ({ uml: "̈", acute: "́", grave: "̀", circ: "̂" } as Record<string, string>)[kind]!)
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&")
    .normalize("NFC")
    .replace(/\s+/g, " ");
}

/** Word count, AI/automation term count, and the first stated headcount
 *  (null when no match, or under 10, which is usually an unrelated "100 people"). */
export function measure10K(text: string): { words: number; aiCount: number; employees: number | null; matched: string | null } {
  const m = text.match(HEADCOUNT);
  const employees = m ? Number(m[1]!.replace(/,/g, "")) : NaN;
  const ok = Number.isFinite(employees) && employees >= 10;
  return {
    words: Math.round(text.length / 6),
    aiCount: text.match(AI_TERMS)?.length ?? 0,
    employees: ok ? employees : null,
    matched: ok ? m![0].trim() : null,
  };
}
