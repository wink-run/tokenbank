/**
 * 测试前端done事件中parts和output的合并逻辑
 * 
 * 场景：工具调用完成后，done事件带来output，需要合并到parts
 */

// 模拟answerOf函数
function answerOf(row) {
  if (!row || !row.parts) return '';
  const textParts = row.parts.filter(p => p.type === 'text');
  return textParts.map(p => p.text).join('\n\n').trim();
}

// 模拟done事件处理逻辑
function handleDoneEvent(row, out) {
  if (!row.parts || !row.parts.length) {
    // 没有parts，直接设置content
    row.content = out || '(empty)';
    return;
  }
  
  // 有parts，尝试合并output
  const shown = answerOf(row);
  console.log(`  shown (from parts): "${shown}"`);
  console.log(`  out (from done): "${out}"`);
  
  if (out && out !== shown && !shown.includes(out) && !out.includes(shown)) {
    console.log('  → Condition 1 matched: add as new text part');
    row.parts.push({ type: 'text', text: out });
  } else if (out.startsWith(shown) && out.length > shown.length) {
    const extra = out.slice(shown.length).replace(/^\s+/, '');
    console.log(`  → Condition 2 matched: add extra text "${extra.slice(0, 50)}..."`);
    if (extra) {
      row.parts.push({ type: 'text', text: extra });
    }
  } else {
    console.log('  → No condition matched! Output NOT added to parts');
  }
  
  row.content = answerOf(row) || out || '(empty)';
}

console.log('=== 测试1: 只有工具parts，done带来完整输出 ===');
{
  const row = {
    parts: [
      { type: 'tool', name: 'execute_command', done: true }
    ]
  };
  const out = '图片已生成：output.png\n\n诗已放置在右上角。';
  
  handleDoneEvent(row, out);
  
  console.log('Final parts:', JSON.stringify(row.parts, null, 2));
  console.log('Final content:', row.content);
  console.log('');
}

console.log('=== 测试2: 有部分delta文本，工具后有更多输出 ===');
{
  const row = {
    parts: [
      { type: 'text', text: '让我' },
      { type: 'tool', name: 'generate_image', done: true }
    ]
  };
  const out = '让我生成一张图片。\n\n图片已完成。';
  
  handleDoneEvent(row, out);
  
  console.log('Final parts:', JSON.stringify(row.parts, null, 2));
  console.log('Final content:', row.content);
  console.log('');
}

console.log('=== 测试3: 空的done output ===');
{
  const row = {
    parts: [
      { type: 'tool', name: 'execute_command', done: true }
    ]
  };
  const out = '';
  
  handleDoneEvent(row, out);
  
  console.log('Final parts:', JSON.stringify(row.parts, null, 2));
  console.log('Final content:', row.content);
  console.log('');
}

console.log('=== 验证字符串包含逻辑 ===');
{
  const shown = '';
  const out = '一些文本';
  
  console.log(`shown = "${shown}"`);
  console.log(`out = "${out}"`);
  console.log(`shown.includes(out) = ${shown.includes(out)}`);  // false
  console.log(`out.includes(shown) = ${out.includes(shown)}`);  // true (空字符串!)
  console.log(`out.startsWith(shown) = ${out.startsWith(shown)}`);  // true
  console.log('');
  
  // 第一个条件
  const cond1 = out && out !== shown && !shown.includes(out) && !out.includes(shown);
  console.log('Condition 1:', cond1);  // false，因为 out.includes('') = true
  
  // 第二个条件
  const cond2 = out.startsWith(shown) && out.length > shown.length;
  console.log('Condition 2:', cond2);  // true
  
  const extra = out.slice(shown.length).replace(/^\s+/, '');
  console.log(`extra = "${extra}"`);  // 应该是完整的out
  console.log('');
}
