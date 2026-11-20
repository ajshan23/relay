/*
 * Making the agent's messages read like a person from the business typing on WhatsApp, not like an
 * AI assistant. Two layers, from the published "signs of AI writing" (Wikipedia's WikiProject AI
 * Cleanup, Pangram, Reuters Institute, GPTZero) and conversation-design guides (Google, Intercom):
 *
 * - plainChat: fixed clean-ups code can do safely on every message: long dashes, curly quotes,
 *   arrows, praise openers ("Great question!") and filler closers ("Let me know if you have any
 *   questions"). Links and number ranges ("11:00 – 11:45") are left as they are.
 * - templatePhrases: phrases only a rewrite can fix ("I'd be happy to", "not just X but Y",
 *   "seamless"). The loop asks the model once to say it again in plain words.
 *
 * The prompt describes the voice with examples rather than a long banned list, since naming banned
 * words in a prompt tends to make models use them.
 */

const link = /https?:\/\/\S+/g;

/** Openers that praise the question or perform eagerness. Removed when the message goes on after them. */
const praiseOpener = /^(?:(?:great|good|excellent|fantastic) question|certainly|absolutely)[!,.]*\s+(?=\S)/i;

/** A last sentence that only offers more help. Removed when something else was said before it. */
const fillerCloser =
  /(^|[.!?)\p{Extended_Pictographic}]\s+|\n\s*)(?:(?:just |please )?let me know if (?:you (?:have|need) any|there(?:'s| is) anything|anything else)|(?:please )?feel free to (?:reach out|ask|contact|message|get in touch|let)|(?:please )?(?:don't|do not) hesitate to|(?:i )?hope (?:this|that) helps|is there anything else (?:i can|you)|have a (?:great|wonderful|nice) day)[^\n]*$/iu;

/** Fixed clean-ups for one message. Safe to run on anything the agent writes, in any language. */
export function plainChat(text: string): string {
  const links: string[] = [];
  let t = text.replace(link, (url) => {
    links.push(url);
    return `\uE000${links.length - 1}\uE000`;
  });

  t = t
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[ \t]*(?:→|⟶|➡️?)[ \t]*/g, " to ");

  // Long dashes between words go. After a short lead-in ("Done", "Not really", "Hi Ajmal") a comma
  // takes the place; after a whole clause a full stop, so the result isn't one run-on sentence.
  // Nothing at the start or end of a line. A dash in a range of numbers or times stays:
  // "11:00 – 11:45 AM", "2–3 days".
  t = t.replace(/[ \t]*[—–][ \t]*/g, (dash, at: number, all: string) => {
    const before = all.slice(0, at);
    const after = all.slice(at + dash.length);
    if (/\d(?:\s?[ap]\.?m\.?)?$/i.test(before) && /^\d/.test(after)) return dash;
    if (!before.trim() || before.endsWith("\n") || !after.trim() || after.startsWith("\n")) return "";
    if (/[,.!?:;(]$/.test(before)) return " ";
    const lead =
      before
        .split(/[.!?\n]/)
        .at(-1)
        ?.trim()
        .split(/\s+/).length ?? 0;
    return lead <= 3 ? ", " : ". ";
  });
  t = t
    .replace(/(\p{Ll})/gu, (_, c: string) => c.toUpperCase())
    .replace(//g, "")
    .replace(/,\s*([,.!?])/g, "$1");

  const opened = t.replace(praiseOpener, "");
  if (opened !== t) t = opened.charAt(0).toUpperCase() + opened.slice(1);

  const closer = fillerCloser.exec(t);
  if (closer && t.slice(0, closer.index + (closer[1] ?? "").length).trim())
    t = t.slice(0, closer.index + (closer[1] ?? "").length).trimEnd();

  return t.replace(/\uE000(\d+)\uE000/g, (_, i: string) => links[Number(i)] ?? "").trim();
}

const templatePatterns: [RegExp, string][] = [
  [/\bI(?:'d| would) be (?:happy|glad|delighted) to\b/i, "I'd be happy to"],
  [/\bnot (?:just|only|merely)\b[^.!?\n]{1,80}\bbut\b/i, "not just … but …"],
  [/\bit'?s not (?:just )?(?:about )?[^.!?\n]{1,40}[,;.] it'?s\b/i, "it's not X, it's Y"],
  [/\b(?:it'?s|it is) (?:important|worth) (?:to )?not(?:e|ing)\b/i, "it's worth noting"],
  [/\bdelv(?:e|es|ing)\b/i, "delve"],
  [/\bseamless(?:ly)?\b/i, "seamless"],
  [/\bleverag(?:e|es|ing)\b/i, "leverage"],
  [/\brobust\b/i, "robust"],
  [/\btailored\b/i, "tailored"],
  [/\brest assured\b/i, "rest assured"],
  [/\bhope this (?:message )?finds you\b/i, "hope this finds you"],
  [/\byou'?re (?:absolutely|totally) right\b/i, "you're absolutely right"],
  [/\b(?:great|good|excellent) question\b/i, "great question"],
  [/(?:^|[.!?]\s+)(?:Additionally|Moreover|Furthermore),/m, "Additionally / Moreover"],
  [/\b(?:in today's|ever-evolving|game[- ]changer|unlock the (?:full )?potential)\b/i, "marketing filler"],
];

/** The template-sounding phrases in a message (empty when it reads like a person wrote it). */
export function templatePhrases(text: string): string[] {
  const t = text.replace(link, "");
  return templatePatterns.filter(([re]) => re.test(t)).map(([, name]) => name);
}
