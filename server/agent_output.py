"""产出确认：清单和字节到齐才算完成。旧客户端没有清单时仍交卷，并标明没走确认。"""

from __future__ import annotations


def should_charge(call_context: str, guest: bool) -> bool:
    """本人和访客不扣分。雇佣才扣。"""
    return call_context == "hired" and not guest


def should_award_contributor(call_context: str, success: bool) -> bool:
    """本人调用自己的智能体不加贡献分。雇佣和访客试用成功才记。"""
    return bool(success) and call_context != "owner"


def settle_output(result: dict, manifest, artifacts, *, confirmed: bool) -> dict:
    """收成调用方能看到的终态。

    confirmed 为假时是旧的「正文先到、文件后补」。超时就放行，并标 output_confirmed=false。
    清单里声明缺失的文件是缺文件。哈希还没到齐是待补传，不当作完成。
    """
    out = dict(result or {})
    out.pop("artifacts_follow", None)
    out.pop("output_commit", None)
    if artifacts is not None:
        out["artifacts"] = artifacts
    status = str(out.get("status") or "completed")
    # 执行失败、超时不改写成缺文件。确认只发生在这一轮本身跑完的时候
    if status not in ("completed", ""):
        out["output_confirmed"] = False
        return out
    if not confirmed:
        out["output_confirmed"] = False
        return out

    missing = []
    files = []
    if isinstance(manifest, dict):
        for name in manifest.get("missing") or []:
            text = str(name or "").strip()
            if text:
                missing.append(text)
        files = [item for item in (manifest.get("files") or []) if isinstance(item, dict)]
    if missing:
        out["status"] = "output_missing"
        out["error"] = "output_missing"
        out["output_confirmed"] = False
        return out

    wanted = [str(item.get("sha256") or "") for item in files]
    wanted = [item for item in wanted if item]
    got = set()
    for item in artifacts or []:
        if isinstance(item, dict) and item.get("sha256"):
            got.add(str(item["sha256"]))
    if wanted and any(item not in got for item in wanted):
        out["status"] = "output_pending"
        out["error"] = "output_pending"
        out["output_confirmed"] = False
        return out

    out["output_confirmed"] = True
    if not out.get("status"):
        out["status"] = "completed"
    return out
