import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { Nav } from "./nav";
import { REPO_URL, SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "@/lib/site";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${SITE_NAME}: takeover attractiveness for every Russell 3000 company`,
    template: `%s · ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    url: "/",
    title: `${SITE_NAME}: takeover attractiveness for every Russell 3000 company`,
    description: SITE_DESCRIPTION,
    locale: "en_US",
  },
  twitter: { card: "summary_large_image" },
  robots: { index: true, follow: true },
  category: "finance",
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
  colorScheme: "light",
};

const websiteJsonLd = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: SITE_NAME,
  url: SITE_URL,
  description: SITE_DESCRIPTION,
  sameAs: [REPO_URL],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(websiteJsonLd) }} />
        {/* Static chrome: never behind a data or auth boundary. */}
        <header className="header">
          <div className="header-inner">
            <a href="/" className="brand"><svg width="22" height="22" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="14" fill="#4f46e5" /><circle cx="32" cy="32" r="18" fill="none" stroke="#fff" strokeWidth="5" /><circle cx="32" cy="32" r="6.5" fill="#fff" /></svg>Takeover</a>
            <Nav />
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
