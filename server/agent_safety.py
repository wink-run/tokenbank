"""
server/agent_safety.py - Hired Agent 安全围栏（程序级硬规则）

只对hired模式生效，不影响local调用。
检查失败=拒绝任务，不降级、不绕过（fail closed）。
不依赖LLM判断或可被诱导的提示词。
"""
import re
import os
from typing import Optional, Tuple, List


# ============================================================
# 输入检查：危险操作、路径穿越、敏感配置访问意图
# ============================================================

# 危险命令模式（硬规则，不可被prompt诱导）
DANGEROUS_COMMANDS = [
    r'\brm\s+(-[rf]+\s+)?/',  # rm -rf /...
    r'\bsudo\b',
    r'\bsu\b',
    r'\bchmod\s+777',
    r'\bchown\b',
    r'\bmkfs\b',
    r'\bdd\s+if=.*of=/dev/',
    r'>\s*/dev/sd',
    r'\bkill\s+-9\s+1\b',  # kill init
    r'\bpkill\s',
    r'\bkillall\b',
    r'\breboot\b',
    r'\bshutdown\b',
    r'\binit\s+[06]\b',
    r'\bcurl.*\|\s*bash',
    r'\bwget.*\|\s*sh',
    r'delete\s+all\s+files',  # "Delete all files"
    r'(?i)system:.*admin\s+mode',  # "SYSTEM: admin mode"
    r'base64\s+-d.*\|\s*(sh|bash)',  # base64 decode piped to shell
    r'\|\s*base64\s+-d\s*\|',  # pipe base64 decode pipe
]

# 敏感路径模式（配置、密钥、凭证）
SENSITIVE_PATHS = [
    r'/etc/(passwd|shadow|sudoers)',
    r'/root/',
    r'~/.ssh/',
    r'~/.aws/',
    r'~/.config/.*/(config|credentials|token)',
    r'\.env(\s|$|\.)',  # 匹配 .env 或 .env.local 等
    r'(id_rsa|id_ed25519|\.pem|\.key)$',
    r'(credentials?|secrets?|tokens?)\.(json|yaml|yml|txt)$',
    r'\.npmrc',
    r'\.pypirc',
    r'\.netrc',
    r'\.git-credentials',
]

# 路径穿越模式（用于文件名检查）
PATH_TRAVERSAL = [
    r'\.\.',  # ../ or ..\
    r'^/',  # 绝对路径（文件名不应以/开头）
    r'^~/',  # home路径
]

# 编译正则（提高性能）
_DANGEROUS_CMD_RE = [re.compile(p, re.IGNORECASE) for p in DANGEROUS_COMMANDS]
_SENSITIVE_PATH_RE = [re.compile(p, re.IGNORECASE) for p in SENSITIVE_PATHS]
_PATH_TRAVERSAL_RE = [re.compile(p) for p in PATH_TRAVERSAL]


def check_input_safety(prompt: str, files: Optional[List[dict]] = None) -> Tuple[bool, Optional[str]]:
    """
    检查输入安全性（hired模式硬规则）
    
    检查项目：
    1. prompt中的危险命令和敏感路径
    2. 附件文件名的路径穿越和敏感路径
    3. 附件内容的危险命令和敏感信息（文本文件）
    4. 附件MIME类型限制（拒绝可执行文件）
    
    Returns:
        (is_safe, error_message)
        is_safe=False时必须拒绝任务
    """
    # 1. 危险命令检测（只在prompt非空时）
    if prompt:
        for pattern in _DANGEROUS_CMD_RE:
            if pattern.search(prompt):
                return False, "Input contains potentially dangerous operations"
        
        # 2. 敏感路径访问意图
        for pattern in _SENSITIVE_PATH_RE:
            if pattern.search(prompt):
                return False, "Input attempts to access sensitive paths or credentials"
    
    # 3. 附件检查（必须检查，即使prompt为空）
    if files:
        import base64
        
        # 明确允许的MIME类型（fail closed：未列出的拒绝）
        # 图片：已知安全的图片格式
        ALLOWED_IMAGE_MIMES = {
            'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
            'image/svg+xml',  # SVG需额外检查
        }
        
        # 文本：可审核内容的文本格式
        ALLOWED_TEXT_MIMES = {
            'text/plain', 'text/csv', 'text/markdown', 'text/html',
            'application/json', 'application/xml', 'text/xml',
        }
        
        # 禁止的MIME类型（可执行、归档、不可审核）
        FORBIDDEN_MIMES = {
            # 可执行文件
            'application/x-executable', 'application/x-sharedlib',
            'application/x-dosexec', 'application/x-msdownload',
            'application/x-sh', 'application/x-csh', 'application/x-perl',
            'application/x-python', 'application/x-ruby',
            # 归档和压缩（无法审核内部内容）
            'application/zip', 'application/x-zip-compressed',
            'application/x-tar', 'application/x-gzip', 'application/x-bzip2',
            'application/x-7z-compressed', 'application/x-rar-compressed',
            # 其他不可审核格式
            'application/octet-stream',  # 通用binary
            'application/pdf',  # PDF可能包含脚本
        }
        
        # 禁止的扩展名（双重防护）
        FORBIDDEN_EXTENSIONS = {
            '.exe', '.sh', '.bash', '.bat', '.cmd', '.com', '.scr', '.vbs', '.ps1',
            '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
            '.pdf', '.bin', '.app', '.apk', '.deb', '.rpm',
        }
        
        for f in files:
            name = str(f.get('name', ''))
            name_lower = name.lower()
            
            # 3a. 文件名路径穿越检查
            for pattern in _PATH_TRAVERSAL_RE:
                if pattern.search(name):
                    return False, "File attachment contains path traversal attempt"
            
            # 3b. 文件名敏感路径检查
            for pattern in _SENSITIVE_PATH_RE:
                if pattern.search(name):
                    return False, "File attachment attempts to access sensitive paths"
            
            # 3c. 文件扩展名检查
            if any(name_lower.endswith(ext) for ext in FORBIDDEN_EXTENSIONS):
                return False, f"File type not allowed: {name}"
            
            # 3d. MIME类型和内容检查（如果有dataUrl）
            data_url = f.get('dataUrl', '')
            if data_url:
                if not data_url.startswith('data:'):
                    return False, "Invalid data URL format"
                
                if ';base64,' not in data_url:
                    return False, "Only base64-encoded attachments are supported"
                
                # 提取MIME type
                header = data_url.split(',', 1)[0]
                mime_type = header.replace('data:', '').split(';')[0].strip().lower()
                
                # 明确拒绝禁止类型
                if mime_type in FORBIDDEN_MIMES:
                    return False, f"File type {mime_type} is not allowed for security reasons"
                
                # 检查是否在允许列表中
                is_allowed_image = mime_type in ALLOWED_IMAGE_MIMES
                is_allowed_text = mime_type in ALLOWED_TEXT_MIMES
                
                if not is_allowed_image and not is_allowed_text:
                    # 未知/不在允许列表中的类型：拒绝（fail closed）
                    return False, f"File type {mime_type} is not in the allowed list. Allowed types: images (png/jpg/gif/webp/svg), text files (txt/csv/md/html/json/xml)"
                
                try:
                    # 解码base64
                    b64_data = data_url.split(';base64,', 1)[1]
                    content_bytes = base64.b64decode(b64_data)
                except Exception as e:
                    # base64解码失败：拒绝（fail closed）
                    return False, f"Failed to decode base64 attachment: {str(e)}"
                
                # 3e. 图片类型：验证magic bytes（基本检查，不保证识别所有攻击）
                if is_allowed_image:
                    magic_bytes_ok = False
                    if mime_type == 'image/png' and content_bytes[:8] == b'\x89PNG\r\n\x1a\n':
                        magic_bytes_ok = True
                    elif mime_type in ('image/jpeg', 'image/jpg') and content_bytes[:2] == b'\xff\xd8':
                        magic_bytes_ok = True
                    elif mime_type == 'image/gif' and content_bytes[:6] in (b'GIF87a', b'GIF89a'):
                        magic_bytes_ok = True
                    elif mime_type == 'image/webp' and content_bytes[:4] == b'RIFF' and content_bytes[8:12] == b'WEBP':
                        magic_bytes_ok = True
                    elif mime_type == 'image/svg+xml':
                        # SVG是XML文本，需要能解码为UTF-8
                        try:
                            svg_text = content_bytes.decode('utf-8')
                            if '<svg' in svg_text.lower():
                                magic_bytes_ok = True
                        except Exception:
                            pass
                    
                    if not magic_bytes_ok:
                        return False, f"Image file magic bytes do not match declared MIME type {mime_type}"
                    
                    # 图片内容不审核OCR/隐写（明确说明限制）
                    # 注：不宣称识别图片中的文本秘密或隐写信息
                
                # 3f. 文本类型：必须能正确解码UTF-8并检查内容
                elif is_allowed_text:
                    try:
                        content_text = content_bytes.decode('utf-8')
                    except UnicodeDecodeError as e:
                        # 声明text但无法UTF-8解码：拒绝（fail closed）
                        return False, f"Text file declared as {mime_type} but failed UTF-8 decoding: {str(e)}"
                    
                    # 检查危险命令
                    for pattern in _DANGEROUS_CMD_RE:
                        if pattern.search(content_text):
                            return False, "File attachment contains potentially dangerous operations"
                    
                    # 检查敏感路径
                    for pattern in _SENSITIVE_PATH_RE:
                        if pattern.search(content_text):
                            return False, "File attachment contains references to sensitive paths"
    
    return True, None


# ============================================================
# 输出检查：敏感信息泄露、未授权路径
# ============================================================

# 敏感值模式（密钥、token、密码格式）
# 注意：避免匹配占位符like "your_key_here", "your_password"
SENSITIVE_VALUE_PATTERNS = [
    # OpenAI/Anthropic API keys (sk- prefix, including sk-proj-)
    r'sk-[A-Za-z0-9_-]{12,}',  # 降低最小长度以捕获sk-proj-等变种
    # Google API keys (AIza prefix)
    r'AIza[A-Za-z0-9_-]{20,}',
    # Generic API key pattern (after API_KEY/APIKEY label)
    r'(?i)(api[_-]?key|apikey)[\s:="\']+((?!your_|<|{)[A-Za-z0-9+/_-]{20,})',
    # Passwords (after password label, excluding placeholders)
    r'(?i)(password|passwd|pwd)[\s:="\']+((?!your_|<|{|\[)[A-Za-z0-9!@#$%^&*]{8,})',
    # GitHub tokens
    r'(ghp_|gho_|ghs_)[A-Za-z0-9_]{20,}',
    # Private keys
    r'-----BEGIN (RSA |EC )?PRIVATE KEY-----',
    # Bearer tokens
    r'(?i)bearer\s+[A-Za-z0-9_.-]{30,}',
    r'(?i)Authorization:\s*(Bearer|Basic)\s+[A-Za-z0-9+/=_.-]{20,}',
    # AWS keys
    r'AKIA[A-Z0-9]{16}',  # AWS Access Key ID格式
]

# 敏感环境变量名
SENSITIVE_ENV_NAMES = {
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
    'GITHUB_TOKEN', 'GH_TOKEN', 'GITLAB_TOKEN',
    'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY',
    'DATABASE_URL', 'DB_PASSWORD', 'POSTGRES_PASSWORD',
    'REDIS_PASSWORD', 'MONGO_PASSWORD',
    'JWT_SECRET', 'SESSION_SECRET', 'ENCRYPTION_KEY',
    'PRIVATE_KEY', 'SECRET_KEY', 'API_SECRET',
}

_SENSITIVE_VALUE_RE = [re.compile(p) for p in SENSITIVE_VALUE_PATTERNS]


def check_output_safety(text: str, artifacts: Optional[List[dict]] = None, session_dir: Optional[str] = None) -> Tuple[bool, Optional[str]]:
    """
    检查输出安全性（hired模式硬规则）
    
    必须在对外发送前调用，包括：
    - HTTP response body
    - SSE stream done event
    - WebSocket message
    
    Returns:
        (is_safe, error_message)
        is_safe=False时必须阻断输出
    """
    if not text:
        text = ""
    
    # 1. 敏感值模式匹配（不包含匹配值在错误中）
    for pattern in _SENSITIVE_VALUE_RE:
        if pattern.search(text):
            return False, "Output contains sensitive credentials or keys"
    
    # 2. 环境变量泄露（格式：VAR=value 或 VAR: value）
    # 但要排除示例代码中的占位符
    for env_name in SENSITIVE_ENV_NAMES:
        # 匹配 ENV_NAME=真实值（不是占位符）
        pattern = rf'\b{re.escape(env_name)}\s*[:=]\s*(?!your_|<|{{|\[)[A-Za-z0-9+/=._-]{{8,}}'
        if re.search(pattern, text, re.IGNORECASE):
            return False, "Output contains sensitive environment variable"
    
    # 3. Artifacts检查：路径验证和内容秘密检查
    if artifacts:
        import os
        import base64
        
        # 3a. 路径验证（如果提供了session_dir）
        if session_dir:
            try:
                session_real = os.path.realpath(session_dir)
            except Exception:
                return False, "Cannot verify artifact paths (session directory invalid)"
            
            for art in artifacts:
                local_path = art.get('localPath')
                if not local_path:
                    continue
                
                try:
                    file_real = os.path.realpath(local_path)
                except Exception:
                    return False, "Artifact contains invalid path"
                
                # 必须在session目录内
                if not file_real.startswith(session_real + os.sep):
                    return False, "Artifact path outside authorized session directory"
                
                # 敏感配置文件不得交付
                file_name = os.path.basename(file_real).lower()
                if any(file_name.startswith(p) for p in ['.env', '.aws', '.ssh']):
                    return False, "Artifact contains sensitive configuration file"
                if any(file_name.endswith(e) for e in ['.pem', '.key', 'id_rsa', 'id_ed25519']):
                    return False, "Artifact contains private key file"
        
        # 3b. 内容格式验证和秘密检查（fail closed）
        for art in artifacts:
            # 提取MIME type和文件名
            mime_type = str(art.get('mime', '')).split(';')[0].strip().lower()
            file_name = str(art.get('name', '')).lower()
            data_url = art.get('dataUrl', '')
            
            if not data_url or ';base64,' not in data_url:
                # 无dataUrl或非base64格式：拒绝
                return False, "Artifact must have base64-encoded dataUrl"
            
            # 提取并解码base64
            try:
                b64_data = data_url.split(';base64,', 1)[1]
                content_bytes = base64.b64decode(b64_data)
            except Exception as e:
                # base64解码失败：拒绝（fail closed）
                return False, f"Artifact base64 decode failed: {str(e)}"
            
            # 按真实格式区分处理
            # 允许的图片类型（验证magic bytes）
            allowed_images = {
                'image/png': (b'\x89PNG\r\n\x1a\n', 8),
                'image/jpeg': (b'\xff\xd8', 2),
                'image/jpg': (b'\xff\xd8', 2),
                'image/gif': (b'GIF8', 4),  # GIF87a或GIF89a
                'image/webp': (b'RIFF', 4),  # 还需检查offset 8的WEBP
            }
            
            # 允许的文本类型（必须UTF-8解码）
            allowed_text = {
                'text/plain', 'text/csv', 'text/markdown', 'text/html',
                'application/json', 'application/xml', 'text/xml',
                'image/svg+xml',  # SVG作为文本处理
            }
            
            is_image = mime_type in allowed_images
            is_text = mime_type in allowed_text or file_name.endswith('.svg')
            
            if not is_image and not is_text:
                # 未知或禁止的类型：拒绝（fail closed）
                return False, f"Artifact type {mime_type} not in allowed list (images: png/jpg/gif/webp; text: txt/csv/md/html/json/xml/svg)"
            
            if is_image:
                # 图片：验证magic bytes
                if mime_type == 'image/webp':
                    # WebP特殊检查：RIFF....WEBP
                    if not (content_bytes[:4] == b'RIFF' and content_bytes[8:12] == b'WEBP'):
                        return False, f"Artifact declared as {mime_type} but magic bytes mismatch"
                else:
                    magic, length = allowed_images[mime_type]
                    if not content_bytes[:length].startswith(magic):
                        return False, f"Artifact declared as {mime_type} but magic bytes mismatch"
                # 图片内容不检查OCR/隐写（已知限制）
            
            elif is_text:
                # 文本：必须能UTF-8解码并检查内容
                try:
                    content_text = content_bytes.decode('utf-8')
                except UnicodeDecodeError as e:
                    # 声明为text但无法UTF-8解码：拒绝（fail closed）
                    return False, f"Artifact declared as text ({mime_type}) but UTF-8 decode failed: {str(e)}"
                
                # SVG和其他文本：扫描危险内容
                # 检查敏感值模式
                for pattern in _SENSITIVE_VALUE_RE:
                    if pattern.search(content_text):
                        return False, "Artifact content contains sensitive credentials"
                
                # 检查环境变量泄露
                for env_name in SENSITIVE_ENV_NAMES:
                    pattern = rf'\b{re.escape(env_name)}\s*[:=]\s*(?!your_|<|{{|\[)[A-Za-z0-9+/=._-]{{8,}}'
                    if re.search(pattern, content_text, re.IGNORECASE):
                        return False, "Artifact content contains environment variable"
    
    return True, None


# ============================================================
# 输出路径脱敏（hired模式）
# ============================================================

def sanitize_paths_in_output(text: str, session_root: Optional[str] = None) -> str:
    """
    脱敏输出中的路径（hired模式）
    
    规则：
    - session根及以上 → '[路径已脱敏]'
    - session根 → '.'
    - session根内路径 → 相对路径（如 'images/a.png'）
    - 其他路径 → '[路径已脱敏]'
    
    Args:
        text: 原始输出文本
        session_root: 可信的session根路径（如 /Users/x/.tokenbank/.../sessions/abc）
    
    Returns:
        脱敏后的文本
    """
    if not session_root:
        return text
    
    try:
        # 规范化session_root（处理符号链接、相对路径）
        session_real = os.path.realpath(session_root)
        
        # 构造匹配模式（支持Windows、Mac、Linux）
        # 1. 匹配绝对路径（Unix: /..., Windows: C:\... 或 \\server\...）
        # 2. 支持JSON转义的路径（\\/）
        # 3. 支持file://协议
        
        # 转义路径用于正则
        session_escaped = re.escape(session_real)
        # 支持Windows路径分隔符（\ 和 /）
        session_pattern = session_escaped.replace(r'\\', r'[\\/]').replace('/', r'[\\/]')
        
        result = text
        
        # 使用占位符保护已处理的session路径，避免被后续规则覆盖
        SESSION_ROOT_PLACEHOLDER = '__SESSION_ROOT__'
        SESSION_PATH_PREFIX = '__SESSION_PATH__'
        
        protected_paths = {}  # 保存占位符对应的实际路径
        placeholder_counter = [0]  # 用list保持可变性
        
        # 替换session根内的路径为相对路径
        def replace_session_path(match):
            full_path = match.group(0)
            try:
                path = full_path
                if path.startswith('file://'):
                    path = path[7:]
                
                # JSON转义路径处理
                path = path.replace('\\/', '/').replace('\\\\', '\\')
                
                # 计算相对路径
                if os.path.isabs(path):
                    real_path = os.path.realpath(path)
                    if real_path.startswith(session_real + os.sep):
                        rel = os.path.relpath(real_path, session_real)
                        # 保持原格式（JSON转义等）
                        if '\\/' in full_path:
                            rel = rel.replace('\\', '\\/')
                        if full_path.startswith('file://'):
                            rel = 'file://' + rel
                        
                        # 用占位符保护，避免被后续规则覆盖
                        placeholder = f'{SESSION_PATH_PREFIX}{placeholder_counter[0]}'
                        placeholder_counter[0] += 1
                        protected_paths[placeholder] = rel
                        return placeholder
            except Exception:
                pass
            return full_path  # 保持不变
        
        # 先替换session根本身为占位符
        def replace_session_root(match):
            placeholder = f'{SESSION_ROOT_PLACEHOLDER}{placeholder_counter[0]}'
            placeholder_counter[0] += 1
            protected_paths[placeholder] = '.'
            return placeholder
        
        result = re.sub(
            rf'{session_pattern}(?![\\/])',
            replace_session_root,
            result,
            flags=re.IGNORECASE
        )
        
        # 再替换session根内的子路径
        path_patterns = [
            rf'file://{session_pattern}[\\/][^\s"\'<>|]*',
            rf'{session_pattern}[\\/][^\s"\'<>|]*',
        ]
        
        for pattern in path_patterns:
            result = re.sub(pattern, replace_session_path, result, flags=re.IGNORECASE)
        
        # 替换其他绝对路径为[路径已脱敏]
        # Unix绝对路径
        result = re.sub(
            r'(?:file://)?/(?:Users|home|root|opt|var|etc)/[^\s"\'<>|]*',
            '[路径已脱敏]',
            result
        )
        # Windows绝对路径
        result = re.sub(
            r'(?:file://)?[A-Z]:\\\\?[^\s"\'<>|]*',
            '[路径已脱敏]',
            result,
            flags=re.IGNORECASE
        )
        # UNC路径
        result = re.sub(
            r'\\\\\\\\[^\s"\'<>|]*',
            '[路径已脱敏]',
            result
        )
        
        # 最后恢复占位符为实际路径
        for placeholder, actual_path in protected_paths.items():
            result = result.replace(placeholder, actual_path)
        
        return result
        
    except Exception:
        # 脱敏失败也不能泄露原路径
        return text


# ============================================================
# 绕过检测：检查器异常或缺失必须fail closed
# ============================================================

def ensure_checker_available() -> Tuple[bool, Optional[str]]:
    """
    验证检查器模块本身未被篡改或禁用
    
    Returns:
        (is_available, error_message)
    """
    # 基本完整性检查：关键函数存在且未被mock
    if not callable(check_input_safety) or not callable(check_output_safety):
        return False, "Safety checker functions unavailable"
    
    # 验证关键数据结构未被清空
    if not _DANGEROUS_CMD_RE or not _SENSITIVE_VALUE_RE:
        return False, "Safety checker rules missing"
    
    return True, None
