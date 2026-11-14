import { redirect } from "next/navigation";

/** The public website (landing page, legal pages) lives in its own repo, relay-site. */
export default function Home() {
  redirect("/today");
}
