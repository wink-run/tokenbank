"""网页雇佣的边界：统一标记、拦住明显危险输入、抹掉返回里的密钥和本机路径。

不改出租方的登录环境，也不换现有的任务派发。
"""

from __future__ import annotations

import re

from agent_artifacts import redact_remaining_local_paths

# 只拦会直接碰系统或密钥目录的写法。工作目录里的普通删改交给沙箱，不在这里拦。
_INPUT_RULES = (
    re.compile(r"\brm\s+-[a-zA-Z]*r[a-zA-Z]*f\s+(?:/|~|\.|\$HOME)", re.I),
    re.compile(r"\bsudo\s+\S", re.I),
    re.compile(r"/etc/(?:passwd|shadow)\b"),
    re.compile(r"(?:~/|/Users/[^/\s]+/|/home/[^/\s]+/)\.(?:ssh|aws|gnupg)/"),
)
_SECRET_RE = re.compile(
    r"(?:"
    r"sk-[A-Za-z0-9]{20,}"
    r"|AIza[0-9A-Za-z\-_]{20,}"
    r"|AKIA[0-9A-Z]{16}"
    r"|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----"
    r"|(?:AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN|ANTHROPIC_API_KEY)\s*=\s*\S+"
    r")"
)
REJECT_MESSAGE = "请求被拒绝：包含不允许的命令或路径"


def resolve_call_context(consumer_user_id, owner_user_id) -> str:
    """执行人就是调用人时，这是自己的智能体；否则是雇佣。访客一律算雇佣。"""
    try:
        if consumer_user_id is not None and owner_user_id is not None and int(consumer_user_id) == int(owner_user_id):
            return "owner"
    except (TypeError, ValueError):
        pass
    return "hired"


def reject_hired_input(prompt: str, names=None) -> str:
    """不安全就返回给调用方的说明，安全返回空字符串。"""
    text = str(prompt or "")
    for rule in _INPUT_RULES:
        if rule.search(text):
            return REJECT_MESSAGE
    for name in names or []:
        base = str(name or "").replace("\\", "/").strip()
        if not base:
            continue
        if base.startswith("/") or base.startswith("~") or ".." in base.split("/"):
            return REJECT_MESSAGE
    return ""


def redact_hired_text(text: str) -> str:
    """中转地址保留。剩下的绝对路径只留文件名，密钥换成占位。"""
    cleaned = redact_remaining_local_paths(str(text or ""))
    return _SECRET_RE.sub("[redacted]", cleaned)
