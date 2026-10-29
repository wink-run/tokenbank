'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('serializeImageSrc 保留 tbimg / http，丢掉裸 base64', async () => {
  const {
    B64_OMITTED, serializeImageSrc, isImageRef, isKeptImageSrc,
  } = await import('../../src/lib/debug-image-store.js');
  assert.equal(serializeImageSrc('tbimg:abc'), 'tbimg:abc');
  assert.equal(serializeImageSrc('https://cdn.example/a.png'), 'https://cdn.example/a.png');
  assert.equal(serializeImageSrc('data:image/png;base64,AAAA'), B64_OMITTED);
  assert.equal(serializeImageSrc(''), B64_OMITTED);
  assert.equal(serializeImageSrc('tbfile:notes.txt'), 'tbfile:notes.txt');
  assert.equal(isImageRef('tbimg:abc'), true);
  assert.equal(isKeptImageSrc('tbimg:abc'), true);
});

test('collectImageRefIds 从消息里抽出 tbimg id，忽略 http / 占位', async () => {
  const { collectImageRefIds, B64_OMITTED } = await import('../../src/lib/debug-image-store.js');
  const ids = collectImageRefIds([
    { role: 'user', content: 'hi', images: ['tbimg:aaa'] },
    { role: 'assistant', images: ['https://x/y.png', B64_OMITTED, 'tbimg:bbb'] },
  ]);
  assert.deepEqual([...ids].sort(), ['aaa', 'bbb']);
});

test('unreferencedImageIds 只留下 keep 之外的 id', async () => {
  const { unreferencedImageIds } = await import('../../src/lib/debug-image-store.js');
  assert.deepEqual(
    unreferencedImageIds(['keep-me', 'drop-me', ''], new Set(['keep-me'])),
    ['drop-me'],
  );
});
