// The site has two sides over the same data:
//   angel: AI rollups (/, /rollups, /deals, /company/X)
//   devil: PE & activist takeovers (/pe, /pe/deals, /pe/company/X, /acquirers)
export type Side = "angel" | "devil";

export const DEVIL_BASE = "/pe";

export function sideOf(path: string): Side {
  return path === DEVIL_BASE || path.startsWith(`${DEVIL_BASE}/`) || path.startsWith("/acquirers") ? "devil" : "angel";
}

export function baseOf(side: Side): string {
  return side === "devil" ? DEVIL_BASE : "";
}

// The equivalent page on the other side, so the toggle keeps your place.
export function counterpart(path: string): string {
  if (sideOf(path) === "devil") {
    if (path.startsWith("/acquirers")) return "/rollups";
    const rest = path.slice(DEVIL_BASE.length);
    return rest || "/";
  }
  if (path === "/rollups") return "/acquirers";
  return path === "/" ? DEVIL_BASE : `${DEVIL_BASE}${path}`;
}
