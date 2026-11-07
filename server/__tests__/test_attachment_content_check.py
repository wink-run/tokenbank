"""
附件内容检查测试

验证check_input_safety对附件内容的安全检查：
1. 拒绝可执行文件（.exe, .sh, .bat等）
2. 检查文本文件内容中的危险命令
3. 检查文本文件内容中的敏感路径
4. 允许安全的文本和图片文件
"""

import pytest
import base64
import sys
import os

# 添加server目录到path以直接导入agent_safety模块
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


class TestAttachmentContentCheck:
    """附件内容安全检查测试"""

    def test_reject_executable_mime_type(self):
        """拒绝可执行文件MIME类型"""
        import agent_safety
        
        # 模拟.exe文件
        exe_content = b"MZ\x90\x00"  # PE header
        b64_content = base64.b64encode(exe_content).decode()
        
        files = [{
            "name": "malware.exe",
            "dataUrl": f"data:application/x-msdownload;base64,{b64_content}"
        }]
        
        is_safe, error = agent_safety.check_input_safety("", files=files)
        assert not is_safe
        assert "not allowed" in error.lower() or "executable" in error.lower()

    def test_reject_executable_extension(self):
        """拒绝危险扩展名（即使MIME type看起来正常）"""
        import agent_safety
        
        # 试图伪装成文本，但扩展名是.exe
        script = "echo hello"
        b64_content = base64.b64encode(script.encode()).decode()
        
        files = [{
            "name": "trojan.exe",
            "dataUrl": f"data:text/plain;base64,{b64_content}"
        }]
        
        is_safe, error = agent_safety.check_input_safety("", files=files)
        assert not is_safe
        assert "executable" in error.lower() or "not allowed" in error.lower()

    def test_reject_shell_script_extension(self):
        """拒绝shell脚本扩展名"""
        import agent_safety
        
        script = "#!/bin/bash\nrm -rf /"
        b64_content = base64.b64encode(script.encode()).decode()
        
        for ext in ['.sh', '.bash', '.bat', '.cmd', '.ps1']:
            files = [{
                "name": f"script{ext}",
                "dataUrl": f"data:text/plain;base64,{b64_content}"
            }]
            
            is_safe, error = agent_safety.check_input_safety("", files=files)
            assert not is_safe, f"Should reject {ext} files"

    def test_reject_text_with_dangerous_commands(self):
        """拒绝包含危险命令的文本文件"""
        import agent_safety
        
        # 文本文件包含rm -rf命令
        dangerous_script = """
        # Backup script
        echo "Starting backup..."
        rm -rf /tmp/old_backups
        echo "Done"
        """
        b64_content = base64.b64encode(dangerous_script.encode()).decode()
        
        files = [{
            "name": "backup.txt",
            "dataUrl": f"data:text/plain;base64,{b64_content}"
        }]
        
        is_safe, error = agent_safety.check_input_safety("", files=files)
        assert not is_safe
        assert "dangerous" in error.lower()

    def test_reject_text_with_sensitive_paths(self):
        """拒绝包含敏感路径的文本文件"""
        import agent_safety
        
        # JSON配置文件包含.ssh路径
        config = """
        {
            "ssh_key_path": "~/.ssh/id_rsa",
            "known_hosts": "~/.ssh/known_hosts"
        }
        """
        b64_content = base64.b64encode(config.encode()).decode()
        
        files = [{
            "name": "config.json",
            "dataUrl": f"data:application/json;base64,{b64_content}"
        }]
        
        is_safe, error = agent_safety.check_input_safety("", files=files)
        assert not is_safe
        assert "sensitive" in error.lower()

    def test_allow_safe_text_file(self):
        """允许安全的文本文件"""
        import agent_safety
        
        # 普通文本文件
        safe_content = """
        Hello World!
        This is a safe text file.
        It contains no dangerous commands or sensitive paths.
        """
        b64_content = base64.b64encode(safe_content.encode()).decode()
        
        files = [{
            "name": "readme.txt",
            "dataUrl": f"data:text/plain;base64,{b64_content}"
        }]
        
        is_safe, error = agent_safety.check_input_safety("", files=files)
        assert is_safe, f"Safe text should be allowed, got error: {error}"

    def test_allow_safe_json(self):
        """允许安全的JSON文件"""
        import agent_safety
        
        # 安全的JSON配置
        config = """
        {
            "app_name": "TestApp",
            "version": "1.0.0",
            "settings": {
                "theme": "dark",
                "language": "en"
            }
        }
        """
        b64_content = base64.b64encode(config.encode()).decode()
        
        files = [{
            "name": "config.json",
            "dataUrl": f"data:application/json;base64,{b64_content}"
        }]
        
        is_safe, error = agent_safety.check_input_safety("", files=files)
        assert is_safe

    def test_allow_image_files(self):
        """允许图片文件（不检查二进制内容）"""
        import agent_safety
        
        # 模拟PNG图片（magic bytes）
        png_content = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
        b64_content = base64.b64encode(png_content).decode()
        
        files = [{
            "name": "photo.png",
            "dataUrl": f"data:image/png;base64,{b64_content}"
        }]
        
        is_safe, error = agent_safety.check_input_safety("", files=files)
        assert is_safe, "Image files should be allowed"

    def test_decode_failure_must_reject(self):
        """解码失败必须拒绝（fail closed原则）"""
        import agent_safety
        
        # 无效的base64（故意破坏）
        files = [{
            "name": "data.txt",
            "dataUrl": "data:text/plain;base64,invalid!!!base64"
        }]
        
        is_safe, error = agent_safety.check_input_safety("", files=files)
        # 解码失败必须拒绝（fail closed）
        assert not is_safe
        assert "decode" in error.lower() or "base64" in error.lower()

    def test_multiple_files_one_dangerous(self):
        """多个附件中有一个危险文件，应该拒绝"""
        import agent_safety
        
        safe_content = base64.b64encode(b"Hello").decode()
        dangerous_content = base64.b64encode(b"rm -rf /").decode()
        
        files = [
            {
                "name": "safe.txt",
                "dataUrl": f"data:text/plain;base64,{safe_content}"
            },
            {
                "name": "危险.txt",
                "dataUrl": f"data:text/plain;base64,{dangerous_content}"
            }
        ]
        
        is_safe, error = agent_safety.check_input_safety("", files=files)
        assert not is_safe
        assert "dangerous" in error.lower()

    def test_prompt_and_file_both_checked(self):
        """prompt和附件都会被检查"""
        import agent_safety
        
        # prompt安全，但附件危险
        safe_prompt = "Please process this file"
        dangerous_file = base64.b64encode(b"sudo rm -rf /").decode()
        
        files = [{
            "name": "script.txt",
            "dataUrl": f"data:text/plain;base64,{dangerous_file}"
        }]
        
        is_safe, error = agent_safety.check_input_safety(safe_prompt, files=files)
        assert not is_safe

    def test_reject_unknown_mime_type(self):
        """拒绝未在允许列表中的MIME类型（fail closed）"""
        import agent_safety
        
        # PDF文件（未在允许列表中）
        pdf_content = b"%PDF-1.4\n%\xE2\xE3\xCF\xD3"
        b64_content = base64.b64encode(pdf_content).decode()
        
        files = [{
            "name": "document.pdf",
            "dataUrl": f"data:application/pdf;base64,{b64_content}"
        }]
        
        is_safe, error = agent_safety.check_input_safety("", files=files)
        assert not is_safe
        assert "not allowed" in error.lower() or "not in the allowed list" in error.lower()

    def test_reject_text_invalid_utf8(self):
        """拒绝声明为text但无法UTF-8解码的文件"""
        import agent_safety
        
        # 无效UTF-8字节序列
        invalid_utf8 = b'\x80\x81\x82\x83'
        b64_content = base64.b64encode(invalid_utf8).decode()
        
        files = [{
            "name": "invalid.txt",
            "dataUrl": f"data:text/plain;base64,{b64_content}"
        }]
        
        is_safe, error = agent_safety.check_input_safety("", files=files)
        assert not is_safe
        assert "utf-8" in error.lower() or "decode" in error.lower()

    def test_reject_image_wrong_magic_bytes(self):
        """拒绝magic bytes与MIME类型不匹配的图片"""
        import agent_safety
        
        # 声明为PNG但实际不是PNG
        fake_png = b"This is not a PNG file"
        b64_content = base64.b64encode(fake_png).decode()
        
        files = [{
            "name": "fake.png",
            "dataUrl": f"data:image/png;base64,{b64_content}"
        }]
        
        is_safe, error = agent_safety.check_input_safety("", files=files)
        assert not is_safe
        assert "magic bytes" in error.lower() or "mime type" in error.lower()

    def test_reject_archive_file(self):
        """拒绝归档文件（无法审核内部内容）"""
        import agent_safety
        
        # ZIP文件（禁止类型）
        zip_content = b"PK\x03\x04"  # ZIP magic bytes
        b64_content = base64.b64encode(zip_content).decode()
        
        files = [{
            "name": "archive.zip",
            "dataUrl": f"data:application/zip;base64,{b64_content}"
        }]
        
        is_safe, error = agent_safety.check_input_safety("", files=files)
        assert not is_safe


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
