import { OG_SIZE } from "@/lib/og";
import { companyImage } from "@/lib/og-company";

export const revalidate = 21600;
export const size = OG_SIZE;
export const contentType = "image/png";
export const alt = "AI-rollup odds";

export default async function Image({ params }: { params: Promise<{ ticker: string }> }) {
  return companyImage((await params).ticker, "angel");
}
