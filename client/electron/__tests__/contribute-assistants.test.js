'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeContributeAssistants,
  validateAssistantEligible,
  buildAgentCards,
  buildAppCards,
  assertAssistantContributed,
} = require('../contribute-assistants');

const poem = {
  id: 'res-assistant-poem-expert',
  type: 'assistant',
  name: 'poem-expert',
  display_name: '写诗专家',
  description: '写诗',
  content: JSON.stringify({
    soul: 'SECRET_SOUL_SHOULD_NOT_LEAK',
    prompts: ['secret-prompt'],
    skills: ['secret-skill'],
    runtime_agent: 'codex',
  }),
  projections: [{ agentId: 'codex', createdAt: 1 }],
};

test('normalizeContributeAssistants 去重并规范化 visibility', () => {
  const rows = normalizeContributeAssistants({
    contribute_assistants: [
      { id: 'a', visibility: 'circle' },
      'b',
      { id: 'a', visibility: 'public' },
      { id: 'c', visibility: 'weird' },
    ],
  });
  assert.deepEqual(rows, [
    { id: 'a', visibility: 'circle' },
    { id: 'b', visibility: 'public' },
    { id: 'c', visibility: 'public' },
  ]);
});

test('validateAssistantEligible: 未投射 / runtime 不可用', () => {
  assert.equal(validateAssistantEligible({ ...poem, projections: [] }).ok, false);
  assert.equal(validateAssistantEligible(poem, { isRuntimeAvailable: () => false }).reason, 'runtime_unavailable');
  assert.equal(validateAssistantEligible(poem, { isRuntimeAvailable: () => true }).ok, true);
});

test('validateAssistantEligible: 内置智能体不可贡献', () => {
  const builtin = {
    ...poem,
    projections: [{ agentId: 'codex', createdAt: 1 }],
    source: 'builtin',
    metadata: { builtin: true },
  };
  assert.equal(validateAssistantEligible(builtin).ok, false);
  assert.equal(validateAssistantEligible(builtin).reason, 'builtin');
  assert.equal(
    validateAssistantEligible({ ...builtin, source: 'catalog', metadata: { builtin: true } }).reason,
    'builtin',
  );
});

test('buildAgentCards 不含 soul / prompts 正文', () => {
  const cards = buildAgentCards(
    [{ id: poem.id, visibility: 'public' }],
    [poem],
    { isRuntimeAvailable: () => true },
  );
  assert.equal(cards.length, 1);
  assert.equal(cards[0].display_name, '写诗专家');
  assert.equal(cards[0].description, '写诗');
  assert.equal(cards[0].runtime, 'codex');
  const blob = JSON.stringify(cards);
  assert.ok(!blob.includes('SECRET_SOUL'));
  assert.ok(!blob.includes('secret-prompt'));
  assert.ok(!('content' in cards[0]));
  assert.ok(!('soul' in cards[0]));
});

test('buildAgentCards：无 description 时从 soul 摘简介', () => {
  const bare = {
    ...poem,
    description: '',
    content: JSON.stringify({
      soul: '专精格律与意象，擅长七言绝句与现代诗改写。勿泄露此句以外的秘密。',
      runtime_agent: 'codex',
    }),
  };
  const cards = buildAgentCards(
    [{ id: bare.id, visibility: 'public' }],
    [bare],
    { isRuntimeAvailable: () => true },
  );
  assert.equal(cards.length, 1);
  assert.match(cards[0].description, /专精格律/);
  assert.ok(!cards[0].description.includes('SECRET'));
});

test('buildAppCards：只上报已安装应用，名片不含本机配置', () => {
  const entries = [
    { id: 'app:claude-code', visibility: 'public' },
    { id: 'app:pi', visibility: 'circle' },
    { id: 'app:not-an-app', visibility: 'public' },
  ];
  const cards = buildAppCards(entries, {
    isRuntimeAvailable: (id) => id === 'pi',
  });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].id, 'app:pi');
  assert.equal(cards[0].display_name, 'Pi');
  assert.equal(cards[0].runtime, 'pi');
  assert.equal(cards[0].visibility, 'circle');
  assert.ok(!('content' in cards[0]));
  assert.equal(buildAppCards(entries).length, 0);
});

test('buildAgentCards 跳过本机应用 id', () => {
  const cards = buildAgentCards(
    [{ id: 'app:pi', visibility: 'public' }, { id: poem.id, visibility: 'public' }],
    [poem],
    { isRuntimeAvailable: () => true },
  );
  assert.equal(cards.length, 1);
  assert.equal(cards[0].id, poem.id);
});

test('assertAssistantContributed', () => {
  const cfg = { contribute_assistants: [{ id: poem.id }] };
  assert.doesNotThrow(() => assertAssistantContributed(cfg, poem.id));
  assert.throws(() => assertAssistantContributed(cfg, 'other'), /not contributed/);
});
