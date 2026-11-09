'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  anthropicToOpenai,
  modelSupportsVision,
  openaiToAnthropic,
  isMissingReasoningContentError,
  ensureReasoningContentOnAssistants,
} = require('../local-gateway');

test('anthropicToOpenai：识图模型的 tool_result 保留图片', () => {
  const oai = anthropicToOpenai({
    model: 'vision-model',
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_img', name: 'Read', input: { file_path: 'cover.png' } }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_img',
          content: [
            { type: 'text', text: '{"file_path":"cover.png"}' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
          ],
        }],
      },
    ],
  }, { includeImages: true });
  const tool = oai.messages.find((m) => m.role === 'tool');
  assert.equal(typeof tool.content, 'string');
  assert.match(tool.content, /cover\.png/);
  const user = [...oai.messages].reverse().find((m) => m.role === 'user');
  assert.equal(Array.isArray(user.content), true);
  assert.equal(user.content.some((p) => p.type === 'image_url' && String(p.image_url.url).startsWith('data:image/png;base64,')), true);
});

test('deepseek-v4.1-flash 登记为 chat 时仍然识图', () => {
  const flash = { models: [{ name: 'deepseek-v4.1-flash', type: 'chat' }] };
  assert.equal(modelSupportsVision('deepseek-v4.1-flash', flash), true);
  assert.equal(modelSupportsVision('deepseek-v4-flash', { models: [{ name: 'deepseek-v4-flash', type: 'chat' }] }), true);
  assert.equal(modelSupportsVision('deepseek-v4-pro', { models: [{ name: 'deepseek-v4-pro', type: 'chat' }] }), false);
});

test('anthropicToOpenai：纯文本模型的 tool_result 图片收成占位', () => {
  const oai = anthropicToOpenai({
    model: 'text-model',
    messages: [{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_img',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }],
      }],
    }],
  }, { includeImages: false });
  const tool = oai.messages.find((m) => m.role === 'tool');
  assert.equal(tool.content, '[image]');
});

test('anthropicToOpenai：thinking 块 → reasoning_content', () => {
  const oai = anthropicToOpenai({
    model: 'deepseek-v4-flash',
    messages: [{
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '先列目录' },
        { type: 'text', text: '好的' },
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
      ],
    }],
  });
  const msg = oai.messages[0];
  assert.equal(msg.reasoning_content, '先列目录');
  assert.equal(msg.content, '好的');
  assert.equal(msg.tool_calls.length, 1);
});

test('openaiToAnthropic：reasoning_content → thinking 块（不并入 text）', () => {
  const anth = openaiToAnthropic({
    choices: [{
      message: {
        role: 'assistant',
        content: '最终答案',
        reasoning_content: '逐步推理',
      },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 1, completion_tokens: 2 },
  }, 'deepseek-v4-flash');
  const types = anth.content.map((b) => b.type);
  assert.deepEqual(types, ['thinking', 'text']);
  assert.equal(anth.content[0].thinking, '逐步推理');
  assert.equal(anth.content[1].text, '最终答案');
});

test('isMissingReasoningContentError 识别 DeepSeek 文案', () => {
  assert.equal(
    isMissingReasoningContentError({
      message: 'HTTP_400: The `reasoning_content` in the thinking mode must be passed back to the API.',
    }),
    true,
  );
  assert.equal(isMissingReasoningContentError({ message: 'HTTP_429: rate' }), false);
});

test('ensureReasoningContentOnAssistants 补 Anthropic thinking / OpenAI 字段', () => {
  const anth = ensureReasoningContentOnAssistants({
    messages: [{
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: '1', name: 'x', input: {} }],
    }],
  });
  assert.equal(anth.messages[0].content[0].type, 'thinking');

  const oai = ensureReasoningContentOnAssistants({
    messages: [{ role: 'assistant', content: 'hi', tool_calls: [{ id: 'c' }] }],
  });
  assert.equal(oai.messages[0].reasoning_content, ' ');
});
