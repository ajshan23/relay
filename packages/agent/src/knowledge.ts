/*
 * Knowledge helpers with no database: cutting text into searchable pieces and merging the two
 * searches (words and meaning) into one ranking.
 */

/** About 4 characters per token for the languages we see; good enough for budgeting. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Cuts text into pieces of about `size` tokens with `overlap` tokens repeated between neighbours, on
 * paragraph, then sentence, then word boundaries, so a piece rarely starts mid-sentence.
 */
export function chunkText(text: string, size = 500, overlap = 50): string[] {
  const clean = text
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!clean) return [];
  const maxChars = size * 4;
  const overlapChars = overlap * 4;
  if (clean.length <= maxChars) return [clean];

  // Units no longer than one piece: paragraphs, split further when too long.
  const units: string[] = [];
  for (const para of clean.split(/\n\n/)) {
    if (para.length <= maxChars) units.push(para);
    else {
      let buf = "";
      for (const sentence of para.split(/(?<=[.!?।؟])\s+/)) {
        if (sentence.length > maxChars) {
          if (buf) units.push(buf);
          buf = "";
          for (let i = 0; i < sentence.length; i += maxChars) units.push(sentence.slice(i, i + maxChars));
        } else if (`${buf} ${sentence}`.length > maxChars) {
          units.push(buf);
          buf = sentence;
        } else buf = buf ? `${buf} ${sentence}` : sentence;
      }
      if (buf) units.push(buf);
    }
  }

  const chunks: string[] = [];
  let current = "";
  for (const unit of units) {
    if (current && `${current}\n\n${unit}`.length > maxChars) {
      chunks.push(current);
      const tail = current.slice(-overlapChars);
      const cut = tail.indexOf(" ");
      current = `${cut >= 0 ? tail.slice(cut + 1) : tail}\n\n${unit}`;
      if (current.length > maxChars) current = unit;
    } else current = current ? `${current}\n\n${unit}` : unit;
  }
  if (current) chunks.push(current);
  return chunks;
}

/** A Q&A pair as one piece, so a matching question brings its whole answer. */
export function qaChunk(question: string, answer: string): string {
  return `Q: ${question.trim()}\nA: ${answer.trim()}`;
}

/**
 * Reciprocal-rank fusion: each list votes 1/(k + rank) for its items. Items found by both the word
 * search and the meaning search rise to the top; neither search's raw scores need to be comparable.
 */
export function fuseRankings(lists: string[][], k = 60): string[] {
  const score = new Map<string, number>();
  for (const list of lists)
    list.forEach((id, rank) => {
      score.set(id, (score.get(id) ?? 0) + 1 / (k + rank + 1));
    });
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/** Words for the full-text search: OR of the meaningful words, safe for to_tsquery. */
export function searchTerms(query: string): string | null {
  const words = query
    .toLowerCase()
    .normalize("NFKC")
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((w) => w.length >= 2 && !stopWords.has(w))
    .slice(0, 12);
  if (!words.length) return null;
  return [...new Set(words)].map((w) => `${w}:*`).join(" | ");
}

const stopWords = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "be",
  "to",
  "of",
  "and",
  "or",
  "in",
  "on",
  "at",
  "for",
  "with",
  "do",
  "does",
  "you",
  "your",
  "we",
  "our",
  "i",
  "me",
  "my",
  "it",
  "this",
  "that",
  "what",
  "how",
  "can",
  "have",
  "has",
  "there",
  "any",
  "please",
  "hi",
  "hello",
]);
