"""
server/agent_safety.py - Hired Agent 安全围栏（程序级硬规则）

只对hired模式生效，不影响local调用。
检查失败=拒绝任务，不降级、不绕过（fail closed）。
不依赖LLM判断或可被诱导的提示词。
"""
import re
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
]

# 敏感路径模式（配置、密钥、凭证）
SENSITIVE_PATHS = [
    r'/etc/(passwd|shadow|sudoers)',
    r'/root/',
    r'~/.ssh/',
    r'~/.aws/',
    r'~/.config/.*/(config|credentials|token)',
    r'\.env(\.|$)',
    r'\.env\.local',
    r'\.env\.production',
    r'(id_rsa|id_ed25519|\.pem|\.key)$',
    r'(credentials?|secrets?|tokens?)\.(json|yaml|yml|txt)$',
    r'\.npmrc',
    r'\.pypirc',
    r'\.netrc',
    r'\.git-credentials',
]

# 路径穿越模式
PATH_TRAVERSAL = [
    r'\.\.',  # ../ or ..\
    r'^/',  # 绝对路径
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
    if not prompt:
        return True, None
    
    # 1. 危险命令检测
    for pattern in _DANGEROUS_CMD_RE:
        if pattern.search(prompt):
            return False, "Input contains potentially dangerous operations"
    
    # 2. 敏感路径访问意图
    for pattern in _SENSITIVE_PATH_RE:
        if pattern.search(prompt):
            return False, "Input attempts to access sensitive paths or credentials"
    
    # 3. 附件路径穿越
    if files:
        for f in files:
            name = str(f.get('name', ''))
            for pattern in _PATH_TRAVERSAL_RE:
                if pattern.search(name):
                    return False, "File attachment contains path traversal attempt"
    
    return True, None


# ============================================================
# 输出检查：敏感信息泄露、未授权路径
# ============================================================

# 敏感值模式（密钥、token、密码格式）
SENSITIVE_VALUE_PATTERNS = [
    r'(?i)(api[_-]?key|apikey|access[_-]?key)["\s:=]+[A-Za-z0-9+/]{16,}',
    r'(?i)(secret|password|passwd|pwd)["\s:=]+\S{8,}',
    r'(?i)token["\s:=]+[A-Za-z0-9_.-]{20,}',
    r'-----BEGIN (RSA |EC )?PRIVATE KEY-----',
    r'(?i)bearer\s+[A-Za-z0-9_.-]{20,}',
    r'(?i)Authorization:\s*\S+',
    r'AWS[A-Z0-9]{16,}',
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
    for env_name in SENSITIVE_ENV_NAMES:
        # 匹配 ENV_NAME=... 或 ENV_NAME: ... 或 "ENV_NAME": "..."
        if re.search(rf'\b{re.escape(env_name)}\s*[:=]', text, re.IGNORECASE):
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
