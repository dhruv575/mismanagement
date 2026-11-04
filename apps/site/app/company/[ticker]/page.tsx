import type { Metadata } from "next";
import { CompanyView, companyMetadata } from "@/lib/company-view";

export const revalidate = 21600;
// Render on first request, then cache; ~2.5K tickers is too many to prebuild.
export const dynamicParams = true;
export async function generateStaticParams() {
  return [];
}

export async function generateMetadata({ params }: { params: Promise<{ ticker: string }> }): Promise<Metadata> {
  return companyMetadata((await params).ticker, "angel");
}

export default async function Page({ params }: { params: Promise<{ ticker: string }> }) {
  return <CompanyView ticker={(await params).ticker} side="angel" />;
}
