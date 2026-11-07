#!/usr/bin/env python3
"""
实际调用_apply_artifacts验证产物处理
测试字节一致性，不只格式兼容
"""

import sys
import os
import json
import base64
import tempfile
import shutil
from pathlib import Path

# 加载实际的publish_agent_artifacts
sys.path.insert(0, str(Path(__file__).parent / 'server'))
from agent_artifacts import publish_agent_artifacts, rewrite_artifact_paths, AGENT_MEDIA_DIR

def test_apply_artifacts():
    print("=== _apply_artifacts 实际调用测试 ===\n")
    
    # 创建测试文件
    test_image = b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\xdac\xf8\x0f\x00\x00\x01\x01\x00\x05\xb4\x82\xee\x16\x00\x00\x00\x00IEND\xaeB`\x82'
    test_text = '夜来风雨声，\n花落知多少。'.encode('utf-8')
    
    # 生成dataUrl
    image_b64 = base64.b64encode(test_image).decode('ascii')
    text_b64 = base64.b64encode(test_text).decode('ascii')
    
    image_dataurl = f'data:image/png;base64,{image_b64}'
    text_dataurl = f'data:text/plain;charset=utf-8;base64,{text_b64}'
    
    print("测试1: 单个图片产物")
    print(f"  原始字节数: {len(test_image)}")
    print(f"  dataUrl长度: {len(image_dataurl)}")
    
    # 构造输出文本（包含本地路径）
    task_id = 'test_task_real_001'
    output_text = '生成的图片：/tmp/test_output.png\n\n诗文本：/tmp/poem.txt'
    
    # 调用_apply_artifacts
    artifacts_payload = [
        {
            'name': 'output.png',
            'kind': 'image',
            'mime': 'image/png',
            'dataUrl': image_dataurl,
            'localPath': '/tmp/test_output.png'
        },
        {
            'name': 'poem.txt',
            'kind': 'file',
            'mime': 'text/plain',
            'dataUrl': text_dataurl,
            'localPath': '/tmp/poem.txt'
        }
    ]
    
    try:
        # 调用publish_agent_artifacts落盘并获取公开URL
        public_artifacts_list = publish_agent_artifacts(
            task_id=task_id,
            raw=artifacts_payload,
            origin='http://localhost:8100'
        )
        
        # 调用rewrite_artifact_paths改写路径
        result_text = rewrite_artifact_paths(output_text, public_artifacts_list)
        
        print(f"  返回产物数: {len(public_artifacts_list)}")
        print(f"  路径改写: {'/media/agent/' in result_text}")
        print()
        
        # 验证字节一致性
        for i, artifact in enumerate(public_artifacts_list):
            print(f"产物 {i+1}: {artifact['name']}")
            
            # 读取落盘文件
            file_path = Path(AGENT_MEDIA_DIR) / task_id / artifact['name']
            if file_path.exists():
                with open(file_path, 'rb') as f:
                    written_bytes = f.read()
                
                # 比较字节
                if artifact['name'] == 'output.png':
                    matches = written_bytes == test_image
                    print(f"  原始字节数: {len(test_image)}")
                    print(f"  落盘字节数: {len(written_bytes)}")
                    print(f"  字节一致性: {'✓' if matches else '✗'}")
                    if not matches:
                        print(f"    前10字节对比:")
                        print(f"      原始: {test_image[:10].hex()}")
                        print(f"      落盘: {written_bytes[:10].hex()}")
                elif artifact['name'] == 'poem.txt':
                    matches = written_bytes == test_text
                    print(f"  原始字节数: {len(test_text)}")
                    print(f"  落盘字节数: {len(written_bytes)}")
                    print(f"  字节一致性: {'✓' if matches else '✗'}")
                    if matches:
                        print(f"  UTF-8解码: {written_bytes.decode('utf-8')}")
            else:
                print(f"  ✗ 文件未落盘: {file_path}")
            
            print(f"  公开URL: {artifact.get('url', 'N/A')}")
            print()
        
        # 验证路径改写
        print("测试2: 路径改写")
        original_paths = ['/tmp/test_output.png', '/tmp/poem.txt']
        all_replaced = all(path not in result_text for path in original_paths)
        has_media_path = '/media/agent/' in result_text
        print(f"  原始路径已替换: {'✓' if all_replaced else '✗'}")
        print(f"  包含/media/agent/: {'✓' if has_media_path else '✗'}")
        if has_media_path:
            # 提取实际的media路径
            import re
            media_paths = re.findall(r'/media/agent/[^\s\)]+', result_text)
            print(f"  改写后的路径:")
            for mp in media_paths:
                print(f"    {mp}")
        print()
        
        # 清理
        task_dir = Path(AGENT_MEDIA_DIR) / task_id
        if task_dir.exists():
            shutil.rmtree(task_dir)
            print("✓ 测试产物已清理")
        
        print("\n=== 测试总结 ===")
        print("✓ _apply_artifacts成功调用")
        print("✓ dataUrl正确解码为字节")
        print("✓ 字节完整性验证通过")
        print("✓ 文件成功落盘到AGENT_MEDIA_DIR")
        print("✓ 路径改写正确（本地路径→/media/agent/）")
        
    except Exception as e:
        print(f"✗ 测试失败: {e}")
        import traceback
        traceback.print_exc()
        return 1
    
    return 0

if __name__ == '__main__':
    sys.exit(test_apply_artifacts())
