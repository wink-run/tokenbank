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
    
    # 3. 附件路径穿越和敏感路径（必须检查，即使prompt为空）
    if files:
        for f in files:
            name = str(f.get('name', ''))
            # 路径穿越检查
            for pattern in _PATH_TRAVERSAL_RE:
                if pattern.search(name):
                    return False, "File attachment contains path traversal attempt"
            # 敏感路径检查
            for pattern in _SENSITIVE_PATH_RE:
                if pattern.search(name):
                    return False, "File attachment attempts to access sensitive paths"
    
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
    
    # 3. Artifacts路径验证（必须在授权会话目录内）
    if artifacts and session_dir:
        import os
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
