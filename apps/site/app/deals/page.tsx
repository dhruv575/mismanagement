import { DealsView, dealsMetadata } from "@/lib/deals-view";

export const revalidate = 21600;
export const metadata = dealsMetadata.angel;

export default function Page({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  return <DealsView searchParams={searchParams} side="angel" />;
}
