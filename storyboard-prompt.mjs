export function buildStoryboardPrompt({ script, durationSeconds, totalShots, taskCount, averageShotSeconds, globalRequirements }, retryNote = "", lockedDialogues = []) {
  const hasCoco = /coco|蓝白长毛/i.test(script);
  const dialogueRule = lockedDialogues.length
    ? `原文中有 ${lockedDialogues.length} 句锁定台词。dialogue 字段只能填写下面清单中的编号，例如 D1 或 D1,D2；不能填写、改写、翻译、缩短、扩写任何台词文字。每个编号必须恰好使用一次，并严格保持 D1 到 D${lockedDialogues.length} 的先后顺序。没有台词的镜头写“无”。`
    : "原文没有识别到可锁定的明确台词。不得新增或编造台词；只有能从原文逐字复制时才填写，否则写“无”。";
  const dialogueManifest = lockedDialogues.length
    ? `\n原文台词锁定清单（文字只用于理解，输出时只能填写编号）：\n${lockedDialogues.map((item) => `${item.id} = ${item.rendered}`).join("\n")}\n`
    : "";
  const languageRule = hasCoco
    ? "标题和每个 visual 必须全部使用中文，除固定角色名 Coco 外不得出现任何英文字母或英文单词。原文中的 Style、Lighting、Bokeh、Subsurface Scattering、Facial Performance、3D 等术语必须分别改写成“风格、光照、焦外虚化、次表面散射、面部表演、三维”等中文表达，不能原样复制。"
    : "标题和每个 visual 必须全部使用中文，不得出现任何英文字母或英文单词。原文中的 Style、Lighting、Bokeh、Subsurface Scattering、Facial Performance、3D 等术语必须分别改写成“风格、光照、焦外虚化、次表面散射、面部表演、三维”等中文表达，不能原样复制。";
  return `你是一名专业的中文分镜整理师。把用户提供的复刻分镜无损换成统一格式。这不是二次创作：不得改剧情、改台词、补写动作或重新设计镜头。输出约 ${durationSeconds} 秒、恰好 ${totalShots} 镜，并整理成 ${taskCount} 个视频任务，平均每镜约 ${averageShotSeconds} 秒。

硬性要求：
1. 必须返回恰好 ${totalShots} 个镜头，number 从 1 连续编号到 ${totalShots}。原文镜头更多时，只能把相邻原镜头按顺序合并，不能删除、调换或改写其中任何事件；原文镜头更少时，只按原有动作自然分行，不能新增事件。
2. 严格保留原文中的人物、外貌、服装、场景、道具、动作、表情、因果关系和先后顺序。只允许清理 Markdown、统一段落格式，以及把英文视觉术语换成对应中文。
3. 每个 visual 必须以【原镜头范围或景别运镜】开头，随后按原文内容整理。不得为了增强效果添加钩子、冲突、反转、动作、表情、道具或角色。
4. 原文已有画面描述时必须以它为唯一依据；不要发挥、润色、概括掉细节或重复画面凑镜头数。
5. ${dialogueRule}
6. 所有台词只调整到 dialogue 字段，文字、标点、语气词、说话人和出现顺序必须与原文逐字一致。
7. 只返回符合指定结构的数据，不输出分析、Markdown 表格或额外解释。
8. 角色与外貌仅从当前原文提取，称呼、物种、服装和主次关系均沿用原文。不得把角色统一替换为其他人物或宠物，不得补写原文没有的外貌。
9. ${languageRule}
${retryNote}

全局补充要求：
${globalRequirements || "沿用原文的人物、场景、画幅和节奏；未说明的细节不额外补写。"}
${dialogueManifest}

用户故事：
${script}`;
}

