"""临时静态资源可选放到腾讯云 COS。

未设置 COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET / COS_REGION 时不启用，
调用方继续把文件写在本机 data 目录。
"""

from __future__ import annotations

import logging
import os
import threading

log = logging.getLogger("cos_media")

# 只给远程成品前缀做到期删除，不动桶里别的对象
_LIFECYCLE_RULES = (
    ("tokenbank-agent-media", "agent-media/"),
)
_lifecycle_ready = False
_lifecycle_lock = threading.Lock()


def _cfg() -> dict | None:
    sid = os.getenv("COS_SECRET_ID", "").strip()
    secret = os.getenv("COS_SECRET_KEY", "").strip()
    bucket = os.getenv("COS_BUCKET", "").strip()
    region = os.getenv("COS_REGION", "").strip()
    if not (sid and secret and bucket and region):
        return None
    return {"sid": sid, "secret": secret, "bucket": bucket, "region": region}


def enabled() -> bool:
    return _cfg() is not None


def public_base() -> str:
    """自定义域名优先，否则用存储桶默认域名。"""
    custom = os.getenv("COS_PUBLIC_BASE", "").strip().rstrip("/")
    if custom:
        return custom
    cfg = _cfg()
    if not cfg:
        return ""
    return f"https://{cfg['bucket']}.cos.{cfg['region']}.myqcloud.com"


def _ttl_sec() -> int:
    raw = os.getenv("AGENT_MEDIA_TTL_DAYS", "3").strip() or "3"
    try:
        days = float(raw)
    except ValueError:
        days = 3
    if days <= 0:
        days = 3
    # 预签名最长按 7 天签，和成品保留期对齐
    return int(min(days, 7) * 86400)


def _client():
    from qcloud_cos import CosConfig, CosS3Client

    cfg = _cfg()
    if not cfg:
        return None, None
    config = CosConfig(
        Region=cfg["region"],
        SecretId=cfg["sid"],
        SecretKey=cfg["secret"],
        Scheme="https",
    )
    return CosS3Client(config), cfg


def _acl_rejected(err: Exception) -> bool:
    text = str(err).lower()
    return "acl" in text or "accesscontrollist" in text or "public-read" in text


def _ensure_lifecycle(client, bucket: str) -> None:
    """给临时前缀补上到期删除。已有同名规则或没有权限时不动桶里其他规则。"""
    global _lifecycle_ready
    if _lifecycle_ready:
        return
    with _lifecycle_lock:
        if _lifecycle_ready:
            return
        days = max(1, _ttl_sec() // 86400)
        wanted = {
            rule_id: {
                "ID": rule_id,
                "Filter": {"Prefix": prefix},
                "Status": "Enabled",
                "Expiration": {"Days": days},
            }
            for rule_id, prefix in _LIFECYCLE_RULES
        }
        existing: list = []
        try:
            resp = client.get_bucket_lifecycle(Bucket=bucket) or {}
            rules = resp.get("Rule") or []
            if isinstance(rules, dict):
                rules = [rules]
            existing = [r for r in rules if isinstance(r, dict)]
        except Exception as err:
            # 还没配过生命周期时，接口会报不存在，下面直接写入我们的规则
            if "nosuchlifecycle" not in str(err).lower():
                log.warning("read COS lifecycle skipped: %s", err)
                _lifecycle_ready = True
                return
        by_id = {str(r.get("ID") or ""): r for r in existing}
        if all(rule_id in by_id for rule_id, _prefix in _LIFECYCLE_RULES):
            _lifecycle_ready = True
            return
        merged = [r for r in existing if str(r.get("ID") or "") not in wanted]
        merged.extend(wanted.values())
        try:
            client.put_bucket_lifecycle(
                Bucket=bucket,
                LifecycleConfiguration={"Rule": merged},
            )
        except Exception as err:
            log.warning("set COS lifecycle skipped: %s", err)
        _lifecycle_ready = True


def put_bytes(key: str, body: bytes, content_type: str) -> str | None:
    """上传一份临时对象，返回浏览器能打开的地址。失败返回 None。"""
    client, cfg = _client()
    if client is None or cfg is None:
        return None
    mime = content_type or "application/octet-stream"
    try:
        client.put_object(
            Bucket=cfg["bucket"],
            Body=body,
            Key=key,
            ContentType=mime,
            ACL="public-read",
            CacheControl="public, max-age=86400",
        )
        _ensure_lifecycle(client, cfg["bucket"])
        return f"{public_base()}/{key}"
    except Exception as err:
        if not _acl_rejected(err):
            log.warning("COS upload failed: %s", err)
            return None
    # 桶不允许公开读时，对象保持私有，发一个和保留期一样长的下载地址
    try:
        client.put_object(
            Bucket=cfg["bucket"],
            Body=body,
            Key=key,
            ContentType=mime,
            CacheControl="public, max-age=86400",
        )
        _ensure_lifecycle(client, cfg["bucket"])
        return client.get_presigned_url(
            Bucket=cfg["bucket"],
            Key=key,
            Method="GET",
            Expired=_ttl_sec(),
        )
    except Exception as err:
        log.warning("COS private upload failed: %s", err)
        return None
