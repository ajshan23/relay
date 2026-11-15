"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { checkPassword, endSession, requireSignIn, startSession } from "@/lib/auth";
import { kairos } from "@/lib/db";

export async function login(_: { error?: string } | undefined, form: FormData) {
  if (!checkPassword(String(form.get("password") ?? ""))) return { error: "That password isn't right." };
  await startSession();
  redirect("/");
}

export async function logout() {
  await endSession();
  redirect("/login");
}

export async function cancelRuns(form: FormData) {
  await requireSignIn();
  const ids = form.getAll("runId").map(String).filter(Boolean);
  for (const id of ids) await kairos().cancel(id);
  revalidatePath("/", "layout");
}

export async function retryRuns(form: FormData) {
  await requireSignIn();
  const ids = form.getAll("runId").map(String).filter(Boolean);
  const fromSeq = form.get("fromSeq");
  for (const id of ids) {
    try {
      await kairos().retry(id, fromSeq ? { fromSeq: Number(fromSeq) } : {});
    } catch {
      // Only failed or cancelled runs can be retried; others in the selection are skipped.
    }
  }
  revalidatePath("/", "layout");
}
