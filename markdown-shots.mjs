const cleanCell = value => value.replace(/<br\s*\/?\s*>/gi, '\n').replace(/\*\*/g, '').trim();
const splitRow = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cleanCell(cell.replace(/\\\|/g, '｜')));
const shotNumber = cell => cell.match(/^(?:shot\s*|镜头\s*|分镜\s*)?(\d+)$/i)?.[1];

export function extractMarkdownShots(script) {
  const rows = [];
  let headers = null;
  for (const line of String(script).split('\n')) {
    if (!/^\s*\|/.test(line)) continue;
    const cells = splitRow(line);
    if (cells.every(cell => /^:?-+:?$/.test(cell))) continue;
    const number = shotNumber(cells[0]);
    if (!number) { headers = /镜号|镜头|shot/i.test(cells[0]) ? cells : null; continue; }
    if (cells.length < 3) continue;
    let visual, dialogue;
    if (headers?.length === cells.length) {
      const audioIndex = headers.findIndex((h,i) => i > 0 && /台词|配音|声效|音频|audio|dialogue/i.test(h));
      const visualIndexes = headers.flatMap((h,i) => i > 0 && i !== audioIndex && !/^(?:时间|时长|time|duration)/i.test(h) ? [i] : []);
      visual = visualIndexes.map(i => cells[i]).filter(Boolean).join('\n');
      dialogue = audioIndex >= 0 ? cells[audioIndex] : '无';
    } else if (cells.length === 3) {
      visual = cells[1]; dialogue = cells[2];
    } else {
      // Preserve unknown columns rather than silently discarding source details.
      visual = cells.slice(1,-1).join('\n'); dialogue = cells.at(-1);
    }
    if (visual) rows.push({number:Number(number), visual, dialogue:dialogue || '无'});
  }
  return rows;
}
