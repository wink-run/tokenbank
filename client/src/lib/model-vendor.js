// 模型按厂商分组、去掉厂商前缀、日期/档位版本折叠到主模型下：模型页和选模型的下拉框共用
// ── 模型多时的整理：按厂商分组、去掉厂商前缀、日期/档位版本折叠到主模型下 ──
const MODEL_VENDORS = [
  ['DeepSeek', /^deepseek/i, /^deepseek[-_]?/i],
  ['豆包', /^(doubao|seed|ark|skylark)/i, /^doubao[-_]?/i],
  ['GLM', /^(glm|chatglm|cogview|cogvideo|charglm|codegeex)/i, /^glm[-_]?/i],
  ['OpenAI', /^(gpt|o\d|chatgpt|codex|dall-e|text-embedding|whisper|tts)/i, /^gpt[-_]?/i],
  ['Claude', /^claude/i, /^claude[-_]?/i],
  ['Gemini', /^(gemini|gemma|imagen)/i, /^gemini[-_]?/i],
  ['通义', /^(qwen|qwq|qvq|tongyi|wan)/i, /^qwen[-_]?/i],
  ['Kimi', /^(kimi|moonshot)/i, /^(kimi|moonshot)[-_]?/i],
  ['MiniMax', /^(minimax|abab|hailuo)/i, /^minimax[-_]?/i],
  ['Grok', /^grok/i, /^grok[-_]?/i],
  ['Llama', /^(llama|meta-llama)/i, null],
  ['Mistral', /^(mistral|mixtral|codestral|devstral|magistral)/i, null],
];

/** 模型归哪个厂商：org/model 写法按 org，其余按名字开头 */
export function modelVendor(name) {
  const raw = String(name || '').trim();
  const [org, rest] = raw.includes('/') ? raw.split('/', 2) : ['', raw];
  for (const [label, re] of MODEL_VENDORS) if (re.test(rest)) return label;
  if (org) return org.charAt(0).toUpperCase() + org.slice(1);
  return '其它';
}

/** 卡片上显示的短名：去掉 org/ 和厂商前缀（deepseek-v4-flash → v4-flash） */
export function modelShortName(name) {
  const raw = String(name || '').trim();
  const rest = raw.includes('/') ? raw.split('/').slice(1).join('/') : raw;
  for (const [, re, strip] of MODEL_VENDORS) {
    if (re.test(rest) && strip) {
      const short = rest.replace(strip, '');
      return short || rest;
    }
  }
  return rest;
}

/** 日期、档位版本归到哪个主模型（deepseek-v4-flash-ga-260731 → deepseek-v4-flash） */
export function modelBaseName(name) {
  let n = String(name || '').trim();
  for (let i = 0; i < 3; i++) {
    const next = n
      .replace(/[-_@](\d{4}-\d{2}-\d{2}|\d{6,8})$/, '')
      .replace(/[-_](ga|economy|eco|preview|latest|exp|beta|turbo-\d+)$/i, '');
    if (next === n) break;
    n = next;
  }
  return n;
}

