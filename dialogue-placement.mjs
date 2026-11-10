// The model proposes locations; only the original manifest supplies dialogue text.
export function restoreOriginalDialogues(shots, locked) {
  if (!locked.length) return { shots, repaired: false };
  const references = shots.flatMap((shot, shotIndex) =>
    [...String(shot.dialogue || '').matchAll(/\bD(\d+)\b/gi)].map(m => ({ id: `D${Number(m[1])}`, shotIndex })));
  const exact = references.length === locked.length && references.every((ref, i) => ref.id === locked[i].id);
  const positions = [];
  if (exact) {
    positions.push(...references.map(ref => ref.shotIndex));
  } else {
    // Find a monotone placement using valid model references, literal dialogue,
    // and nearby source context. Weak matches remain explicitly marked for review.
    const scores = locked.map((line, i) => shots.map((shot, j) => {
      const raw = String(shot.dialogue || '');
      const ids = [...raw.matchAll(/\bD(\d+)\b/gi)].map(m => `D${Number(m[1])}`);
      const words = String(line.context || '').match(/[\u3400-\u9fff]{2,}/g) || [];
      const grams = new Set(words.flatMap(word => Array.from({length: word.length - 1}, (_, k) => word.slice(k, k + 2))));
      const overlap = [...grams].filter(word => String(shot.visual || '').includes(word)).length;
      const fraction = line.sourceFraction ?? (i + 0.5) / locked.length;
      return (ids.includes(line.id) ? 40 : 0)
        + (raw.includes(line.rendered) ? 50 : 0) + Math.min(overlap, 15)
        - Math.abs(j / Math.max(1, shots.length - 1) - fraction);
    }));
    const dp = scores.map(row => row.map(() => -Infinity));
    const back = scores.map(row => row.map(() => 0));
    dp[0] = [...scores[0]];
    for (let i = 1; i < locked.length; i++) {
      let best = -Infinity, index = 0;
      for (let j = 0; j < shots.length; j++) {
        if (dp[i - 1][j] > best) { best = dp[i - 1][j]; index = j; }
        dp[i][j] = best + scores[i][j]; back[i][j] = index;
      }
    }
    let j = dp.at(-1).indexOf(Math.max(...dp.at(-1)));
    for (let i = locked.length - 1; i >= 0; i--) { positions[i] = j; j = back[i][j]; }
  }
  const restored = shots.map(shot => ({ ...shot, dialogue: '无' }));
  locked.forEach((line, i) => {
    const shot = restored[positions[i]];
    shot.dialogue = shot.dialogue === '无' ? line.rendered : `${shot.dialogue}\n${line.rendered}`;
  });
  return { shots: restored, repaired: !exact };
}
