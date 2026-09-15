import { filingEvidenceId } from './disclosureNotebook.js';

/** Bounded client work. Cancellation prevents queued requests from starting.
 * @param {any[]} items
 * @param {(item: any, index: number) => Promise<any>} work
 * @param {{concurrency?: number, signal?: AbortSignal}} options
 */
export async function mapDisclosureWork(items, work, { concurrency = 2, signal } = {}) {
  let cursor = 0;
  const results = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!signal?.aborted) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await work(items[index], index);
    }
  }));
  return results;
}

const quality = { reviewed: 4, 'section-unavailable': 4, 'indexed-match': 3, 'fetch-failed': 2, 'index-candidate': 1 };
/** Merge retrieval sources without losing original SEC rank or stronger evidence. */
export function mergeDisclosureSearchFilings(...groups) {
  const merged = new Map();
  for (const filing of groups.flat()) {
    const id = filingEvidenceId(filing);
    const previous = merged.get(id);
    if (!previous) { merged.set(id, filing); continue; }
    const incomingWins = (quality[filing.status] || 0) >= (quality[previous.status] || 0);
    const ranks = [previous.indexRank, filing.indexRank].filter(Number.isFinite);
    merged.set(id, {
      ...(incomingWins ? previous : filing), ...(incomingWins ? filing : previous),
      ...(ranks.length ? { indexRank: Math.min(...ranks) } : {}),
      indexScore: previous.indexScore ?? filing.indexScore,
    });
  }
  return [...merged.values()];
}
