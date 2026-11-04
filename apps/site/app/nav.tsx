"use client";
// Client only for the selected-link state and the search box; the header
// around it stays server-rendered and mounted across navigations.
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

interface Hit { ticker: string; name: string; sic_description: string | null }

export function Nav() {
  const path = usePathname();
  return (
    <nav className="nav" aria-label="Primary">
      <Search />
      <Link href="/rollups" aria-current={path === "/rollups" ? "page" : undefined}>Rollups</Link>
      <Link href="/deals" aria-current={path === "/deals" ? "page" : undefined}>Deals</Link>
      <Link href="/acquirers" aria-current={path.startsWith("/acquirers") ? "page" : undefined}>Acquirers</Link>
    </nav>
  );
}

// Collapsed to an icon; expands into an input on click or "/". Results are
// companies matched by ticker, name or industry.
function Search() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [active, setActive] = useState(0);
  const [answered, setAnswered] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const close = () => { setOpen(false); setQ(""); setHits([]); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.key === "/" && !typing) { e.preventDefault(); setOpen(true); }
    };
    const onClick = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) close(); };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => { window.removeEventListener("keydown", onKey); document.removeEventListener("mousedown", onClick); };
  }, []);

  useEffect(() => { if (open) input.current?.focus(); }, [open]);

  // Debounced fetch; a stale response never overwrites a newer query.
  useEffect(() => {
    const term = q.trim();
    if (!term) { setHits([]); return; }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(term)}`, { signal: ctrl.signal });
        const data = (await res.json()) as { rows: Hit[] };
        setHits(data.rows);
        setActive(0);
        setAnswered(term);
      } catch { /* aborted or offline */ }
    }, 150);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [q]);

  const go = (h: Hit) => { close(); router.push(`/company/${h.ticker}`); };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, hits.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter" && hits[active]) go(hits[active]!);
  };

  return (
    <div className="search" data-open={open} ref={box}>
      <button type="button" className="search-icon" aria-label="Search companies" onClick={() => (open ? input.current?.focus() : setOpen(true))}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
        </svg>
      </button>
      <input
        ref={input}
        className="search-input"
        type="search"
        placeholder="Ticker, company or industry"
        aria-label="Search companies"
        role="combobox"
        aria-expanded={hits.length > 0}
        aria-controls="search-results"
        aria-activedescendant={hits[active] ? `hit-${hits[active]!.ticker}` : undefined}
        tabIndex={open ? 0 : -1}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {open && hits.length > 0 && (
        <ul className="search-results" id="search-results" role="listbox">
          {hits.map((h, i) => (
            <li key={h.ticker} id={`hit-${h.ticker}`} role="option" aria-selected={i === active}
              onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); go(h); }}>
              <span className="ticker">{h.ticker}</span>
              <span className="search-sep" aria-hidden="true">|</span>
              <span className="search-name">{h.name}</span>
              {h.sic_description && <span className="search-industry">{h.sic_description}</span>}
            </li>
          ))}
        </ul>
      )}
      {open && q.trim() && answered === q.trim() && hits.length === 0 && <div className="search-results search-empty">No matches</div>}
    </div>
  );
}
