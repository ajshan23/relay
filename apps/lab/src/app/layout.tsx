import type { Metadata } from "next";
import { Bricolage_Grotesque, Figtree, Instrument_Sans, Inter, Manrope } from "next/font/google";
import "./globals.css";

const figtree = Figtree({ subsets: ["latin"], variable: "--font-figtree" });
const manrope = Manrope({ subsets: ["latin"], variable: "--font-manrope" });
const instrument = Instrument_Sans({ subsets: ["latin"], variable: "--font-instrument" });
const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const bricolage = Bricolage_Grotesque({ subsets: ["latin"], variable: "--font-bricolage" });

export const metadata: Metadata = {
  title: "Relay design lab",
  description: "One MVP shown in six structures and six colour designs.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const fonts = [figtree, manrope, instrument, inter, bricolage].map((f) => f.variable).join(" ");
  return (
    <html lang="en" className={`${fonts} h-full antialiased`} suppressHydrationWarning>
      <body className="h-full">{children}</body>
    </html>
  );
}
