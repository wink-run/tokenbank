"""
最小冒烟：验证dispatch_agent在无package parent方式加载时不会ImportError

生产场景：proxy容器将dispatch_agent.py作为顶层模块加载（不在包内）
相对导入`from .agent_safety import ...`会失败
绝对导入`from agent_safety import ...`成功

此测试模拟容器顶层加载场景
"""

import sys
import os
from pathlib import Path

def test_dispatch_agent_import_no_package():
    """dispatch_agent.py在无package parent时可以import（不会相对导入失败）"""
    # 确保server目录在sys.path中（模拟容器环境）
    server_dir = Path(__file__).parent.parent.absolute()
    if str(server_dir) not in sys.path:
        sys.path.insert(0, str(server_dir))
    
    # 尝试导入dispatch_agent（会触发所有顶层导入和条件导入）
    try:
        import dispatch_agent
        # 验证关键函数存在
        assert hasattr(dispatch_agent, 'handle_agent_task')
        assert hasattr(dispatch_agent, 'iter_agent_task_sse')
    except ImportError as e:
        # 如果是相对导入错误，应该失败
        if "relative import" in str(e).lower():
            raise AssertionError(f"Relative import failed (should use absolute): {e}")
        raise

def test_agent_safety_absolute_import():
    """agent_safety可以被绝对导入"""
    server_dir = Path(__file__).parent.parent.absolute()
    if str(server_dir) not in sys.path:
        sys.path.insert(0, str(server_dir))
    
    # 绝对导入应该成功
    from agent_safety import check_input_safety, check_output_safety, sanitize_paths_in_output
    
    # 验证函数可调用
    assert callable(check_input_safety)
    assert callable(check_output_safety)
    assert callable(sanitize_paths_in_output)

if __name__ == "__main__":
    # 直接执行（无pytest）
    print("Testing dispatch_agent import without package parent...")
    test_dispatch_agent_import_no_package()
    print("✓ dispatch_agent imports successfully")
    
    print("Testing agent_safety absolute import...")
    test_agent_safety_absolute_import()
    print("✓ agent_safety imports successfully")
    
    print("\nAll smoke tests passed!")
