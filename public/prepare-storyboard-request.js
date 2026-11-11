import { extractMarkdownShots } from './markdown-shots.js?v=20261111-6';
import { translateInput, translateStoryboardToChinese } from './chinese-input.js?v=20261111-6';

export const translationPromptId = 'jingxu-internal-chinese-translation';
const preparedScripts = new Map();

export function rememberChineseStoryboard(original, chinese) {
  const originalShots = extractMarkdownShots(original);
  const chineseShots = extractMarkdownShots(chinese);
  if (!originalShots.length || originalShots.length !== chineseShots.length || /[a-z]/i.test(chinese)
    || originalShots.some((shot, index) => shot.number !== chineseShots[index].number)) return;
  preparedScripts.delete(original);
  preparedScripts.set(original, { script: chinese, translated: /[a-z]/i.test(originalShots.map(shot => shot.visual + shot.dialogue).join('')) });
  if (preparedScripts.size > 10) preparedScripts.delete(preparedScripts.keys().next().value);
}

// Prepare a Chinese request while keeping the user's input untouched. This
// also works with an already-running server through its existing text API.
export async function prepareStoryboardRequest(script, requestJson) {
  if (preparedScripts.has(script)) return { ...preparedScripts.get(script) };
  const shots = extractMarkdownShots(script);
  if (!shots.length) {
    const chinese = await translateInput(script, requestJson, { batchSize: 12 });
    return { script: chinese, translated: chinese !== script };
  }
  const result = await translateStoryboardToChinese({ title: '已有分镜', shots }, requestJson);
  const cell = value => String(value).replace(/\*\*/g, '').replace(/\s+/g, ' ').trim().replace(/\|/g, '｜');
  const prepared = {
    script: ['| 镜号 | 画面提示词 | 配音台词 |', '|---|---|---|',
      ...result.shots.map(shot => `| **${shot.number}** | ${cell(shot.visual)} | ${cell(shot.dialogue)} |`)
    ].join('\n'),
    translated: result.translatedToChinese
  };
  rememberChineseStoryboard(script, prepared.script);
  return prepared;
}

export function parseTranslationResponse(text) {
  const plain = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const data = JSON.parse(plain);
  if (!Array.isArray(data?.lines)) throw new SyntaxError('翻译返回格式不完整');
  return data;
}
