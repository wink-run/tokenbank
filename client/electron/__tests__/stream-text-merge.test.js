'use strict';

const assert = require('assert');

(async () => {
  const { mergeStreamText, foldStreamSteps } = await import('../../shared/stream-text-merge.js');

  assert.strictEqual(
    foldStreamSteps([
      { content: 'Hi', is_delta: true },
      { content: '! What are you working on?', is_delta: true },
      { content: 'Hi! What are you working on?', is_snapshot: true },
    ]),
    'Hi! What are you working on?',
  );

  assert.strictEqual(
    mergeStreamText('Hi', '! What are you working on?'),
    'Hi! What are you working on?',
  );

  assert.strictEqual(
    mergeStreamText('Hi! What are you working on?', 'Hi! What are you working on?', { isSnapshot: true }),
    'Hi! What are you working on?',
  );

  const mixedDelta = 'The user is just saying hi. I should respond concisely without any fluff, as per their CLAUDE.md instructionsHi';
  const mixedSnap = 'The user is just saying hi. I should respond concisely without any fluff, as per their CLAUDE.md instructions.Hi. What are you working on?';
  assert.strictEqual(
    mergeStreamText(mixedDelta, mixedSnap, { isSnapshot: true }),
    mixedSnap,
    'snapshot should replace delta, not append',
  );

  // 历史步骤没有 is_snapshot：粘成一行的增量 + 带换行的全文，应留下能排版的那份
  const glued = '##仓库结构|目录 |内容 |\n|---|---|';
  const formatted = '## 仓库结构\n\n| 目录 | 内容 |\n|---|---|';
  assert.strictEqual(
    foldStreamSteps([
      { content: glued },
      { content: formatted },
    ]),
    formatted,
  );
  assert.strictEqual(
    mergeStreamText('看完了。这是正文', '呀'),
    '看完了。这是正文呀',
    '短增量仍应拼接',
  );

  const damaged = '看完了。这是 **Token Bank（仓库名 local-m-proxy）**\n\n##结构|目录 |内容 |';
  const full = '看完了。这是 **Token Bank（仓库名 local-llm-proxy）** —— 一个本地 LLM 网关。\n\n## 仓库结构\n\n| 目录 | 内容 |\n|---|---|';
  assert.strictEqual(mergeStreamText(damaged, full), full);

  console.log('stream-text-merge.test.js OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
