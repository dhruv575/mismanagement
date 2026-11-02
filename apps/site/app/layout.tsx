import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Nav } from "./nav";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: "Mismanagement",
  description: "Public-company red flags computed from SEC filings.",
  metadataBase: new URL("https://mismanagement.droov.info"),
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        {/* Static chrome: never behind a data or auth boundary. */}
        <header className="header">
          <div className="header-inner">
            <a href="/" className="brand">Mismanagement</a>
            <Nav />
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
