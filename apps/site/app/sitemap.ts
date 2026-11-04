import type { MetadataRoute } from "next";
import { api } from "@/lib/api";
import { SITE_URL } from "@/lib/site";

export const revalidate = 21600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const board = await api<{ refreshed_at: string | null; rows: { ticker: string }[] }>("/leaderboard?limit=3000");
  const acq = await api<{ rows: { slug: string }[] }>("/acquirers");
  const lastModified = board.refreshed_at ? new Date(board.refreshed_at) : new Date();
  return [
    { url: `${SITE_URL}/`, lastModified, changeFrequency: "daily", priority: 1 },
    { url: `${SITE_URL}/deals`, lastModified, changeFrequency: "daily", priority: 0.8 },
    { url: `${SITE_URL}/rollups`, lastModified, changeFrequency: "daily", priority: 0.9 },
    { url: `${SITE_URL}/acquirers`, lastModified, changeFrequency: "daily", priority: 0.8 },
    { url: `${SITE_URL}/pe`, lastModified, changeFrequency: "daily", priority: 0.9 },
    { url: `${SITE_URL}/pe/deals`, lastModified, changeFrequency: "daily", priority: 0.8 },
    ...acq.rows.map((r) => ({
      url: `${SITE_URL}/acquirers/${r.slug}`,
      lastModified,
      changeFrequency: "weekly" as const,
      priority: 0.5,
    })),
    ...board.rows.map((r) => ({
      url: `${SITE_URL}/company/${r.ticker}`,
      lastModified,
      changeFrequency: "weekly" as const,
      priority: 0.6,
    })),
  ];
}
