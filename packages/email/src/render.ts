import { render } from "@react-email/render";
import { createElement } from "react";
import { catalog, type EmailData, type EmailKind } from "./catalog";

export type RenderedEmail = { subject: string; html: string; text: string };

/** Turns an email kind and its data into the subject, HTML and plain-text body. */
export async function renderEmail<K extends EmailKind>(kind: K, data: EmailData[K]): Promise<RenderedEmail> {
  const definition = catalog[kind];
  const element = createElement(definition.template, data);
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })]);
  return { subject: definition.subject(data), html, text };
}
