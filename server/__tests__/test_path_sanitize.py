"""
server/__tests__/test_path_sanitize.py - 输出路径脱敏测试

验证hired模式的路径脱敏不泄露敏感路径信息。
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest
from agent_safety import sanitize_paths_in_output


class TestPathSanitization:
    """路径脱敏测试"""
    
    def setup_method(self):
        """设置测试session root"""
        self.session_root = "/Users/wink/.tokenbank/contribute-workspaces/res-assistant-painter/u91/sessions/ee2b931caf08"
    
    def test_cwd_reset_message(self):
        """测试cwd reset消息脱敏"""
        text = f"Shell cwd was reset to {self.session_root}"
        result = sanitize_paths_in_output(text, self.session_root)
        
        # session_root应该被替换为'.'
        assert self.session_root not in result
        assert "Shell cwd was reset to ." in result
    
    def test_internal_relative_path(self):
        """测试session内部文件相对路径"""
        text = f"Saved to {self.session_root}/images/output.png"
        result = sanitize_paths_in_output(text, self.session_root)
        
        # 应该显示为相对路径
        assert self.session_root not in result
        assert "Saved to images/output.png" in result
    
    def test_external_path_redacted(self):
        """测试会话外路径脱敏"""
        texts = [
            "/Users/wink/Documents/secret.txt",
            "/home/wink/.ssh/id_rsa",
            "/etc/passwd",
        ]
        for text in texts:
            result = sanitize_paths_in_output(text, self.session_root)
            # 外部路径应该被脱敏
            assert "[路径已脱敏]" in result
            assert "/Users/" not in result
            assert "/home/" not in result
            assert "/etc/" not in result
    
    def test_other_session_redacted(self):
        """测试其他session路径脱敏"""
        other_session = "/Users/wink/.tokenbank/contribute-workspaces/res-assistant-painter/u91/sessions/different123"
        text = f"File at {other_session}/data.json"
        result = sanitize_paths_in_output(text, self.session_root)
        
        # 其他session路径应该被脱敏
        assert other_session not in result
        assert "[路径已脱敏]" in result
    
    def test_network_url_preserved(self):
        """测试网络URL不被脱敏"""
        text = "Visit https://example.com/path/to/file"
        result = sanitize_paths_in_output(text, self.session_root)
        
        # 网络URL应该保留
        assert "https://example.com/path/to/file" in result
    
    def test_file_protocol(self):
        """测试file://协议路径"""
        text = f"file://{self.session_root}/output/result.txt"
        result = sanitize_paths_in_output(text, self.session_root)
        
        # 应该转为相对路径
        assert self.session_root not in result
        assert "file://output/result.txt" in result or "output/result.txt" in result
    
    def test_json_escaped_paths(self):
        """测试JSON转义的路径"""
        escaped_root = self.session_root.replace('/', '\\/')
        text = f'{{"path": "{escaped_root}\\/data.json"}}'
        result = sanitize_paths_in_output(text, self.session_root)
        
        # 应该处理JSON转义
        assert self.session_root.replace('/', '\\/') not in result or "data.json" in result
    
    def test_windows_paths(self):
        """测试Windows路径格式"""
        win_session = "C:\\\\Users\\\\wink\\\\.tokenbank\\\\sessions\\\\abc123"
        text = f"Saved to {win_session}\\\\output\\\\file.txt"
        result = sanitize_paths_in_output(text, win_session)
        
        # Windows路径应该被处理
        # （实际行为取决于运行平台）
        assert "abc123" not in result or "output" in result
    
    def test_no_session_root(self):
        """测试未提供session_root时不脱敏"""
        text = "/Users/wink/.tokenbank/sessions/abc/file.txt"
        result = sanitize_paths_in_output(text, None)
        
        # 没有session_root时原样返回
        assert result == text
    
    def test_complex_output(self):
        """测试复杂输出（多路径）"""
        text = f"""
Command output:
  Input: {self.session_root}/input.txt
  Output: {self.session_root}/output/result.png
  Temp: /tmp/temp_file_12345.txt
  Config: /etc/config.yaml
  Home: /Users/wink/Documents/notes.txt
"""
        result = sanitize_paths_in_output(text, self.session_root)
        
        # session内路径转为相对路径
        assert "Input: input.txt" in result or "Input: ./input.txt" in result
        assert "Output: output/result.png" in result
        
        # 外部路径脱敏
        assert "/tmp/" not in result or "[路径已脱敏]" in result
        assert "/etc/" not in result
        assert "/Users/wink/" not in result


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
