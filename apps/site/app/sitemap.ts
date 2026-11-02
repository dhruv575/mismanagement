import type { MetadataRoute } from "next";
import { api } from "@/lib/api";
import { SITE_URL } from "@/lib/site";

export const revalidate = 21600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const board = await api<{ refreshed_at: string | null; rows: { ticker: string }[] }>("/mismanagement?limit=3000");
  const lastModified = board.refreshed_at ? new Date(board.refreshed_at) : new Date();
  return [
    { url: `${SITE_URL}/`, lastModified, changeFrequency: "daily", priority: 1 },
    { url: `${SITE_URL}/deals`, lastModified, changeFrequency: "daily", priority: 0.8 },
    ...board.rows.map((r) => ({
      url: `${SITE_URL}/company/${r.ticker}`,
      lastModified,
      changeFrequency: "weekly" as const,
      priority: 0.6,
    })),
  ];
}
