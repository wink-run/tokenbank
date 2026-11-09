import asyncio
import hashlib
import json
import logging
import os
import random
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional, TYPE_CHECKING
if TYPE_CHECKING:
    from virtual_worker import VirtualWorkerConnection

logger = logging.getLogger("server")

# 分享者化名句柄：对 user_id 带盐哈希 → s_<8hex>。不暴露用户名/真 user_id，跨重连恒定，
# 服务端可对候选逐个算 hash 反查匹配（无需存反查表）。SALT 从环境注入（真盐不进代码库）。
_SHARER_SALT = os.getenv("TB_SHARER_SALT", "tokenbank-sharer-v1")


def sharer_handle(user_id) -> Optional[str]:
    if user_id is None:
        return None
    h = hashlib.sha1(f"{_SHARER_SALT}:{user_id}".encode()).hexdigest()[:8]
    return f"s_{h}"


def worker_owner_id(w):
    """统一取分享者身份：虚拟源用 owner_user_id，真实节点用 user_id。"""
    oid = getattr(w, "owner_user_id", None)
    return oid if oid is not None else getattr(w, "user_id", None)


def worker_sharer(w) -> Optional[str]:
    return sharer_handle(worker_owner_id(w))


def _same_user_terminal(old, new) -> bool:
    """同一账号、同一台设备才算重连。另一台电脑的连接不能被挤掉。"""
    old_uid = getattr(old, "user_id", None)
    new_uid = getattr(new, "user_id", None)
    if old_uid is None or new_uid is None or old_uid != new_uid:
        return False
    old_dev = str(getattr(old, "device_id", None) or "").strip()
    new_dev = str(getattr(new, "device_id", None) or "").strip()
    if old_dev and new_dev:
        return old_dev == new_dev
    # 旧客户端没带设备 id：用注册名（电脑名）区分，同名才替换
    old_name = str(getattr(old, "name", None) or "").strip()
    new_name = str(getattr(new, "name", None) or "").strip()
    if not old_name or not new_name:
        return False
    if old_name.startswith("worker-") or new_name.startswith("worker-"):
        return False
    return old_name.casefold() == new_name.casefold()


def _terminal_key(worker) -> Optional[str]:
    """同一账号、同一台设备的暂存键。没有设备号时用注册名。"""
    uid = getattr(worker, "user_id", None)
    if uid is None:
        return None
    dev = str(getattr(worker, "device_id", None) or "").strip()
    if dev:
        return f"{uid}\0{dev}"
    name = str(getattr(worker, "name", None) or "").strip()
    if not name or name.startswith("worker-"):
        return None
    return f"{uid}\0n:{name.casefold()}"


# 出租方重启 Token Bank 的等待窗口。这段时间内上架名单和未完成任务都留着
AGENT_RECONNECT_GRACE_SEC = 90
# 已经开跑的任务重连后不再把原提示重发一遍，只让 CLI 从会话里接着做
AGENT_RESUME_PROMPT = "上一次执行被中断了。请从中断处继续完成，不要重头再做。"


def agent_resume_message(task_id: str, entry: dict) -> dict:
    """重连后下发的续跑帧。已经产出过内容或有会话号时，用 --resume 接着做。"""
    sid = str((entry or {}).get("cli_session_id") or "").strip()
    partial = str((entry or {}).get("partial_output") or "").strip()
    started = bool(sid or partial)
    prompt = AGENT_RESUME_PROMPT if started else str((entry or {}).get("prompt") or "")
    body = {
        "type": "agent_task",
        "task_id": task_id,
        "assistant_id": (entry or {}).get("assistant_id"),
        "prompt": prompt[:50_000],
        "timeout_ms": int((entry or {}).get("timeout_ms") or 600_000),
        "consumer_key": (entry or {}).get("consumer_key"),
        "consumer_user_id": (entry or {}).get("consumer_user_id"),
        "continue_session": True if started else ((entry or {}).get("continue_session") or None),
        "cli_session_id": sid or None,
        # 重连必须回到原来的会话目录，不能因为没带 share/session 而新开一层
        "share_id": (entry or {}).get("share_id") or None,
        "session_key": (entry or {}).get("session_key") or None,
    }
    if (entry or {}).get("call_context"):
        body["call_context"] = entry["call_context"]
    if not started:
        if (entry or {}).get("images"):
            body["images"] = entry["images"]
        if (entry or {}).get("files"):
            body["files"] = entry["files"]
    return body


@dataclass
class WorkerConnection:
    ws: object
    models: list
    worker_id: str
    name: str
    model_types: dict = field(default_factory=dict)
    user_id: Optional[int] = None
    circle_id: Optional[int] = None          # 兼容旧逻辑（单圈子）
    circle_ids: list = field(default_factory=list)  # 多圈子共享
    # 贡献智能体名片（无正文）；visibility=public|circle
    agents: list = field(default_factory=list)
    # 出租人昵称：用于共享智能体展示名「{nickname}的{原名}」
    owner_nickname: str = ""
    # 客户端设备 id。同一账号的两台电脑靠它分开，重连只替换自己
    device_id: str = ""
    caps: list = field(default_factory=list)
    client_ip: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    country_code: str = ""
    city: str = ""
    connected_at: datetime = field(default_factory=datetime.now)
    active_requests: int = 0
    # req_id -> {queue, model, dispatch_time}
    pending: dict = field(default_factory=dict)
    # task_id -> {queue, assistant_id, dispatch_time, consumer_user_id}
    pending_agents: dict = field(default_factory=dict)
    _send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    # 5 分钟周期统计
    period_start: float = field(default_factory=time.time)
    # {model: {output_tokens, requests, success, ttft_sum, ttft_count}}
    period_stats: dict = field(default_factory=dict)

    async def send(self, data: dict) -> None:
        async with self._send_lock:
            await self.ws.send_text(json.dumps(data))

    def record_complete(self, model: str, output_tokens: int, success: bool, ttft_ms: float | None) -> None:
        """success 且 ttft_ms 有效时累加首 Token 延迟（用于周期内平均 TTFT）。"""
        s = self.period_stats.setdefault(
            model,
            {"output_tokens": 0, "requests": 0, "success": 0, "ttft_sum": 0.0, "ttft_count": 0},
        )
        s["output_tokens"] += output_tokens
        s["requests"] += 1
        if success:
            s["success"] += 1
        if success and ttft_ms is not None and ttft_ms >= 0:
            s["ttft_sum"] += ttft_ms
            s["ttft_count"] += 1
            s["last_ttft_ms"] = round(ttft_ms)

    def record_image_complete(self, model: str, image_count: int) -> None:
        """Record completed image generation for settler contribution tracking."""
        s = self.period_stats.setdefault(
            model,
            {"output_tokens": 0, "requests": 0, "success": 0,
             "ttft_sum": 0.0, "ttft_count": 0, "image_count": 0},
        )
        s["requests"] += 1
        s["success"] += 1
        s["image_count"] = s.get("image_count", 0) + image_count

    def record_agent_complete(self, assistant_id: str, success: bool, duration_ms: float | None = None) -> None:
        """武将接单完成占位统计（结息可按 agent_count 扩展；一期也可即时 award）。"""
        key = f"__agent__:{assistant_id}" if assistant_id else "__agent__"
        s = self.period_stats.setdefault(
            key,
            {"output_tokens": 0, "requests": 0, "success": 0,
             "ttft_sum": 0.0, "ttft_count": 0, "agent_count": 0},
        )
        s["requests"] += 1
        if success:
            s["success"] += 1
            s["agent_count"] = s.get("agent_count", 0) + 1
        if success and duration_ms is not None and duration_ms >= 0:
            s["ttft_sum"] += duration_ms
            s["ttft_count"] += 1
            s["last_ttft_ms"] = round(duration_ms)

    def take_period(self) -> dict:
        """取走当前周期数据并重置，返回快照"""
        snapshot = dict(self.period_stats)
        self.period_stats = {}
        self.period_start = time.time()
        return snapshot

    def period_online_mins(self) -> float:
        return (time.time() - self.period_start) / 60

    def reward_multiplier(self) -> float:
        """贡献/质量综合系数 0.5–1.5（在线时长 0.4 + 延迟 0.4 + 稳定性 0.2）。
        与 server._worker_row 展示的 star 同源——auto 策略按此降序选优。"""
        return compute_reward_multiplier(self)

    def to_dict(self) -> dict:
        return {
            "worker_id": self.worker_id,
            "name": self.name,
            "models": self.models,
            "model_types": self.model_types,
            "agents": self.agents,
            "caps": self.caps,
            "connected_at": self.connected_at.isoformat(),
            "active_requests": self.active_requests,
            "user_id": self.user_id,
        }

    def offline_model(self, model: str) -> bool:
        """从该贡献节点在线列表移除模型（服务不可用时自动下线）。"""
        if model not in worker_model_names(self):
            return False
        kept = []
        for m in self.models:
            name = m if isinstance(m, str) else (m.get("name") if isinstance(m, dict) else str(m))
            if name != model:
                kept.append(m)
        self.models = kept
        self.model_types.pop(model, None)
        self.period_stats.pop(model, None)
        return True


def worker_model_names(worker) -> set[str]:
    """Worker 声明的模型名集合（兼容 str / {name} 混用）。"""
    out: set[str] = set()
    for m in getattr(worker, "models", None) or []:
        if isinstance(m, str):
            name = m.strip()
        elif isinstance(m, dict):
            name = (m.get("name") or "").strip()
        else:
            name = str(m).strip()
        if name:
            out.add(name)
    return out


def effective_model_type(worker, model: str) -> str:
    """工人声明类型 + 名称启发式 → chat|vision|image|embedding。"""
    declared = (getattr(worker, "model_types", None) or {}).get(model, "chat")
    try:
        from web_public import infer_model_type
        return infer_model_type(model, {model: declared})
    except Exception:
        from web_public import normalize_model_type
        return normalize_model_type(declared)


def prefer_model_type(existing: Optional[str], new: str) -> str:
    """多节点同模型时保留更高模态：生图/嵌入 > 图文 > 文本。"""
    rank = {"image": 3, "embedding": 3, "vision": 2, "chat": 1}
    e = (existing or "chat").strip() or "chat"
    n = (new or "chat").strip() or "chat"
    if rank.get(n, 0) >= rank.get(e, 0):
        return n
    return e


def model_type_matches(effective: str, wanted: Optional[str]) -> bool:
    """派发类型匹配：chat 请求可命中 chat/vision；其余精确匹配。"""
    if wanted is None:
        return True
    try:
        from web_public import is_chat_capable, normalize_model_type
        w = normalize_model_type(wanted)
        e = normalize_model_type(effective)
        if w == "chat":
            return is_chat_capable(e)
        return e == w
    except Exception:
        return effective == wanted


def worker_has_model(worker, model: str) -> bool:
    return model in worker_model_names(worker)


def default_ttft_ms(worker_id: str, model: str) -> int:
    """无真实请求时：按 worker+model 稳定伪随机 1000–2000ms（公开展示用）。"""
    seed = f"{worker_id}\0{model}"
    h = 0
    for ch in seed:
        h = ((h << 5) - h + ord(ch)) & 0xFFFFFFFF
    if h >= 2**31:
        h -= 2**32
    return 1000 + (abs(h) % 1001)


def compute_reward_multiplier(worker) -> float:
    """贡献/质量综合系数 0.5–1.5；WorkerConnection 与 VirtualWorkerConnection 共用。"""
    stats = getattr(worker, "period_stats", None) or {}
    total_req = sum(s.get("requests", 0) for s in stats.values())
    if total_req <= 0:
        return 1.0
    total_success = sum(s.get("success", 0) for s in stats.values())
    total_ttft = sum(s.get("ttft_sum", 0) for s in stats.values())
    total_ttft_count = sum(s.get("ttft_count", 0) for s in stats.values())
    success_rate = total_success / total_req
    online_mins = worker.period_online_mins()
    if total_ttft_count > 0:
        avg_ttft_ms = total_ttft / total_ttft_count
    else:
        lat = []
        for m in worker_model_names(worker):
            s = stats.get(m, {})
            lat.append(int(s["last_ttft_ms"]) if s.get("last_ttft_ms") is not None
                       else default_ttft_ms(worker.worker_id, m))
        avg_ttft_ms = sum(lat) / len(lat) if lat else 0
    online_f = min(0.5 + 0.8 * min(online_mins / 5, 1.0), 1.3)
    latency_f = max(0.6, min(1.5, 500 / avg_ttft_ms)) if avg_ttft_ms > 0 else 1.0
    stability_f = 0.5 + 0.7 * success_rate
    return round(max(0.5, min(1.5, 0.4 * online_f + 0.4 * latency_f + 0.2 * stability_f)), 3)


async def offline_contributor_model(worker, model: str, reason: str) -> bool:
    """贡献节点模型服务失败：从调度池下线并通知 Agent 同步本地配置。"""
    wid = str(getattr(worker, "worker_id", "") or "")
    if wid.startswith("vw-"):
        return False
    if not worker.offline_model(model):
        return False
    logger.warning(
        "[p2p] contributor model offline worker=%s model=%s reason=%s remaining=%s",
        wid,
        model,
        str(reason or "")[:240],
        sorted(worker_model_names(worker)),
    )
    try:
        await worker.send({
            "type": "offline_models",
            "models": [model],
            "reason": str(reason or "")[:500],
        })
    except Exception as e:
        logger.warning("[p2p] offline_models notify failed worker=%s: %s", wid, e)
    return True


class WorkerPool:
    _STICKY_TTL = 3600   # 粘性会话有效期（秒）
    # 节点冷却（与客户端 gateway-cooldown 对齐的简化档）：限流/瞬时 45s，配额 10min，鉴权/欠费 30min
    _COOL_TRANSIENT_S = 45
    _COOL_QUOTA_S = 10 * 60
    _COOL_AUTH_S = 30 * 60

    def __init__(self):
        self._workers: list[WorkerConnection] = []
        self._virtual: list = []   # list[VirtualWorkerConnection]
        # 粘性会话：session_key -> (worker_id, expires_at)
        self._sticky: dict[str, tuple[str, float]] = {}
        # 智能体被雇佣次数（进程内；重启清零）
        self._agent_hire_counts: dict[str, int] = {}
        # 节点×模型冷却：key=worker_id::model → until epoch 秒（失败下沉，成功清除）
        self._cooldowns: dict[str, float] = {}
        # 同一台设备上次成功上报的上架名单。重启后先用这份，探测完成再覆盖
        self._agent_cards: dict[str, list] = {}
        # 断线后暂存的武将任务，同一台设备重连后接着跑
        self._agent_resume: dict[str, dict] = {}
        self._agent_resume_token: dict[str, int] = {}

    @staticmethod
    def _cool_key(worker_id: str, model: str) -> str:
        return f"{worker_id}::{model}"

    def is_cooling(self, worker_id: str, model: str, now: float | None = None) -> bool:
        """节点对该模型是否仍在冷却期内。"""
        key = self._cool_key(worker_id, model)
        until = self._cooldowns.get(key)
        if until is None:
            return False
        t = time.time() if now is None else now
        if until <= t:
            self._cooldowns.pop(key, None)
            return False
        return True

    def clear_cooldown(self, worker_id: str, model: str) -> None:
        """成功服务后清除该节点×模型冷却。"""
        self._cooldowns.pop(self._cool_key(worker_id, model), None)

    def note_cooldown(self, worker_id: str, model: str, err: str = "",
                      now: float | None = None) -> float | None:
        """按错误类型给节点×模型记冷却；返回 until（epoch 秒），无需冷却则 None。"""
        t = time.time() if now is None else now
        low = str(err or "").lower()
        # 鉴权 / 欠费：长冷却
        if "http_401" in low or "http 401" in low or "unauthorized" in low or "invalid api key" in low:
            secs = self._COOL_AUTH_S
        elif "http_403" in low or "http 403" in low or "forbidden" in low:
            secs = self._COOL_AUTH_S
        elif "http_402" in low or "http 402" in low or "insufficient credits" in low:
            secs = self._COOL_AUTH_S
        # 配额耗尽：中等冷却；纯限流 / 超时 / 连不上：短冷却
        elif "quota" in low or "billing" in low:
            secs = self._COOL_QUOTA_S
        elif "http_429" in low or "http 429" in low or "rate" in low:
            secs = self._COOL_TRANSIENT_S if "quota" not in low else self._COOL_QUOTA_S
        elif "timeout" in low or "failed to reach" in low or "http_5" in low or "http 5" in low:
            secs = self._COOL_TRANSIENT_S
        else:
            # 其它上游错误也短冷，避免连续打同一坏节点
            secs = self._COOL_TRANSIENT_S
        until = t + secs
        key = self._cool_key(worker_id, model)
        prev = self._cooldowns.get(key, 0)
        if until > prev:
            self._cooldowns[key] = until
        logger.info(
            "[p2p] worker cooldown key=%s until=+%.0fs reason=%s",
            key, max(0, self._cooldowns[key] - t), str(err or "")[:160],
        )
        return self._cooldowns[key]

    def _sink_cooled(self, ordered: list, model: str) -> list:
        """冷却中的节点下沉到末尾（fresh 先试，仍保留兜底）。"""
        if len(ordered) < 2:
            return list(ordered)
        fresh, cooled = [], []
        for w in ordered:
            (cooled if self.is_cooling(getattr(w, "worker_id", ""), model) else fresh).append(w)
        return fresh + cooled if cooled else fresh

    def add(self, worker: WorkerConnection) -> None:
        """接入真实节点。同一台设备重连只替换自己，同一账号的其他设备继续留在线上。"""
        uid = getattr(worker, "user_id", None)
        stale = [
            w for w in self._workers
            if _same_user_terminal(w, worker)
        ] if uid is not None else []
        if stale:
            for w in stale:
                # 先把进行中的任务挪走，旧连接的收尾才不会把它们判失败
                self.remember_agent_cards(w)
                self.park_agent_tasks(w)
                try:
                    self._workers.remove(w)
                except ValueError:
                    pass
                # 尽力关掉旧 ws，促使对端收尾
                try:
                    old_ws = getattr(w, "ws", None)
                    if old_ws is not None:
                        loop = asyncio.get_event_loop()
                        if loop.is_running():
                            loop.create_task(old_ws.close(code=4000, reason="replaced by newer connection"))
                except Exception:
                    pass
                logger.info(
                    "[worker_pool] evicted stale worker_id=%s user_id=%s device_id=%s (same terminal reconnect)",
                    getattr(w, "worker_id", "?"),
                    uid,
                    getattr(w, "device_id", "") or getattr(w, "name", ""),
                )
        self._workers.append(worker)

    def remove(self, worker: WorkerConnection) -> None:
        try:
            self._workers.remove(worker)
        except ValueError:
            pass

    def remember_agent_cards(self, worker: WorkerConnection) -> None:
        """记下这一端当前上架的名片。空名单不覆盖，避免重启瞬间把上次的上架清掉。"""
        key = _terminal_key(worker)
        cards = [
            dict(c) for c in (getattr(worker, "agents", None) or [])
            if isinstance(c, dict) and str(c.get("id") or "").strip()
        ]
        if key and cards:
            self._agent_cards[key] = cards

    def restore_agent_cards(self, worker: WorkerConnection) -> bool:
        """注册时还没探测完，先挂回这一端上次的上架名单。"""
        if getattr(worker, "agents", None):
            self.remember_agent_cards(worker)
            return False
        key = _terminal_key(worker)
        saved = self._agent_cards.get(key) if key else None
        if not saved:
            return False
        worker.agents = [dict(c) for c in saved]
        return True

    def forget_agent_cards(self, worker: WorkerConnection) -> None:
        """这一端明确下架光了，重连不要再把旧名单挂回去。"""
        key = _terminal_key(worker)
        if key:
            self._agent_cards.pop(key, None)

    def park_agent_tasks(self, worker: WorkerConnection) -> Optional[dict]:
        """断线时先留住进行中的武将任务。同一台设备在宽限内重连就接着跑。"""
        if getattr(worker, "_agent_tasks_handed_off", False):
            return None
        entries = dict(getattr(worker, "pending_agents", None) or {})
        worker.pending_agents.clear()
        worker._agent_tasks_handed_off = True
        self.remember_agent_cards(worker)
        if not entries:
            return None
        # 等待重连的这段时间不计入任务超时
        for entry in entries.values():
            clock = entry.get("clock") if isinstance(entry, dict) else None
            if isinstance(clock, dict) and clock.get("deadline_at"):
                clock["deadline_at"] = float(clock["deadline_at"]) + AGENT_RECONNECT_GRACE_SEC
        key = _terminal_key(worker)
        if not key:
            return {"orphan": entries}
        token = int(self._agent_resume_token.get(key, 0)) + 1
        self._agent_resume_token[key] = token
        self._agent_resume[key] = {"entries": entries, "token": token}
        self._arm_agent_resume_expiry(key, token)
        return {"key": key, "token": token}

    def adopt_parked_agent_tasks(self, worker: WorkerConnection) -> list:
        """重连后把暂存任务交回这台设备。返回 [(task_id, entry), ...]。"""
        key = _terminal_key(worker)
        if not key:
            return []
        parked = self._agent_resume.get(key)
        if not parked or parked.get("token") != self._agent_resume_token.get(key):
            return []
        self._agent_resume.pop(key, None)
        adopted = []
        for tid, entry in list((parked.get("entries") or {}).items()):
            if not isinstance(entry, dict) or entry.get("cancel_settled"):
                continue
            box = entry.get("worker_box")
            if isinstance(box, dict):
                box["worker"] = worker
            worker.pending_agents[tid] = entry
            worker.active_requests = int(getattr(worker, "active_requests", 0) or 0) + 1
            adopted.append((tid, entry))
        return adopted

    def expire_parked_agent_tasks(self, key: str, token: int) -> dict:
        """宽限过了还没连回来，把这些任务交回去判失败。"""
        parked = self._agent_resume.get(key)
        if not parked or parked.get("token") != token:
            return {}
        self._agent_resume.pop(key, None)
        return dict(parked.get("entries") or {})

    def find_parked_agent(self, task_id: str):
        for parked in self._agent_resume.values():
            entry = (parked.get("entries") or {}).get(task_id)
            if entry:
                return entry
        return None

    def pop_parked_agent(self, task_id: str):
        for key, parked in list(self._agent_resume.items()):
            entries = parked.get("entries") or {}
            if task_id not in entries:
                continue
            entry = entries.pop(task_id)
            if not entries:
                self._agent_resume.pop(key, None)
            return entry
        return None

    def _arm_agent_resume_expiry(self, key: str, token: int) -> None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        loop.create_task(self._expire_agent_resume(key, token))

    async def _expire_agent_resume(self, key: str, token: int) -> None:
        await asyncio.sleep(AGENT_RECONNECT_GRACE_SEC)
        entries = self.expire_parked_agent_tasks(key, token)
        for tid, entry in entries.items():
            if not isinstance(entry, dict) or entry.get("cancel_settled"):
                continue
            q = entry.get("queue")
            if q is None:
                continue
            try:
                await q.put({
                    "type": "agent_task_result",
                    "task_id": tid,
                    "status": "failed",
                    "error": "worker disconnected",
                    "output": str(entry.get("partial_output") or ""),
                })
            except Exception:
                logger.exception("[worker_pool] expire parked agent failed task_id=%s", tid)

    def sync_virtual(self, agents: list[dict]) -> None:
        """从数据库 agent 列表重建虚拟 Worker 列表，立即生效。"""
        from virtual_worker import VirtualWorkerConnection
        from geo_ip import virtual_worker_geo
        from web_public import infer_model_type
        self._virtual = []
        for a in agents:
            if not a.get("enabled"):
                continue
            names, model_types = [], {}
            for m in a.get("models", []):
                if isinstance(m, str):
                    names.append(m)
                    model_types[m] = infer_model_type(m, {m: "chat"})
                else:
                    n = m.get("name", "")
                    if n:
                        names.append(n)
                        model_types[n] = infer_model_type(n, {n: m.get("type", "chat")})
            worker_id = f"vw-{a['id']}"
            geo = virtual_worker_geo(worker_id)
            self._virtual.append(VirtualWorkerConnection(
                base_url=a["base_url"],
                api_key=a["api_key"],
                api_style=a["api_style"],
                models=names,
                model_types=model_types,
                worker_id=worker_id,
                name=a["name"],
                user_id=a.get("user_id"),
                credentials=a.get("credentials") or {},
                agent_id=a.get("id"),
                owner_user_id=a.get("owner_user_id"),
                circle_id=a.get("circle_id"),
                latitude=geo["lat"],
                longitude=geo["lng"],
                country_code=geo["country_code"],
                city=geo["city"],
            ))

    def pick(self, model: str, model_type: Optional[str] = None) -> Optional[WorkerConnection]:
        """Real workers first; fall back to virtual.
        If model_type is given, only workers whose declared type matches are considered.
        If None (default), any worker carrying the model is eligible."""
        def _matches(w) -> bool:
            return worker_has_model(w, model) and (
                model_type is None or model_type_matches(effective_model_type(w, model), model_type)
            )
        real = [w for w in self._workers if _matches(w)]
        if real:
            return random.choice(real)
        virtual = [v for v in self._virtual if _matches(v)]
        return random.choice(virtual) if virtual else None

    def _sticky_lookup(self, session_key: str) -> Optional[str]:
        """返回粘性会话绑定且未过期的 worker_id，否则 None。"""
        item = self._sticky.get(session_key)
        if not item:
            return None
        worker_id, expires_at = item
        if time.time() > expires_at:
            self._sticky.pop(session_key, None)
            return None
        return worker_id

    def bind_sticky(self, session_key: str, worker_id: str) -> None:
        """把会话绑定到某账号，后续同会话优先打到它（续期 TTL）。"""
        if session_key:
            self._sticky[session_key] = (worker_id, time.time() + self._STICKY_TTL)

    def candidates(self, model: str, model_type: Optional[str] = None,
                   session_key: Optional[str] = None,
                   owner_user_id: Optional[int] = None,
                   user_circle_ids: Optional[set] = None,
                   sharer: Optional[str] = None,
                   strategy: Optional[str] = None) -> list:
        """返回可服务该模型的 worker 有序列表。

        可见性：
          真实 worker：circle_id is None → 公开；否则仅圈内用户可见。
          虚拟 worker：owner == uid → 私有（本人可见）；owner is None & circle is None → 全局公开；
                       owner is None & circle_id in user_circle_ids → 圈内可见。
        排序：本人私有源 → 公共/圈子真实 worker + 圈子虚拟 worker → 全局公开虚拟源。
        圈子 worker 与公共 P2P 等权竞争（不做额外排序分层）。

        分层路由（详见 routing-codec-design）：
          sharer 非空 → 只保留该化名句柄对应分享者的 worker（钉分享者，跨重连持久）。
          strategy=='auto' → 共享候选按 reward_multiplier（star）降序；否则维持负载感知默认序。
        """
        circles = user_circle_ids or set()

        def _matches(w) -> bool:
            return worker_has_model(w, model) and (
                model_type is None or model_type_matches(effective_model_type(w, model), model_type)
            )

        def _real_visible(w) -> bool:
            wids = worker_circle_ids(w)
            return not wids or bool(wids & circles)

        def _virtual_visible(v) -> bool:
            owner = getattr(v, "owner_user_id", None)
            cid = getattr(v, "circle_id", None)
            if owner is not None and owner == owner_user_id:
                return True   # private to self
            if owner is not None:
                return False  # someone else's private
            # owner is None: global public or circle-scoped
            return cid is None or cid in circles

        owned = sorted(
            (v for v in self._virtual
             if _matches(v) and owner_user_id is not None
             and getattr(v, "owner_user_id", None) == owner_user_id),
            key=lambda v: v.active_requests,
        )
        shared_list = (
            [w for w in self._workers if _matches(w) and _real_visible(w)]
            + [v for v in self._virtual
               if _matches(v) and _virtual_visible(v)
               # 本人私有源已在 owned 中；访客(owner_user_id=None)不能把 owner=None 的全局公开源当成「本人」排除掉
               and not (owner_user_id is not None
                        and getattr(v, "owner_user_id", None) == owner_user_id)]
        )
        if strategy == "auto":
            # auto = 按 star（reward_multiplier）降序；同分再按负载升序（稳定次序）
            shared = sorted(shared_list, key=lambda w: (-w.reward_multiplier(), w.active_requests))
        else:
            shared = sorted(shared_list, key=lambda w: w.active_requests)
        ordered = owned + shared

        # 钉分享者：只保留化名句柄匹配的 worker（离线则候选为空 → 上层报 no worker）
        if sharer:
            ordered = [w for w in ordered if worker_sharer(w) == sharer]

        if session_key:
            bound = self._sticky_lookup(session_key)
            if bound:
                for i, w in enumerate(ordered):
                    if w.worker_id == bound:
                        ordered.insert(0, ordered.pop(i))
                        break
        # 冷却中的节点下沉：可用节点优先，不可用节点仍作兜底
        return self._sink_cooled(ordered, model)

    def model_access(self, model: str, owner_user_id: Optional[int] = None,
                     user_circle_ids: Optional[set] = None) -> str:
        """该用户能否用某模型：ok | circle（在线但仅圈内/他人私有）| offline（无任何节点提供）。"""
        if model in self.models_for_user(owner_user_id, user_circle_ids):
            return "ok"
        for w in self._workers + self._virtual:
            if worker_has_model(w, model):
                return "circle"
        return "offline"

    def has_owned_worker(self, models: list, owner_user_id: Optional[int]) -> bool:
        """该用户是否拥有可服务 models 中任一模型的个人供给源（用于计费预检豁免）。"""
        if owner_user_id is None:
            return False
        wanted = set(models or [])
        for v in self._virtual:
            if getattr(v, "owner_user_id", None) == owner_user_id and (wanted & set(v.models)):
                return True
        return False

    def models_for_user(self, owner_user_id: Optional[int] = None,
                        user_circle_ids: Optional[set] = None) -> dict:
        """该用户可见的 {model: type}：公共 + 本人私有 + 所属圈子内的模型。"""
        circles = user_circle_ids or set()
        result: dict[str, str] = {}
        for w in self._workers:
            wids = worker_circle_ids(w)
            if not wids or wids & circles:
                for m in w.models:
                    result[m] = prefer_model_type(result.get(m), effective_model_type(w, m))
        for v in self._virtual:
            owner = getattr(v, "owner_user_id", None)
            cid = getattr(v, "circle_id", None)
            if owner is not None and owner == owner_user_id:
                visible = True
            elif owner is not None:
                visible = False
            else:
                visible = cid is None or cid in circles
            if visible:
                for m in v.models:
                    result[m] = prefer_model_type(result.get(m), effective_model_type(v, m))
        return result

    def circle_model_ids_for_user(self, owner_user_id: Optional[int] = None,
                                   user_circle_ids: Optional[set] = None) -> dict:
        """返回 {model: circle_id}，仅包含圈子内可见的 worker 模型（circle_id 非空）。"""
        circles = user_circle_ids or set()
        result: dict[str, int] = {}
        for w in self._workers:
            wids = worker_circle_ids(w)
            if not wids:
                continue
            for cid in wids:
                if cid in circles:
                    for m in w.models:
                        result[m] = cid
        for v in self._virtual:
            owner = getattr(v, "owner_user_id", None)
            cid = getattr(v, "circle_id", None)
            if cid is not None and owner is None and cid in circles:
                for m in v.models:
                    result[m] = cid
        return result

    def models_for_circle(self, circle_id: int) -> list:
        """指定圈子内共享的模型（worker / 公开虚拟源，circle_id 匹配）。"""
        seen: set[str] = set()
        out: list[dict] = []
        for w in self._workers:
            if circle_id not in worker_circle_ids(w):
                continue
            if getattr(w, "owner_user_id", None) is not None:
                continue
            for m in w.models:
                if m in seen:
                    continue
                seen.add(m)
                out.append({
                    "id": m,
                    "model_type": effective_model_type(w, m),
                })
        for v in self._virtual:
            cid = getattr(v, "circle_id", None)
            if cid != circle_id:
                continue
            if getattr(v, "owner_user_id", None) is not None:
                continue
            for m in v.models:
                if m in seen:
                    continue
                seen.add(m)
                out.append({
                    "id": m,
                    "model_type": effective_model_type(v, m),
                })
        return sorted(out, key=lambda x: x["id"])

    def agents_for_circle(self, circle_id: int) -> list:
        """指定圈子内共享的智能体名片（visibility=circle 且 worker 贡献到该圈）。"""
        try:
            cid = int(circle_id)
        except (TypeError, ValueError):
            return []
        seen: set[str] = set()
        out: list[dict] = []
        for w in self._workers:
            if cid not in worker_circle_ids(w):
                continue
            owner = (getattr(w, "owner_nickname", None) or "").strip()
            for card in getattr(w, "agents", None) or []:
                if not isinstance(card, dict) or not card.get("id"):
                    continue
                if (card.get("visibility") or "public") != "circle":
                    continue
                key = f"{card['id']}@{w.worker_id}"
                if key in seen:
                    continue
                seen.add(key)
                raw_dn = card.get("display_name") or card.get("name") or card["id"]
                out.append({
                    "id": card["id"],
                    "name": card.get("name") or "",
                    "display_name": shared_agent_display_name(raw_dn, owner),
                    "description": card.get("description") or "",
                    "runtime": card.get("runtime") or "",
                    "worker_id": w.worker_id,
                    "owner_nickname": owner,
                    "active_requests": w.active_requests,
                    "hire_count": self.agent_hire_count(card["id"]),
                })
        return sorted(out, key=lambda x: (x.get("display_name") or x["id"]))

    def all_models(self) -> list[str]:
        return sorted({m for w in self._workers + self._virtual for m in w.models})

    def all_model_types(self) -> dict[str, str]:
        """Returns {model_name: model_type} for all online models. 高模态优先。"""
        result: dict[str, str] = {}
        for w in self._workers + self._virtual:
            for m in w.models:
                result[m] = prefer_model_type(result.get(m), effective_model_type(w, m))
        return result

    def list_workers(self) -> list[dict]:
        return [w.to_dict() for w in self._workers + self._virtual]

    def all_workers(self) -> list:
        return list(self._workers + self._virtual)

    def list_agents_for_user(self, user_circle_ids: Optional[set] = None,
                             public_only: bool = False) -> list[dict]:
        """在线武将名片列表（脱敏节点名）；不含正文。"""
        circles = user_circle_ids or set()
        rows: list[dict] = []
        for w in self._workers:
            for card in getattr(w, "agents", None) or []:
                if not isinstance(card, dict) or not card.get("id"):
                    continue
                if public_only and (card.get("visibility") or "public") != "public":
                    continue
                if not agent_card_visible(card, w, None if public_only else circles):
                    continue
                owner = (getattr(w, "owner_nickname", None) or "").strip()
                raw_dn = card.get("display_name") or card.get("name") or card["id"]
                rows.append({
                    "id": card["id"],
                    "name": card.get("name") or "",
                    # 账号 + 智能体名；列表侧兜底，兼容旧连接未带 owner_nickname
                    "display_name": shared_agent_display_name(raw_dn, owner),
                    "description": card.get("description") or "",
                    "visibility": card.get("visibility") or "public",
                    # 经由哪些圈子可见：仅与请求者自身圈子的交集，不泄露其它圈子
                    "circle_ids": sorted(worker_circle_ids(w) & circles)
                    if (card.get("visibility") or "public") != "public" and not public_only else [],
                    "runtime": card.get("runtime") or "",
                    "worker_id": w.worker_id,
                    "worker_name": w.name[:1] + "***" if w.name else "***",
                    "owner_nickname": owner,
                    "sharer": worker_sharer(w),
                    "active_requests": w.active_requests,
                    # 真实被雇佣次数（进程内计数；展示侧再加 10–50 稳定偏移）
                    "hire_count": self.agent_hire_count(card["id"]),
                })
        return rows

    def get_agent_for_user(self, assistant_id: str,
                           user_circle_ids: Optional[set] = None,
                           public_only: bool = False) -> Optional[dict]:
        """按 id 取当前用户可见的在线名片；同 id 多节点时取负载最低。"""
        aid = str(assistant_id or "").strip()
        if not aid:
            return None
        matches = [
            row for row in self.list_agents_for_user(
                user_circle_ids=user_circle_ids, public_only=public_only,
            )
            if row.get("id") == aid
        ]
        if not matches:
            return None
        return min(matches, key=lambda r: int(r.get("active_requests") or 0))

    def agent_hire_count(self, assistant_id: str) -> int:
        aid = str(assistant_id or "").strip()
        if not aid:
            return 0
        return int(self._agent_hire_counts.get(aid, 0) or 0)

    def bump_agent_hire(self, assistant_id: str) -> int:
        """雇佣上报 +1；按 assistant_id 聚合（跨 worker 重连）。"""
        aid = str(assistant_id or "").strip()
        if not aid:
            return 0
        self._agent_hire_counts[aid] = int(self._agent_hire_counts.get(aid, 0) or 0) + 1
        return self._agent_hire_counts[aid]

    def pick_agent_workers(self, assistant_id: str,
                           user_circle_ids: Optional[set] = None,
                           worker_id: Optional[str] = None,
                           owner: Optional[str] = None) -> list:
        """可服务该智能体的真实 worker，按负载升序。

        owner 指定时只在该出租者当前在线的设备里自动选，不钉设备 id。
        未给 owner 时，worker_id 仍是旧客户端的偏好钉选；落空则回退任意在线节点。
        """
        aid = (assistant_id or "").strip()
        if not aid:
            return []
        circles = user_circle_ids or set()
        pinned = (worker_id or "").strip() or None
        owner_q = (owner or "").strip().casefold()

        def collect(require_wid: Optional[str]) -> list:
            out = []
            for w in self._workers:
                if require_wid and w.worker_id != require_wid:
                    continue
                if owner_q:
                    nick = (getattr(w, "owner_nickname", None) or "").strip().casefold()
                    if nick != owner_q:
                        continue
                card = next(
                    (c for c in (getattr(w, "agents", None) or [])
                     if isinstance(c, dict) and c.get("id") == aid),
                    None,
                )
                if not card:
                    continue
                if not agent_card_visible(card, w, circles):
                    continue
                out.append(w)
            return sorted(out, key=lambda x: x.active_requests)

        # 按用户名分发：该用户可能有多台设备，选负载最低的一台
        if owner_q:
            return collect(None)
        if pinned:
            hit = collect(pinned)
            if hit:
                return hit
            # 钉选节点已离线/已换 id → 回退
        return collect(None)


pool = WorkerPool()


def worker_circle_ids(w) -> set[int]:
    """Worker 贡献到的圈子 ID 集合；空集表示公开。"""
    ids = getattr(w, "circle_ids", None) or []
    if ids:
        return set(ids)
    cid = getattr(w, "circle_id", None)
    return {cid} if cid is not None else set()


def owner_label_from_user(user) -> str:
    """出租人展示账号：昵称优先，否则邮箱 @ 前一段。"""
    if not user:
        return ""
    nick = str(user.get("nickname") or "").strip()
    if nick:
        return nick
    email = str(user.get("email") or "").strip()
    if "@" in email:
        local = email.split("@", 1)[0].strip()
        if local:
            return local
    return ""


def bare_agent_name(display: str, owner: Optional[str] = None) -> str:
    """去掉已有「账号的」前缀，得到纯智能体名。"""
    name = str(display or "").strip()
    nick = str(owner or "").strip()
    if nick:
        prefix = f"{nick}的"
        if name.startswith(prefix):
            rest = name[len(prefix):].strip()
            return rest or name
    return name or "智能体"


def shared_agent_display_name(base: str, owner: Optional[str] = None) -> str:
    """共享智能体展示名：账号+智能体名，如 adam的写诗专家；已带同前缀则不重复。"""
    nick = str(owner or "").strip()
    name = bare_agent_name(base, nick)
    if not nick:
        return name
    return f"{nick}的{name}"


def normalize_agent_cards(raw, owner_nickname: Optional[str] = None) -> list[dict]:
    """清洗 worker 上报的智能体名片：去正文敏感字段、限制长度；默认拼上出租人账号。"""
    out: list[dict] = []
    seen: set[str] = set()
    owner = str(owner_nickname or "").strip()
    for item in raw or []:
        if not isinstance(item, dict):
            continue
        aid = str(item.get("id") or "").strip()
        if not aid or aid in seen:
            continue
        seen.add(aid)
        vis = str(item.get("visibility") or "public").strip().lower()
        if vis not in ("public", "circle"):
            vis = "public"
        raw_dn = str(item.get("display_name") or item.get("name") or aid)
        out.append({
            "id": aid,
            "name": str(item.get("name") or "")[:80],
            "display_name": shared_agent_display_name(raw_dn, owner)[:120],
            "description": str(item.get("description") or "")[:200],
            "visibility": vis,
            "runtime": str(item.get("runtime") or "")[:40],
        })
    return out


def agent_card_visible(card: dict, worker, user_circle_ids: Optional[set] = None) -> bool:
    """名片可见性：public 全球可见；circle 需与 worker 圈子有交集。"""
    vis = (card or {}).get("visibility") or "public"
    if vis == "public":
        return True
    circles = user_circle_ids or set()
    wids = worker_circle_ids(worker)
    return bool(wids & circles)


def worker_has_agent(worker, assistant_id: str) -> bool:
    aid = (assistant_id or "").strip()
    if not aid:
        return False
    for c in getattr(worker, "agents", None) or []:
        if isinstance(c, dict) and c.get("id") == aid:
            return True
    return False
