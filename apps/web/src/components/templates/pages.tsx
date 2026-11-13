"use client";

import { useSearchParams } from "next/navigation";
import { TemplateEditor } from "./template-editor";

export function NewTemplate() {
  const from = useSearchParams().get("from");
  return <TemplateEditor key={from ?? "blank"} id={null} fromKey={from} />;
}

export function EditTemplate({ id }: { id: string }) {
  return <TemplateEditor key={id} id={id} fromKey={null} />;
}
