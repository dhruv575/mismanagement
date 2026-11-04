"use client";
// Client only for the selected-link state and the search box; the header
// around it stays server-rendered and mounted across navigations.
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { PixelMark } from "@/lib/mark";
import { Sprite } from "@/lib/sprites";
import { baseOf, counterpart, sideOf } from "@/lib/side";

interface Hit { ticker: string; name: string; sic_description: string | null }

// The whole header: brand, links, side toggle. Client-side so it knows the
// current side from the path; it stays mounted across navigations. The
// side sets the theme (angel light, devil dark) through CSS :has() on the
// header, so the server render already has the right colors.
export function Header() {
  const path = usePathname();
  const router = useRouter();
  const side = sideOf(path);
  const base = baseOf(side);
  const cur = (href: string) => (path === href || (href.length > 1 && path.startsWith(`${href}/`)) ? "page" : undefined);
  const links: [string, string][] = side === "angel"
    ? [["/rollups", "Rollups"], ["/deals", "Model"]]
    : [["/pe/deals", "Deals"], ["/acquirers", "Acquirers"]];

  // Resolves the pending view transition once the new page has rendered.
  const done = useRef<(() => void) | null>(null);
  useEffect(() => { done.current?.(); done.current = null; }, [path]);

  const flip = (e: React.MouseEvent<HTMLAnchorElement>) => {
    const to = counterpart(path);
    const doc = document as Document & { startViewTransition?: (cb: () => Promise<void>) => { ready: Promise<void> } };
    if (!doc.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    // A circle grows from the toggle until it covers the page.
    const r = e.currentTarget.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const end = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    const t = doc.startViewTransition(() => new Promise<void>((res) => {
      done.current = res;
      router.push(to, { scroll: false });
      setTimeout(res, 3000); // never hang on a slow page
    }));
    t.ready.then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${end}px at ${x}px ${y}px)`] },
        { duration: 650, easing: "cubic-bezier(0.65, 0, 0.35, 1)", pseudoElement: "::view-transition-new(root)" },
      );
    });
  };

  const label = side === "angel" ? "Switch to the devil side: PE & activist takeovers" : "Switch to the angel side: AI rollups";
  return (
    <header className="header" data-side={side}>
      <div className="header-inner">
        <Link href={base || "/"} className="brand"><PixelMark size={32} />Takeover
          <span className="brand-sub">{side === "angel" ? "AI rollups" : "PE & activists"}</span></Link>
        <nav className="nav" aria-label="Primary">
          <Search base={base} />
          {links.map(([href, label]) => <Link key={href} href={href} aria-current={cur(href)}>{label}</Link>)}
          <Link href={counterpart(path)} onClick={flip} className="side-toggle" data-side={side}
            role="switch" aria-checked={side === "devil"} aria-label={label} title={label}>
            <span className="side-knob" aria-hidden="true" />
            <span className="side-opt" data-on={side === "angel"}><Sprite kind="angel" size={24} /></span>
            <span className="side-opt" data-on={side === "devil"}><Sprite kind="devil" size={24} /></span>
          </Link>
        </nav>
      </div>
    </header>
  );
}

// Collapsed to an icon; expands into an input on click or "/". Results are
// companies matched by ticker, name or industry.
function Search({ base }: { base: string }) {
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

  const go = (h: Hit) => { close(); router.push(`${base}/company/${h.ticker}`); };

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
