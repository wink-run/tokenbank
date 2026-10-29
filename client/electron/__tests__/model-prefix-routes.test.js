'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { modelExtends, prefixExtensions, prefixModelRoutes } = require('../../shared/model-prefix-routes');

test('只认最后一个横线，多一段就是另一代', () => {
  assert.strictEqual(modelExtends('deepseek-v4-flash', 'deepseek-v4-flash-ga'), true);
  assert.strictEqual(modelExtends('deepseek-v4-flash', 'deepseek-v4-flash-ga-260731'), false);
  assert.strictEqual(modelExtends('deepseek-v4-flash-ga', 'deepseek-v4-flash-ga-260731'), true);
  assert.strictEqual(modelExtends('glm-5', 'glm-5-turbo'), true);
  assert.strictEqual(modelExtends('glm-5', 'glm-5-2-260617'), false);
  assert.strictEqual(modelExtends('glm-5-2', 'glm-5-2-260617'), true);
  assert.strictEqual(modelExtends('deepseek-v4', 'deepseek-v4.1-flash'), false);
  assert.strictEqual(modelExtends('glm-5', 'glm-5.1'), false);
  assert.strictEqual(modelExtends('glm-5.3', 'glm-5.3-flash'), true);
  assert.strictEqual(modelExtends('gpt-4', 'gpt-4o'), false);
  assert.strictEqual(modelExtends('doubao-seed-2.0-lite', 'doubao-seed-2.0-pro'), false);
  assert.strictEqual(modelExtends('deepseek-flash', 'deepseek-v4-flash'), false);
});

test('变体收进最短前缀，近的排前面', () => {
  const { extras, hidden } = prefixModelRoutes([
    'deepseek-v4-flash-ga-260731',
    'deepseek-v4-flash',
    'deepseek-v4-flash-ga',
    'deepseek-v4-pro',
    'deepseek-v4-pro-260425',
    'doubao-seed-2.0-lite',
    'doubao-seed-2.0-pro',
  ]);
  assert.deepStrictEqual(extras.get('deepseek-v4-flash'), ['deepseek-v4-flash-ga']);
  assert.strictEqual(hidden.has('deepseek-v4-flash-ga-260731'), false);
  assert.deepStrictEqual(extras.get('deepseek-v4-pro'), ['deepseek-v4-pro-260425']);
  assert.deepStrictEqual(extras.get('doubao-seed-2.0-pro'), ['doubao-seed-2.0-lite']);
  assert.strictEqual(hidden.has('doubao-seed-2.0-lite'), true);
  const glm = prefixModelRoutes(['glm-5', 'glm-5.1', 'glm-5.2', 'glm-5.3', 'glm-5.3-flash', 'glm-5-turbo', 'glm-5-2-260617']);
  assert.strictEqual(glm.extras.has('glm-5.1'), false);
  assert.strictEqual(glm.hidden.has('glm-5-2-260617'), false);
  assert.deepStrictEqual(glm.extras.get('glm-5.3'), ['glm-5.3-flash']);
  assert.deepStrictEqual(glm.extras.get('glm-5'), ['glm-5-turbo']);
  assert.strictEqual(glm.hidden.has('glm-4.6v') || glm.extras.has('glm-4.6v'), false);
  const doubao = prefixModelRoutes([
    'doubao-seed-2.0-mini',
    'doubao-seed-2.0-code',
    'doubao-seed-2.1-lite',
    'doubao-seed-2.1-turbo',
    'glm-4.6v',
    'glm-5',
  ]);
  assert.deepStrictEqual(doubao.extras.get('doubao-seed-2.0-code'), ['doubao-seed-2.0-mini']);
  assert.strictEqual(doubao.hidden.has('doubao-seed-2.0-mini'), true);
  assert.deepStrictEqual(doubao.extras.get('doubao-seed-2.1-lite'), ['doubao-seed-2.1-turbo']);
  assert.strictEqual(doubao.extras.has('glm-5'), false);
  assert.strictEqual(doubao.extras.has('glm-4.6v'), false);
  assert.strictEqual(hidden.has('deepseek-v4-flash'), false);
  assert.strictEqual(hidden.has('deepseek-v4-flash-ga'), true);
  assert.deepStrictEqual(
    prefixExtensions('deepseek-v4-flash', ['deepseek-v4-flash-ga-260731', 'deepseek-v4-flash-ga', 'other']),
    ['deepseek-v4-flash-ga'],
  );
});
