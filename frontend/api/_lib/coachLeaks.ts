// Overfitting check, ported from the Skill Trainer's `find_leaks`: phrases of
// six or more words that appear both in the working prompt and in the training
// data (conversations, comments, ideas marked good) or in the run-time context
// (playbook), which the prompt must never copy. Phrases the seed prompt already
// had are not flagged — the seed is the team's own text.

const WORD = /[\p{L}\p{N}_]+/gu
const NGRAM = 6

const words = (text: string): string[] => text.toLowerCase().match(WORD) ?? []

function grams(text: string): string[] {
  const w = words(text)
  const out: string[] = []
  for (let i = 0; i + NGRAM <= w.length; i++) out.push(w.slice(i, i + NGRAM).join(' '))
  return out
}

export interface LeakSource {
  readonly label: string
  readonly text: string
}

export interface Leak {
  readonly phrase: string
  readonly source: string
}

export function findLeaks(prompt: string, sources: readonly LeakSource[], allowed: readonly string[] = []): Leak[] {
  const promptWords = words(prompt)
  if (promptWords.length < NGRAM) return []
  const allow = new Set(allowed.flatMap(grams))
  const seen = new Map<string, string>()
  for (const { label, text } of sources) {
    for (const g of grams(text)) if (!allow.has(g) && !seen.has(g)) seen.set(g, label)
  }
  const hits: Leak[] = []
  let i = 0
  while (i + NGRAM <= promptWords.length) {
    const g = promptWords.slice(i, i + NGRAM).join(' ')
    const label = seen.get(g)
    if (!label) { i += 1; continue }
    let j = i + NGRAM
    while (j < promptWords.length && seen.has(promptWords.slice(j - NGRAM + 1, j + 1).join(' '))) j += 1
    hits.push({ phrase: promptWords.slice(i, j).join(' '), source: label })
    i = j
  }
  return hits
}
