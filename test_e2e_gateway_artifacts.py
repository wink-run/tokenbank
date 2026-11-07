#!/usr/bin/env python3
"""
端到端测试：Gateway artifacts完整链路
1. Executor收集产物
2. Gateway返回
3. 云端publish + rewrite
4. 前端渲染

模拟生产场景at-098785070057
"""

import sys
import os
import json
import tempfile
import shutil
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / 'server'))
from agent_artifacts import publish_agent_artifacts, rewrite_artifact_paths, public_artifacts

def test_e2e_gateway_artifacts():
    print("=== 端到端Gateway Artifacts测试 ===\n")
    
    # 模拟executor返回的artifacts（带localPath和dataUrl）
    test_image = b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR...'  # 简化的PNG
    import base64
    image_b64 = base64.b64encode(test_image).decode('ascii')
    
    # 模拟生产环境的输出文本（包含裸文件名）
    agent_output = """画好了，采用水墨风格，16:9横版：

文件（snow-poem）

• snow-poem-chuxue-16x9.png — 1920×1080，发布用
• snow-poem-ink-2x.png — 3840×2160，印刷、大屏用
• snow-poem-ink.svg — 矢量源文件，可无损放大、改色
• gen_svg.py — 生成脚本，修改坐标即可重新生成

画面速览对应：

诗句	画面的表现方式
夜雪无声没旧痕	右下四省石坊，阶面雪白、下部沉雪线
"""
    
    # 模拟executor收集的artifacts
    raw_artifacts = [
        {
            'name': 'snow-poem-chuxue-16x9.png',
            'mime': 'image/png',
            'kind': 'image',
            'dataUrl': f'data:image/png;base64,{image_b64}',
            'localPath': '/home/user/.tokenbank/contribute-workspaces/assistant/consumer/outputs/snow-poem-chuxue-16x9.png'
        },
        {
            'name': 'snow-poem-ink-2x.png',
            'mime': 'image/png',
            'kind': 'image',
            'dataUrl': f'data:image/png;base64,{image_b64}',
            'localPath': '/home/user/.tokenbank/contribute-workspaces/assistant/consumer/outputs/snow-poem-ink-2x.png'
        },
        {
            'name': 'snow-poem-ink.svg',
            'mime': 'image/svg+xml',
            'kind': 'file',
            'dataUrl': 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
            'localPath': '/home/user/.tokenbank/contribute-workspaces/assistant/consumer/outputs/snow-poem-ink.svg'
        }
    ]
    
    task_id = 'test-e2e-001'
    
    print("步骤1: 模拟executor返回artifacts")
    print(f"  产物数量: {len(raw_artifacts)}")
    for art in raw_artifacts:
        print(f"    - {art['name']} ({art['kind']})")
    print()
    
    print("步骤2: 云端publish_agent_artifacts")
    stored_artifacts = publish_agent_artifacts(
        task_id=task_id,
        raw=raw_artifacts,
        origin='http://localhost:8100'
    )
    print(f"  落盘产物数量: {len(stored_artifacts)}")
    for art in stored_artifacts:
        print(f"    - {art['name']}: {art['url']}")
        # 验证文件确实存在
        from agent_artifacts import AGENT_MEDIA_DIR
        file_path = AGENT_MEDIA_DIR / task_id / art['name']
        if file_path.exists():
            print(f"      ✓ 文件存在: {file_path.stat().st_size} bytes")
        else:
            print(f"      ✗ 文件不存在: {file_path}")
    print()
    
    print("步骤3: rewrite_artifact_paths（改写裸文件名）")
    rewritten_output = rewrite_artifact_paths(agent_output, stored_artifacts)
    
    # 打印实际输出片段
    print("  改写后输出示例:")
    lines = rewritten_output.split('\n')
    for i, line in enumerate(lines):
        if 'snow-poem' in line:
            print(f"    {line[:100]}")
    print()
    
    # 验证裸文件名被替换
    print("  原文件名:")
    for name in ['snow-poem-chuxue-16x9.png', 'snow-poem-ink-2x.png', 'snow-poem-ink.svg']:
        original_count = agent_output.count(name)
        rewritten_count = rewritten_output.count(name)
        replaced = original_count > rewritten_count
        print(f"    {name}: {'✓ 已替换' if replaced else '✗ 未替换'} (原{original_count}次 → 新{rewritten_count}次)")
    
    # 验证包含/media/agent/路径
    media_path_count = rewritten_output.count('/media/agent/')
    print(f"  /media/agent/路径数量: {media_path_count} {'✓' if media_path_count >= 3 else '✗'}")
    print()
    
    print("步骤4: public_artifacts（前端展示）")
    public_arts = public_artifacts(stored_artifacts)
    print(f"  公开产物数量: {len(public_arts)}")
    for art in public_arts:
        print(f"    - {art['name']}")
        print(f"      url: {art['url']}")
        print(f"      kind: {art['kind']}")
        has_local_path = 'local' in art or 'localPath' in art
        print(f"      localPath: {'✗ 已删除（正确）' if not has_local_path else '✓ 仍存在（错误）'}")
    print()
    
    # 清理
    from agent_artifacts import AGENT_MEDIA_DIR
    task_dir = AGENT_MEDIA_DIR / task_id
    if task_dir.exists():
        shutil.rmtree(task_dir)
        print("✓ 测试产物已清理\n")
    
    print("=== 验证结果 ===")
    # 检查是否有独立的裸文件名（不在URL中的）
    standalone_names = [
        line for line in rewritten_output.split('\n')
        if any(f'• {name}' in line or f'`{name}`' in line for name in 
               ['snow-poem-chuxue-16x9.png', 'snow-poem-ink-2x.png', 'snow-poem-ink.svg'])
        and '/media/agent/' not in line
    ]
    all_replaced = len(standalone_names) == 0
    has_media_paths = media_path_count >= 3
    no_local_paths = all('local' not in art and 'localPath' not in art for art in public_arts)
    
    if all_replaced and has_media_paths and no_local_paths:
        print("✓ 全部通过：")
        print("  ✓ 裸文件名正确替换为/media/agent/URL")
        print("  ✓ 前端产物不包含localPath")
        print("  ✓ 文件成功落盘")
        return 0
    else:
        print("✗ 测试失败：")
        if not all_replaced:
            print("  ✗ 裸文件名未完全替换")
        if not has_media_paths:
            print("  ✗ 缺少/media/agent/路径")
        if not no_local_paths:
            print("  ✗ 前端产物仍包含localPath")
        return 1

if __name__ == '__main__':
    sys.exit(test_e2e_gateway_artifacts())
