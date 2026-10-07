/**
 * Picks a close candidate for a misspelled name, for "Did you mean" hints.
 * Deliberately small: exact case-insensitive match, else edit distance <= 2.
 */
export function suggest(name: string, candidates: Iterable<string>): string | undefined {
  let best: { candidate: string; distance: number } | undefined;
  for (const candidate of candidates) {
    if (candidate.toLowerCase() === name.toLowerCase()) return candidate;
    const distance = editDistance(name, candidate);
    if (distance <= 2 && (!best || distance < best.distance)) best = { candidate, distance };
  }
  return best?.candidate;
}

function editDistance(a: string, b: string): number {
  const previous: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = previous[j]!;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      previous[j] = Math.min(previous[j]! + 1, previous[j - 1]! + 1, diagonal + cost);
      diagonal = temp;
    }
  }
  return previous[b.length]!;
}
