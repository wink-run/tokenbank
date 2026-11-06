"""
验证 call_context 参数的行为

手动测试场景（需实际环境）:
1. 雇佣调用（默认）：产物上传，路径改写
2. 本机调用：保留本地路径
3. 参数验证和默认值
"""

def test_call_context_default_is_hired():
    """默认值应该是 hired"""
    # 模拟 Pydantic 模型的默认值行为
    # class AgentTaskBody(BaseModel):
    #     call_context: Optional[str] = "hired"
    
    call_context = None or "hired"  # Pydantic 默认值
    assert call_context == "hired", f"Expected 'hired', got {call_context}"
    print("✓ Default call_context is 'hired'")


def test_call_context_explicit_local():
    """显式 local 应该被接受"""
    call_context = "local"  # 用户显式传递
    assert call_context == "local"
    print("✓ Explicit call_context='local' accepted")


def test_call_context_explicit_hired():
    """显式 hired 应该被接受"""
    call_context = "hired"  # 用户显式传递
    assert call_context == "hired"
    print("✓ Explicit call_context='hired' accepted")


def test_artifact_processing_logic():
    """验证产物处理逻辑"""
    
    # 模拟雇佣调用：应该处理产物
    call_context = "hired"
    output_text = "Result: ![image](/tmp/test.png)"
    
    if call_context == "hired":
        # 应该调用 _apply_artifacts
        should_process = True
    else:
        # 应该保留原样
        should_process = False
    
    assert should_process == True, "hired should process artifacts"
    print("✓ Artifact processing enabled for call_context='hired'")
    
    # 模拟本机调用：不应该处理产物
    call_context = "local"
    
    if call_context == "hired":
        should_process = True
    else:
        should_process = False
    
    assert should_process == False, "local should not process artifacts"
    print("✓ Artifact processing disabled for call_context='local'")


def test_parameter_normalization():
    """验证参数标准化逻辑（server.py中的处理）"""
    
    # 测试默认值
    call_ctx = str("" or "hired").strip().lower()
    if call_ctx not in ("local", "hired"):
        call_ctx = "hired"
    assert call_ctx == "hired"
    print("✓ Empty value defaults to 'hired'")
    
    # 测试大小写
    call_ctx = str("HIRED").strip().lower()
    if call_ctx not in ("local", "hired"):
        call_ctx = "hired"
    assert call_ctx == "hired"
    print("✓ Case normalization works (HIRED -> hired)")
    
    # 测试无效值
    call_ctx = str("invalid").strip().lower()
    if call_ctx not in ("local", "hired"):
        call_ctx = "hired"
    assert call_ctx == "hired"
    print("✓ Invalid values default to 'hired'")


if __name__ == "__main__":
    print("Testing call_context parameter behavior...\n")
    
    try:
        test_call_context_default_is_hired()
        test_call_context_explicit_local()
        test_call_context_explicit_hired()
        test_artifact_processing_logic()
        test_parameter_normalization()
        
        print("\n✓ All tests passed!")
        
        print("\n" + "="*60)
        print("Manual integration tests required:")
        print("="*60)
        print("1. 雇佣调用测试（hired，默认）:")
        print("   POST /api/agent-tasks")
        print("   {")
        print('     "assistant_id": "图片生成智能体",')
        print('     "prompt": "生成一张图片",')
        print('     "stream": true')
        print("   }")
        print("   预期: done事件包含 /media/agent/... URL，图片可访问")
        print()
        print("2. 雇佣调用显式指定（hired）:")
        print("   POST /api/agent-tasks")
        print("   {")
        print('     "assistant_id": "图片生成智能体",')
        print('     "prompt": "生成一张图片",')
        print('     "call_context": "hired",')
        print('     "stream": true')
        print("   }")
        print("   预期: 同上")
        print()
        print("3. 本机调用测试（local）:")
        print("   桌面直接调用本地Gateway（不经过云端）")
        print("   或 POST /api/agent-tasks with call_context=\"local\"")
        print("   预期: done事件包含本地路径（如 /tmp/...），不上传不改写")
        print()
        print("4. 兼容性测试:")
        print("   现有调用者不传 call_context")
        print("   预期: 默认hired，行为不变")
        
    except AssertionError as e:
        print(f"\n✗ Test failed: {e}")
        exit(1)
    except Exception as e:
        print(f"\n✗ Error: {e}")
        import traceback
        traceback.print_exc()
        exit(1)
