import { Figtree } from "next/font/google";
import "./design.css";

const figtree = Figtree({ subsets: ["latin"], variable: "--font-figtree" });

export const metadata = { title: "Design mock" };

export default function DesignLayout({ children }: { children: React.ReactNode }) {
  return <div className={`${figtree.variable} flex min-h-screen flex-1 flex-col`}>{children}</div>;
}
