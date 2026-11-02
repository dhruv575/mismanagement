"use client";
// Client only for the selected-link state; the header around it stays
// server-rendered and mounted across navigations.
import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Leaderboard" },
  { href: "/deals", label: "Deals" },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav className="nav" aria-label="Primary">
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} aria-current={path === l.href ? "page" : undefined}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
