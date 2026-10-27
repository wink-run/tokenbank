import asyncio
import json
import logging
import os
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

# 开发环境：加载仓库根目录 .env（DATABASE_URL / ADMIN_KEY 等）
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
except ImportError:
    pass

from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.staticfiles import StaticFiles

from avatar_utils import resolve_avatar_path
import database as db
from admin_router import router as admin_router
from billing_sources_router import router as billing_sources_router
from app_catalog_router import router as app_catalog_router
from routing_catalog_router import router as routing_catalog_router
from community_catalog_router import router as community_catalog_router
from catalog import TIERS, catalog_public_payload
from device_router import router as device_router
from auth import get_current_user_id
from api_errors import DispatchError, openai_error_response
from dispatch import handle_chat
from dispatch_image import handle_image
from dispatch_agent import handle_agent_task, AGENT_TASK_CREDITS
from settler import run_settler
from user_router import router as user_router
from scene_router import router as scene_router
from provider_router import router as provider_router
from config_router import router as config_router
from circle_router import router as circle_router
from studio_router import router as studio_router, admin_router as studio_admin_router
from tools_router import router as tools_router
from worker_pool import (
    pool, WorkerConnection, worker_model_names, default_ttft_ms, worker_sharer,
    normalize_agent_cards, owner_label_from_user, shared_agent_display_name, bare_agent_name,
)
from geo_ip import client_ip_from_ws, resolve_client_ip, resolve_ip_geo, virtual_worker_geo
from contrib_display import apply_contrib_display
from web_public import (
    aggregate_sharer_profile,
    extract_assistant_text,
    guest_trial_allowed,
    infer_model_type,
    normalize_agent_images,
    validate_guest_web_chat_messages,
    validate_web_chat_body,
    validate_web_image_body,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("server")

BASE_DIR = Path(__file__).resolve().parent
DOWNLOADS_DIR = BASE_DIR / "static" / "downloads"
CIRCLE_MEDIA_DIR = BASE_DIR / "data" / "circle_media"

_bearer = HTTPBearer(auto_error=False)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.init_db()
    logger.info("Database ready")
    from config_seed import seed_default_configs, seed_default_studio
    await seed_default_configs()
    await seed_default_studio()
    logger.info("Default config seeded (if empty)")
    # 工具合集站种子数据
    try:
        from seeds.tools_seed import seed_tools
        await seed_tools()
        logger.info("Tools seeded (if empty)")
    except Exception as e:
        logger.warning(f"Failed to seed tools: {e}")
    from admin_router import _sync_virtual_pool
    await _sync_virtual_pool()
    logger.info("Virtual agents synced")
    _cleanup_img_cache()
    task = asyncio.create_task(run_settler())
    yield
    task.cancel()
    await db.close_pool()


# landing 页产品截图，需长期保留（与 landing.html data-tab / img_cache/{key}.webp 对齐）
_LANDING_SCREENSHOTS = frozenset({
    "dashboard.webp", "gateway.webp", "provider.webp",
    "dashboard_en.webp", "gateway_en.webp", "provider_en.webp",
    "contribute.webp", "contribute_en.webp",
    "circle.webp", "circle_en.webp",
    "world.webp", "world_en.webp",
    "device.webp", "device_en.webp",
    "trace.webp", "trace_en.webp",
    # 会话 / 游乐场 / 画像 / 资源（此前缺文件导致 hero 破图）
    "sessions.webp", "sessions_en.webp",
    "playground.webp", "playground_en.webp",
    "portrait.webp", "portrait_en.webp",
    "assets.webp", "assets_en.webp",
})


def _cleanup_img_cache() -> None:
    """Delete img_cache files older than 1 hour on startup."""
    from dispatch_image import IMG_CACHE_DIR
    if not IMG_CACHE_DIR.is_dir():
        return
    cutoff = time.time() - 3600
    for p in IMG_CACHE_DIR.iterdir():
        if p.name in _LANDING_SCREENSHOTS:
            continue
        if p.is_file() and p.stat().st_mtime < cutoff:
            try:
                p.unlink()
            except OSError:
                pass


app = FastAPI(title="LLM Proxy", lifespan=lifespan)
# CORS：直连 8000 / 开发调试；经 nginx HTTPS 反代时由 nginx 统一加头（见 default.conf.template）
_cors_raw = os.getenv("CORS_ORIGINS", "*").strip()
_cors_origins = ["*"] if _cors_raw in ("", "*") else [o.strip() for o in _cors_raw.split(",") if o.strip()]
# 与 allow_origins=["*"] 二选一，避免同时回显 Origin 与 * 导致重复头
_cors_use_wildcard = "*" in _cors_origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_origin_regex=None if _cors_use_wildcard else r"https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)


def _openai_path(path: str) -> bool:
    return path.startswith("/v1/")


@app.exception_handler(DispatchError)
async def dispatch_error_handler(request: Request, exc: DispatchError):
    worker_id = getattr(exc, "worker_id", None)
    workers = getattr(exc, "workers", None)
    if _openai_path(request.url.path):
        return openai_error_response(exc.status_code, exc.message, exc.error_type,
                                     worker_id=worker_id, workers=workers)
    content = {"detail": exc.message}
    if worker_id:
        content["worker_id"] = worker_id
    if workers:
        content["workers"] = workers
    return JSONResponse(status_code=exc.status_code, content=content,
                        headers={"X-TB-Worker": worker_id} if worker_id else None)


@app.exception_handler(HTTPException)
async def openai_http_exception_handler(request: Request, exc: HTTPException):
    if _openai_path(request.url.path):
        detail = exc.detail if isinstance(exc.detail, str) else str(exc.detail)
        etype = "invalid_request_error"
        if exc.status_code == 401:
            etype = "authentication_error"
        elif exc.status_code == 402:
            etype = "insufficient_credits"
        elif exc.status_code == 429:
            etype = "rate_limit_exceeded"
        elif exc.status_code in (503, 504):
            etype = "service_unavailable" if exc.status_code == 503 else "timeout"
        return openai_error_response(exc.status_code, detail, etype)
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})


app.include_router(admin_router, prefix="/admin")
app.include_router(billing_sources_router, prefix="/admin")
app.include_router(app_catalog_router, prefix="/admin")
app.include_router(routing_catalog_router, prefix="/admin")
app.include_router(community_catalog_router, prefix="/admin")
app.include_router(user_router, prefix="/user")
app.include_router(scene_router, prefix="/user")
app.include_router(provider_router, prefix="/user")   # 个人供给源 /user/providers + /user/oauth/claude/*
app.include_router(config_router, prefix="/api")   # GET /api/config/tools|routes (user JWT)
app.include_router(circle_router, prefix="/user")
app.include_router(studio_router, prefix="/user")          # 社区圈 场景/插件（用户端）
app.include_router(studio_admin_router, prefix="/admin")   # 社区圈 预定义（管理员）
                                                    # PUT/DELETE /api/config/tools|routes (admin)
app.include_router(tools_router, tags=["tools"])           # 工具合集站（消费端）
app.include_router(device_router, tags=["device"])


# ── 静态文件 & 落地页 ─────────────────────────────────────────────────────────

@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    """避免浏览器默认请求 favicon 触发 404。"""
    from fastapi.responses import Response
    return Response(status_code=204)


@app.get("/")
async def landing():
    return FileResponse("static/landing.html")


@app.get("/app")
async def user_app():
    return FileResponse("static/app.html")


@app.get("/wall")
async def wall_page():
    return FileResponse("static/wall.html")


@app.get("/network")
async def network_page():
    """公开：全球网络页（模型/智能体可试用，用户可看贡献者主页）"""
    return FileResponse("static/network.html")


@app.get("/circles")
@app.get("/circles/browse")
async def circles_web_page():
    """网页版圈子：我的圈子 / 浏览公开圈子"""
    return FileResponse("static/circles.html")


@app.get("/studio/chat")
async def studio_scene_chat_page():
    """社区圈场景 · 网页对话页（场景「使用」入口）"""
    return FileResponse("static/scene-chat.html")


@app.get("/c/{circle_id}")
async def circle_detail_web_page(circle_id: int):
    """网页版圈子主页"""
    _ = circle_id
    return FileResponse("static/circles.html")


@app.get("/m/{model_name:path}")
async def model_landing_page(model_name: str):
    """公开：模型网页试用落地页"""
    _ = (model_name or "").strip()
    return FileResponse("static/model-landing.html")


@app.get("/u/{sharer}")
async def sharer_landing_page(sharer: str):
    """公开：贡献者主页（分享的模型与智能体）"""
    _ = (sharer or "").strip()
    return FileResponse("static/sharer-landing.html")


@app.get("/privacy")
async def privacy_policy():
    """App Store / 公开可访问的隐私政策页"""
    return FileResponse("static/privacy.html")


@app.get("/tools")
async def tools_hub_page():
    """公开：出租智能体市场（用户出租 + 平台虚拟，对齐虚拟智能体）"""
    return FileResponse("static/tools.html")


@app.get("/tools/{tool_id}")
async def tool_detail_page(tool_id: str):
    """出租智能体详情页（路径参数由前端 JS 解析；支持 agent:<id>）"""
    _ = tool_id
    return FileResponse("static/tools.html")


@app.get("/tools/tasks/{task_id}")
async def tool_task_page(task_id: str):
    """智能体任务进度页（路径参数由前端 JS 解析）"""
    _ = task_id
    return FileResponse("static/tools.html")


@app.get("/a/{assistant_id}")
async def agent_landing_page(assistant_id: str):
    """已分享智能体的网页版落地页（全球 / 圈子共用同一入口）"""
    # assistant_id 仅用于前端路由解析；静态页本身不依赖路径参数
    _ = (assistant_id or "").strip()
    return FileResponse("static/agent-landing.html")


@app.get("/api/catalog")
async def public_catalog():
    """公开接口：供给源目录（registry providers + 个人源 APP/API 订阅模板）"""
    return await catalog_public_payload()


@app.get("/api/community-catalog")
async def public_community_catalog():
    """公开接口：社区推荐目录(mcp/prompts/skills/assistants)"""
    import community_catalog as cc
    return await cc.community_catalog_payload()


@app.get("/public/studio")
async def public_studio():
    """公开接口：社区圈官方场景 + 插件（无 content；社区页「可用资源」用）"""
    import database as db
    scenes = [db._scene_public(s) for s in await db.list_official_scenes()]
    mods = [db._mod_public(m) for m in await db.list_official_mods()]
    return {"scenes": scenes, "mods": mods}


@app.get("/api/rates")
async def public_rates():
    """公开接口：模型汇率 + 跨层折算矩阵"""
    all_models = await db.list_model_configs()
    enabled = [m for m in all_models if m.get("enabled")]

    model_list = [
        {
            "name": m["name"],
            "display_name": m.get("display_name") or m["name"],
            "tier": m["tier"],
            "contribute_rate": m["contribute_rate"],
            "consume_rate": m["consume_rate"],
        }
        for m in enabled
    ]

    # 按 tier 分组，计算每层的平均贡献率 / 消费率
    tier_stats: dict[str, dict] = {}
    for m in enabled:
        t = m["tier"]
        s = tier_stats.setdefault(t, {"contribute": [], "consume": []})
        s["contribute"].append(m["contribute_rate"])
        s["consume"].append(m["consume_rate"])

    tiers = {}
    for t, s in tier_stats.items():
        avg_c = sum(s["contribute"]) / len(s["contribute"])
        avg_x = sum(s["consume"])    / len(s["consume"])
        tiers[t] = {"avg_contribute_rate": round(avg_c, 2),
                    "avg_consume_rate":    round(avg_x, 2)}

    # 跨层折算矩阵：贡献 tier A 的 1K tokens 能消耗 tier B 的多少 K tokens
    # exchange[from_tier][to_tier] = avg_contribute_rate(A) / avg_consume_rate(B)
    exchange: dict[str, dict] = {}
    for from_tier, fs in tiers.items():
        exchange[from_tier] = {}
        for to_tier, ts in tiers.items():
            ratio = round(fs["avg_contribute_rate"] / ts["avg_consume_rate"], 2) if ts["avg_consume_rate"] else 0
            exchange[from_tier][to_tier] = ratio

    return {"models": model_list, "tiers": tiers, "exchange": exchange}


@app.get("/api/wall")
async def wall():
    users = await db.get_wall_users()
    return {"users": users}


def _mask_name(name: str) -> str:
    """脱敏：保留首字符 + 最多 4 个星号 + 后续明文"""
    if not name:
        return "***"
    if len(name) <= 2:
        return name[0] + "*"
    masked = min(4, len(name) - 2)
    return name[0] + "*" * masked + name[1 + masked:]


def _stars(multiplier: float) -> int:
    if multiplier >= 1.3: return 5
    if multiplier >= 1.1: return 4
    if multiplier >= 0.9: return 3
    if multiplier >= 0.7: return 2
    return 1


def _worker_row(w) -> dict:
    stats = w.period_stats
    total_req = sum(s["requests"] for s in stats.values())
    total_success = sum(s["success"] for s in stats.values())
    total_ttft = sum(s.get("ttft_sum", 0) for s in stats.values())
    total_ttft_count = sum(s.get("ttft_count", 0) for s in stats.values())
    total_tokens = sum(s["output_tokens"] for s in stats.values())
    # 智能体接单次数（period_stats 里 __agent__:id 条目）
    period_agent_jobs = sum(
        int(s.get("agent_count") or 0)
        for k, s in stats.items()
        if str(k).startswith("__agent__")
    )
    success_rate = total_success / total_req if total_req > 0 else 1.0
    online_mins = w.period_online_mins()
    # 每模型延迟：有实测用实测，否则服务端生成稳定默认 TTFT
    model_latency = {}
    for model in sorted(worker_model_names(w)):
        s = stats.get(model, {})
        if s.get("last_ttft_ms") is not None:
            last_ms = int(s["last_ttft_ms"])
        else:
            last_ms = default_ttft_ms(w.worker_id, model)
        tc = s.get("ttft_count") or 0
        avg_ms = round(s.get("ttft_sum", 0) / tc) if tc > 0 else last_ms
        model_latency[model] = {"last_ttft_ms": last_ms, "avg_ttft_ms": avg_ms}
    if total_ttft_count > 0:
        avg_ttft_ms = total_ttft / total_ttft_count
    elif model_latency:
        avg_ttft_ms = sum(m["last_ttft_ms"] for m in model_latency.values()) / len(model_latency)
    else:
        avg_ttft_ms = 0
    # star 系数：抽到 WorkerConnection.reward_multiplier()，与 auto 策略选优同源
    multiplier = w.reward_multiplier()
    status = "busy" if (w.active_requests or 0) > 0 else "idle"
    # 上架智能体裸名（去「昵称的」前缀），供排行/在线节点与模型并列展示
    owner_nick = (getattr(w, "owner_nickname", None) or "").strip()
    agent_labels = []
    for c in getattr(w, "agents", None) or []:
        if not isinstance(c, dict):
            continue
        raw = c.get("display_name") or c.get("name") or c.get("id") or ""
        label = bare_agent_name(raw, owner_nick) or str(c.get("id") or "").strip()
        if label and label not in agent_labels:
            agent_labels.append(label)
    # 排行/大屏展示账号名（昵称），不用客户端上报的主机名（如 Mac.local）
    display_name = owner_nick or (getattr(w, "name", None) or "")
    row = {
        "worker_id": w.worker_id,
        "name": _mask_name(display_name),
        "models": w.models,
        "agents": agent_labels,
        "active_requests": w.active_requests,
        "period_tokens": total_tokens,
        "period_agent_jobs": period_agent_jobs,
        "avg_latency_ms": round(avg_ttft_ms),
        "multiplier": multiplier,
        "stars": _stars(multiplier),
        "sharer": worker_sharer(w),   # 分享者化名句柄（钉分享者用；不含用户名/真 user_id）
        "online_mins": round(online_mins, 1),
        "connected_at": w.connected_at.isoformat(),
        "status": status,
        "model_latency": model_latency,
        # 地图黄点：有智能体名片的节点
        "has_agents": bool(agent_labels),
        "agent_count": len(agent_labels),
    }
    lat = getattr(w, "latitude", None)
    lng = getattr(w, "longitude", None)
    if lat is not None and lng is not None:
        geo_row = {
            "lat": lat,
            "lng": lng,
            "country": getattr(w, "country_code", "") or "",
        }
        city = getattr(w, "city", "") or ""
        if city:
            geo_row["city"] = city
        row["geo"] = geo_row
    return row


@app.get("/api/workers-wall")
async def workers_wall():
    """公开接口：大屏展示用，脱敏后返回在线 Worker 列表"""
    rows, _extra = apply_contrib_display([_worker_row(w) for w in pool.all_workers()])
    return {"workers": rows, "total": len(rows)}


@app.get("/public/network")
async def public_network(request: Request):
    """公开：全局运营统计 + 在线 Worker 列表（脱敏）。
    若带 JWT/API Key，圈子列表附带 join_status。
    """
    uid: Optional[int] = None
    auth = (request.headers.get("authorization") or "").strip()
    if auth.lower().startswith("bearer "):
        raw = auth[7:].strip()
        if raw:
            try:
                info = await db.verify_key(raw)
                if info and info.get("user_id"):
                    uid = int(info["user_id"])
                else:
                    from auth import decode_token
                    decoded = decode_token(raw)
                    if decoded:
                        uid = int(decoded)
            except Exception:
                uid = None

    all_ws = pool.all_workers()   # capture once
    workers_data, contrib = apply_contrib_display([_worker_row(w) for w in all_ws])
    distinct_users = len({w.user_id for w in all_ws if w.user_id})
    # 与匿名 /v1/models 同源：公开 worker 模型（不含圈子限定）
    public_models = pool.models_for_user(owner_user_id=None, user_circle_ids=set())
    circle_count = await db.count_public_circles()
    # 已登录：带入圈状态，便于「进主页 / 申请加入」
    if uid is not None:
        browsable = await db.list_browsable_circles(uid)
        public_circles = [{
            "id": c["id"],
            "name": c.get("name") or "",
            "description": c.get("description") or "",
            "max_members": c.get("max_members"),
            "member_count": int(c.get("member_count") or 0),
            "full": bool(c.get("full")),
            "join_status": c.get("join_status") or "none",
            "code": c.get("code"),
        } for c in browsable[:50]]
    else:
        public_circles = await db.list_public_circles(50)
        for row in public_circles:
            row["join_status"] = "none"
    return {
        "summary": {
            "online_workers": len(workers_data),
            "active_users": distinct_users,
            "circle_count": circle_count,
            **contrib,
        },
        "workers": workers_data,
        "available_models": sorted(public_models.keys()),
        # id → chat|vision|image|embedding
        "available_model_types": {
            m: infer_model_type(m, public_models) for m in public_models
        },
        "available_agents": await _list_public_agents(),
        "available_circles": public_circles,
    }


@app.get("/public/sharers/{sharer}")
async def public_sharer_profile(sharer: str):
    """公开：某分享者当前在线贡献（模型 + 公开智能体）"""
    handle = (sharer or "").strip()
    if not handle:
        raise HTTPException(400, "missing sharer")
    await backfill_worker_owner_labels()
    workers = pool.all_workers()
    profile = aggregate_sharer_profile(
        workers,
        handle,
        mask_name=_mask_name,
        worker_sharer_fn=worker_sharer,
    )
    if not profile:
        raise HTTPException(404, "sharer offline or not found")
    # 附带一句话画像（若用户已同步）
    from worker_pool import worker_owner_id
    uid = next(
        (worker_owner_id(w) for w in workers if worker_sharer(w) == handle and worker_owner_id(w) is not None),
        None,
    )
    if uid is not None:
        user = await db.get_user_by_id(uid)
        persona = str((user or {}).get("persona") or "").strip()
        if persona:
            profile["persona"] = persona
    return {"sharer": profile}


async def backfill_worker_owner_labels() -> None:
    """给缺少账号展示名的在线 worker 回填，使列表能拼出「账号的智能体名」。"""
    for w in list(getattr(pool, "_workers", []) or []):
        if not getattr(w, "agents", None):
            continue
        if (getattr(w, "owner_nickname", None) or "").strip():
            continue
        uid = getattr(w, "user_id", None)
        if not uid:
            continue
        try:
            user = await db.get_user_by_id(uid)
        except Exception:
            continue
        label = owner_label_from_user(user)
        if not label:
            continue
        w.owner_nickname = label
        # 同步刷新名片 display_name
        refreshed = []
        for c in w.agents:
            if not isinstance(c, dict):
                continue
            base = bare_agent_name(c.get("display_name") or c.get("name") or c.get("id"), label)
            refreshed.append({**c, "display_name": shared_agent_display_name(base, label)})
        w.agents = refreshed


async def _list_public_agents() -> list:
    await backfill_worker_owner_labels()
    return pool.list_agents_for_user(public_only=True)


@app.get("/public/agents")
async def public_agents():
    """公开在线智能体名片（仅 visibility=public）"""
    return {"agents": await _list_public_agents()}


@app.get("/public/agents/{assistant_id}")
async def public_agent_detail(assistant_id: str):
    """全球公开智能体单条名片（匿名可读）"""
    await backfill_worker_owner_labels()
    aid = (assistant_id or "").strip()
    if not aid:
        raise HTTPException(400, "missing assistant_id")
    card = pool.get_agent_for_user(aid, public_only=True)
    if not card:
        raise HTTPException(404, "agent not found or offline")
    return {"agent": card, "credits_per_task": AGENT_TASK_CREDITS}


async def auth_api_key_or_jwt(
    creds: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
) -> int:
    """与模型调用一致：优先 API Key（cloud_config.token / sk-…），否则用户 JWT。"""
    if not creds or not (creds.credentials or "").strip():
        raise HTTPException(401, "Not authenticated")
    raw = creds.credentials.strip()
    info = await db.verify_key(raw)
    if info and info.get("user_id"):
        return int(info["user_id"])
    from auth import decode_token
    uid = decode_token(raw)
    if not uid:
        raise HTTPException(401, "Invalid or expired token")
    return int(uid)


async def optional_auth_api_key_or_jwt(
    creds: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
) -> Optional[int]:
    """可选鉴权：无 token 返回 None（访客）；有 token 则与 auth_api_key_or_jwt 相同。"""
    if not creds or not (creds.credentials or "").strip():
        return None
    return await auth_api_key_or_jwt(creds)


def _client_ip(request: Request) -> str:
    """取访客限流用 IP（优先 X-Forwarded-For）。"""
    xff = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    if xff:
        return xff
    if request.client and request.client.host:
        return request.client.host
    return "unknown"


async def _ensure_web_model_access(model: str, uid: Optional[int]) -> None:
    """网页试用前确认模型对当前用户可用；否则给出可读错误（type 供前端区分）。"""
    circles = set(await db.get_user_circle_ids(uid)) if uid is not None else set()
    access = pool.model_access(model, owner_user_id=uid, user_circle_ids=circles)
    if access == "offline":
        raise HTTPException(503, detail={
            "error": f"模型「{model}」当前没有在线节点，请换一个模型试试 / Model '{model}' is offline right now",
            "type": "model_offline",
        })
    if access == "circle":
        raise HTTPException(403, detail={
            "error": (f"模型「{model}」仅圈子成员可用，请登录并加入对应圈子"
                      if uid is None else f"模型「{model}」仅圈子成员可用，请先加入对应圈子")
                     + f" / Model '{model}' is only shared inside a circle",
            "type": "circle_only",
        })


class WebChatBody(BaseModel):
    model: str
    messages: list
    sharer: Optional[str] = None
    stream: Optional[bool] = True


@app.post("/api/web-chat")
async def web_chat(
    body: WebChatBody,
    request: Request,
    uid: Optional[int] = Depends(optional_auth_api_key_or_jwt),
):
    """网页模型短试用。
    - 已登录：多轮对话，按正常积分扣费
    - 未登录：仅允许单轮（一条 user），按 IP 限流
    - stream=true（默认）：OpenAI SSE 流式输出
    """
    try:
        cleaned = validate_web_chat_body(body.model, body.messages, body.sharer)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    public_types = pool.models_for_user(owner_user_id=None, user_circle_ids=set())
    if infer_model_type(cleaned["model"], public_types) == "image":
        raise HTTPException(400, "image model: use /api/web-image")
    if infer_model_type(cleaned["model"], public_types) == "embedding":
        raise HTTPException(400, "embedding model not supported on web chat")

    guest = uid is None
    await _ensure_web_model_access(cleaned["model"], uid)
    if guest:
        try:
            validate_guest_web_chat_messages(cleaned["messages"])
        except ValueError as e:
            raise HTTPException(401, str(e)) from e
        if not guest_trial_allowed(_client_ip(request)):
            raise HTTPException(429, "guest trial limit reached — sign in to continue")

    want_stream = body.stream is not False
    chat_body = {
        "model": cleaned["model"],
        "messages": cleaned["messages"],
        "stream": want_stream,
    }
    try:
        resp = await handle_chat(
            chat_body,
            consumer_user_id=uid,
            strategy="auto",
            sharer=cleaned["sharer"] if not guest else None,
        )
    except DispatchError as e:
        raise HTTPException(
            e.status_code,
            detail={"error": e.message, "type": getattr(e, "error_type", None)},
        ) from e

    # 流式：透传 OpenAI SSE，附带访客标记供前端收尾
    if want_stream and isinstance(resp, StreamingResponse):
        headers = {
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
        wid = resp.headers.get("X-TB-Worker")
        if wid:
            headers["X-TB-Worker"] = wid
        if guest:
            headers["X-TB-Guest"] = "1"
            headers["X-TB-Need-Login"] = "1"
        return StreamingResponse(
            resp.body_iterator,
            media_type="text/event-stream",
            headers=headers,
        )

    payload = None
    worker_id = None
    if isinstance(resp, JSONResponse):
        worker_id = resp.headers.get("X-TB-Worker")
        try:
            raw = resp.body
            if isinstance(raw, (bytes, bytearray)):
                payload = json.loads(raw.decode("utf-8"))
            else:
                payload = json.loads(raw)
        except Exception:
            payload = None
    elif isinstance(resp, dict):
        payload = resp

    text = extract_assistant_text(payload)
    if not text and payload is None:
        raise HTTPException(502, "empty response")
    return {
        "ok": True,
        "model": cleaned["model"],
        "output": text,
        "worker_id": worker_id,
        "sharer": cleaned["sharer"] if not guest else None,
        "guest": guest,
        "need_login_to_continue": guest,
    }


class SceneChatBody(BaseModel):
    messages: list
    stream: Optional[bool] = True


@app.post("/user/studio/scenes/{scene_id}/chat")
async def scene_chat(scene_id: int, body: SceneChatBody, uid: int = Depends(get_current_user_id)):
    """社区圈场景网页对话：服务端注入 persona + 已购插件 content（前端永不见），
    走与 /api/web-chat 相同的派发/流式。"""
    import database as db
    import studio_router as _sr
    scene = await db.get_studio_scene(scene_id)
    if not scene or not await _sr._scene_accessible(scene, uid):
        raise HTTPException(404, "场景不存在或无权限")
    # 校验客户端消息：仅 user/assistant（system 由服务端注入，客户端不得传）
    msgs = []
    for i, raw in enumerate(body.messages or []):
        if not isinstance(raw, dict):
            raise HTTPException(400, f"messages[{i}] must be object")
        role = raw.get("role")
        if role not in ("user", "assistant"):
            raise HTTPException(400, f"messages[{i}].role must be user/assistant")
        content = raw.get("content")
        if not isinstance(content, str) or not content.strip():
            raise HTTPException(400, f"messages[{i}].content must be non-empty string")
        if len(content) > 20000:
            raise HTTPException(400, f"messages[{i}] too long")
        msgs.append({"role": role, "content": content})
    if not msgs or msgs[-1]["role"] != "user":
        raise HTTPException(400, "last message must be from user")
    if len(msgs) > 40:
        raise HTTPException(400, "too many messages")

    system = await _sr.build_scene_system_prompt(scene, uid)
    final = ([{"role": "system", "content": system}] if system else []) + msgs
    model = scene.get("default_model") or "auto"
    want_stream = body.stream is not False
    chat_body = {"model": model, "messages": final, "stream": want_stream}
    try:
        resp = await handle_chat(chat_body, consumer_user_id=uid, strategy="auto")
    except DispatchError as e:
        raise HTTPException(
            e.status_code,
            detail={"error": e.message, "type": getattr(e, "error_type", None)},
        ) from e
    if want_stream and isinstance(resp, StreamingResponse):
        return StreamingResponse(
            resp.body_iterator,
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )
    payload = None
    if isinstance(resp, JSONResponse):
        try:
            raw = resp.body
            payload = json.loads(raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else raw)
        except Exception:
            payload = None
    elif isinstance(resp, dict):
        payload = resp
    return {"ok": True, "output": extract_assistant_text(payload), "model": model}


class WebImageBody(BaseModel):
    model: str
    prompt: str
    n: int = 1
    sharer: Optional[str] = None


@app.post("/api/web-image")
async def web_image(body: WebImageBody, uid: int = Depends(auth_api_key_or_jwt)):
    """网页文生图试用（JWT/API Key）；返回 url / b64。"""
    try:
        cleaned = validate_web_image_body(body.model, body.prompt, body.n)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    public_types = pool.models_for_user(owner_user_id=None, user_circle_ids=set())
    if infer_model_type(cleaned["model"], public_types) != "image":
        raise HTTPException(400, "chat model: use /api/web-chat")

    sh = str(body.sharer or "").strip() or None
    if sh and not (sh.startswith("s_") and len(sh) >= 4):
        raise HTTPException(400, "invalid sharer")
    await _ensure_web_model_access(cleaned["model"], uid)

    img_body = {
        "model": cleaned["model"],
        "prompt": cleaned["prompt"],
        "n": cleaned["n"],
        "response_format": "url",
    }
    try:
        result = await handle_image(img_body, consumer_user_id=uid, sharer=sh)
    except DispatchError as e:
        raise HTTPException(
            e.status_code,
            detail={"error": e.message, "type": getattr(e, "error_type", None)},
        ) from e

    data = result.get("data") if isinstance(result, dict) else None
    urls = []
    if isinstance(data, list):
        for item in data:
            if not isinstance(item, dict):
                continue
            if item.get("url"):
                urls.append(item["url"])
            elif item.get("b64_json"):
                urls.append(f"data:image/png;base64,{item['b64_json']}")
    return {
        "ok": True,
        "model": cleaned["model"],
        "images": urls,
        "created": result.get("created") if isinstance(result, dict) else None,
        "sharer": sh,
    }


@app.get("/api/agents")
async def api_agents(uid: int = Depends(auth_api_key_or_jwt)):
    """可见智能体：公开 + 所属圈子（鉴权与模型一致：API Key 或 JWT）"""
    await backfill_worker_owner_labels()
    circles = set(await db.get_user_circle_ids(uid))
    return {
        "agents": pool.list_agents_for_user(user_circle_ids=circles),
        "credits_per_task": AGENT_TASK_CREDITS,
    }


@app.get("/api/agents/{assistant_id}")
async def api_agent_detail(assistant_id: str, uid: int = Depends(auth_api_key_or_jwt)):
    """当前用户可见的单条名片（全球公开 ∪ 所属圈子）"""
    await backfill_worker_owner_labels()
    aid = (assistant_id or "").strip()
    if not aid:
        raise HTTPException(400, "missing assistant_id")
    circles = set(await db.get_user_circle_ids(uid))
    card = pool.get_agent_for_user(aid, user_circle_ids=circles)
    if not card:
        raise HTTPException(404, "agent not found, offline, or not visible")
    return {"agent": card, "credits_per_task": AGENT_TASK_CREDITS}


class AgentHireBody(BaseModel):
    assistant_id: str
    worker_id: Optional[str] = None


@app.post("/api/agents/hire")
async def api_agent_hire(body: AgentHireBody, uid: int = Depends(auth_api_key_or_jwt)):
    """雇佣上报：真实被雇次数 +1（展示层另加 10–50 偏移）。"""
    aid = (body.assistant_id or "").strip()
    if not aid:
        raise HTTPException(400, "missing assistant_id")
    count = pool.bump_agent_hire(aid)
    return {"ok": True, "assistant_id": aid, "hire_count": count}


class AgentTaskBody(BaseModel):
    assistant_id: str
    prompt: str = ""
    worker_id: Optional[str] = None
    timeout_ms: Optional[int] = None
    stream: Optional[bool] = False
    # 本轮附图：[{dataUrl, name?}]，仅 data:image/…
    images: Optional[list] = None
    # 工具合集通行门票据：看广告后匿名可用一次（见 /api/tools/gate）
    gate_ticket: Optional[str] = None


@app.post("/api/agent-tasks")
async def create_agent_task(
    body: AgentTaskBody,
    request: Request,
    uid: Optional[int] = Depends(optional_auth_api_key_or_jwt),
):
    """发起远程武将任务。
    - 已登录：JWT/API Key，按固定积分扣费
    - 未登录：公开智能体单轮试用，按 IP 限流
    - stream=true：SSE（progress / done / error）
    """
    try:
        task_images = normalize_agent_images(body.images)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    guest = uid is None
    gate_pass = False
    if guest and (body.gate_ticket or "").strip():
        # 工具合集：看完广告拿到的票可匿名用一次，绕过访客试用限流
        from tools_router import redeem_agent_gate_ticket
        meta = redeem_agent_gate_ticket(body.gate_ticket.strip(), body.assistant_id)
        if not meta:
            raise HTTPException(
                401,
                "invalid or used gate ticket — watch an ad again or sign in",
            )
        gate_pass = True
    if guest:
        text = (body.prompt or "").strip()
        if not text and not task_images:
            raise HTTPException(400, "prompt required")
        # 访客禁止带历史（前端多轮会包装 Conversation so far）
        if text.startswith("Conversation so far:"):
            raise HTTPException(401, "guest trial: one turn only — sign in to continue")
        if not gate_pass and not guest_trial_allowed(_client_ip(request)):
            raise HTTPException(429, "guest trial limit reached — sign in to continue")

    guest_ip = _client_ip(request) if guest else None
    if body.stream:
        from dispatch_agent import iter_agent_task_sse
        gen = iter_agent_task_sse(
            assistant_id=body.assistant_id,
            prompt=body.prompt,
            consumer_user_id=uid,
            worker_id=body.worker_id,
            timeout_ms=body.timeout_ms,
            guest=guest,
            guest_ip=guest_ip,
            images=task_images or None,
        )
        return StreamingResponse(
            gen,
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    result = await handle_agent_task(
        assistant_id=body.assistant_id,
        prompt=body.prompt,
        consumer_user_id=uid,
        worker_id=body.worker_id,
        timeout_ms=body.timeout_ms,
        guest_ip=guest_ip,
        images=task_images or None,
    )
    if not result.get("ok"):
        status = result.get("status") or "failed"
        code = 402 if "credit" in str(result.get("error") or "").lower() else (
            404 if status == "rejected" and "No online" in str(result.get("error") or "") else 400
        )
        if status == "timeout":
            code = 504
        raise HTTPException(code, detail=result)
    result["guest"] = guest
    result["need_login_to_continue"] = guest
    return result


@app.get("/api/agent-downloads")
async def agent_downloads():
    items: list[dict] = []
    if not DOWNLOADS_DIR.is_dir():
        return {"items": items}
    root = DOWNLOADS_DIR.resolve()
    for p in sorted(DOWNLOADS_DIR.iterdir()):
        if not p.is_file() or p.name.startswith("."):
            continue
        if p.parent.resolve() != root:
            continue
        try:
            st = p.stat()
        except OSError:
            continue
        items.append({"filename": p.name, "url": f"/download/llm-agent/{p.name}", "bytes": st.st_size})
    return {"items": items}


@app.get("/download/llm-agent/{filename}")
async def download_agent(filename: str):
    safe = Path(filename).name
    if not safe or safe != filename:
        raise HTTPException(400, "Invalid filename")
    path = DOWNLOADS_DIR / safe
    if not path.is_file() or path.parent.resolve() != DOWNLOADS_DIR.resolve():
        raise HTTPException(404, "Not found")
    return FileResponse(path, filename=safe, media_type="application/octet-stream",
                        content_disposition_type="attachment")


@app.get("/media/circle/{circle_id}/{filename}")
async def serve_circle_media(circle_id: int, filename: str):
    """圈子消息图片（公开可读，需知道 URL）。"""
    safe = Path(filename).name
    if not safe or safe != filename:
        raise HTTPException(400, "Invalid filename")
    path = CIRCLE_MEDIA_DIR / str(circle_id) / safe
    root = (CIRCLE_MEDIA_DIR / str(circle_id)).resolve()
    if not path.is_file() or path.resolve().parent != root:
        raise HTTPException(404, "Not found")
    return FileResponse(path)


@app.get("/avatar/{filename}")
async def serve_avatar(filename: str):
    """用户头像（注册时随机分配）。"""
    path = resolve_avatar_path(filename)
    if not path:
        raise HTTPException(404, "Not found")
    return FileResponse(path)


app.mount("/static", StaticFiles(directory="static"), name="static")


# ── Worker WebSocket ──────────────────────────────────────────────────────────

@app.websocket("/ws/worker")
async def worker_ws(ws: WebSocket):
    await ws.accept()
    peer = ws.client  # (host, port)，便于排查来源
    logger.info("[worker/ws] connected peer=%s path=/ws/worker", peer)
    worker: Optional[WorkerConnection] = None
    try:
        # Client may probe CLIs (Cursor status <=45s) before first register; keep headroom.
        raw = await asyncio.wait_for(ws.receive_text(), timeout=60)
        msg = json.loads(raw)

        if msg.get("type") != "register":
            logger.warning(
                "[worker/ws] register denied peer=%s reason=bad_message_type",
                peer,
            )
            await ws.close(code=4001, reason="Unauthorized")
            return

        worker_key = (msg.get("worker_key") or "").strip()
        if not worker_key:
            logger.warning(
                "[worker/ws] register denied peer=%s reason=missing_worker_key",
                peer,
            )
            await ws.close(code=4001, reason="Unauthorized")
            return

        user = await db.get_user_by_worker_key(worker_key)
        if not user:
            logger.warning(
                "[worker/ws] register denied peer=%s reason=unknown_worker_key",
                peer,
            )
            await ws.close(code=4001, reason="Unauthorized")
            return

        user_id = user["id"]

        worker_id = str(uuid.uuid4())[:8]
        worker_name = (msg.get("name") or "").strip()
        if not worker_name:
            worker_name = (user.get("nickname") or "").strip()
        if not worker_name:
            worker_name = f"worker-{worker_id}"
        # 出租人账号：共享智能体展示名用「{账号}的{智能体名}」
        owner_nickname = owner_label_from_user(user)
        raw_models = msg.get("models", [])
        models = []
        model_types: dict[str, str] = {}
        for entry in raw_models:
            if isinstance(entry, str):
                model_name = entry.strip()
                if model_name:
                    models.append(model_name)
                    model_types[model_name] = infer_model_type(model_name, {model_name: "chat"})
            elif isinstance(entry, dict):
                model_name = (entry.get("name") or "").strip()
                mtype = entry.get("type", "chat")
                # 与客户端对齐：chat / vision / image / embedding
                if model_name and mtype in ("chat", "vision", "image", "embedding",
                                             "text", "vl", "vlm", "embed", "embeddings"):
                    models.append(model_name)
                    model_types[model_name] = infer_model_type(model_name, {model_name: mtype})

        # 首次出现的模型名自动写入 model_configs（open + 默认倍率），便于计费与列表一致
        auto_models = await db.ensure_default_open_models(models, model_types)
        if auto_models:
            logger.info(
                "[worker/ws] auto-created model_configs (open defaults): %s",
                auto_models,
            )

        # Optional circle scope: worker can declare which circle(s) it contributes to
        circle_ids_raw = msg.get("circle_ids") or []
        if not circle_ids_raw and msg.get("circle_id") is not None:
            circle_ids_raw = [msg.get("circle_id")]
        worker_circle_ids_list: list[int] = []
        for cid_raw in circle_ids_raw:
            try:
                cid = int(cid_raw)
                if await db.is_circle_member(cid, user_id):
                    worker_circle_ids_list.append(cid)
            except (ValueError, TypeError):
                pass
        # 去重并保持顺序
        worker_circle_ids_list = list(dict.fromkeys(worker_circle_ids_list))

        ws_ip = client_ip_from_ws(ws)
        client_ip = resolve_client_ip(ws_ip, msg.get("public_ip"))
        if not client_ip and ws_ip:
            logger.debug(
                "[worker/ws] no public ip peer=%s ws_ip=%s reported=%s",
                peer, ws_ip, msg.get("public_ip"),
            )
        worker = WorkerConnection(
            ws=ws, models=models, worker_id=worker_id,
            name=worker_name, user_id=user_id,
            model_types=model_types,
            agents=normalize_agent_cards(msg.get("agents"), owner_nickname=owner_nickname),
            owner_nickname=owner_nickname,
            caps=[str(c) for c in (msg.get("caps") or []) if c][:16],
            circle_id=worker_circle_ids_list[0] if len(worker_circle_ids_list) == 1 else None,
            circle_ids=worker_circle_ids_list,
            client_ip=client_ip,
        )
        pool.add(worker)

        async def _geo_worker(w: WorkerConnection) -> None:
            geo = await resolve_ip_geo(w.client_ip)
            # 仍无定位时按 worker_id 稳定落点（与虚拟 Agent 同一套城市池）
            if not geo:
                geo = virtual_worker_geo(w.worker_id)
            w.latitude = geo["lat"]
            w.longitude = geo["lng"]
            w.country_code = geo.get("country_code") or ""
            w.city = geo.get("city") or ""

        asyncio.create_task(_geo_worker(worker))
        await ws.send_text(json.dumps({"type": "registered", "worker_id": worker_id}))
        logger.info(
            "[worker/ws] online peer=%s worker_id=%s name=%s user_id=%s models=%s agents=%s",
            peer,
            worker_id,
            worker_name,
            user_id,
            models,
            [a.get("display_name") or a.get("id") for a in worker.agents],
        )

        AUTH_RECHECK_INTERVAL = 300  # 秒：长连接定期复核 worker_key 是否仍有效/仍属该用户
        last_auth_check = time.time()
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)
            kind = msg.get("type")

            # 已认证连接的持续授权复核：防止密钥被吊销/转移后，已建立的 WS 会话仍可无限期操作
            now = time.time()
            if now - last_auth_check > AUTH_RECHECK_INTERVAL:
                current_user = await db.get_user_by_worker_key(worker_key)
                if not current_user or current_user["id"] != user_id:
                    logger.warning(
                        "[worker/ws] deauthorized mid-session peer=%s worker_id=%s user_id=%s",
                        peer, worker_id, user_id,
                    )
                    await ws.close(code=4001, reason="Unauthorized")
                    return
                last_auth_check = now

            # 注册后补齐/刷新智能体名片（客户端先秒回 register，再异步探测 CLI）
            if kind == "agents_update":
                worker.agents = normalize_agent_cards(
                    msg.get("agents"), owner_nickname=getattr(worker, "owner_nickname", None) or "",
                )
                logger.info(
                    "[worker/ws] agents_update worker_id=%s agents=%s",
                    worker.worker_id,
                    [a.get("display_name") or a.get("id") for a in worker.agents],
                )
                continue

            # 武将任务进度：不摘 pending，供 HTTP SSE 转发
            if kind == "agent_task_progress":
                task_id = msg.get("task_id")
                entry = worker.pending_agents.get(task_id) if task_id else None
                if entry and entry.get("queue") is not None:
                    await entry["queue"].put(msg)
                continue

            # 武将任务结果：用 task_id，与模型 req_id 分流
            if kind == "agent_task_result":
                task_id = msg.get("task_id")
                entry = worker.pending_agents.pop(task_id, None) if task_id else None
                if entry:
                    await entry["queue"].put(msg)
                    worker.active_requests = max(0, worker.active_requests - 1)
                continue

            req_id = msg.get("req_id")
            if not req_id or req_id not in worker.pending:
                continue

            entry = worker.pending[req_id]
            q = entry["queue"]
            kind = msg.get("type")

            if kind == "chunk":
                # 首包到达时间 = 首 Token 延迟（TTFT）；非流式单次 body 也在首 chunk 时记一次
                if entry.get("ttft_ms") is None:
                    entry["ttft_ms"] = (time.time() - entry["dispatch_time"]) * 1000
                await q.put(("chunk", msg.get("data", "")))

            elif kind == "image_done":
                images = msg.get("images", [])
                await q.put(("done", images))
                worker.pending.pop(req_id, None)
                worker.active_requests = max(0, worker.active_requests - 1)

            elif kind == "done":
                # 附带 usage，供流式响应结束时扣积分（与 Agent done 消息一致）
                usage_done = msg.get("usage") or {}
                await q.put(("done", usage_done))
                worker.pending.pop(req_id, None)
                worker.active_requests = max(0, worker.active_requests - 1)
                # 周期统计：成功请求用 TTFT；若从未收到 chunk（异常）则用总耗时
                usage = msg.get("usage") or {}
                output_tokens = int(
                    usage.get("completion_tokens") or usage.get("output_tokens") or 0
                )
                ttft_ms = entry.get("ttft_ms")
                if ttft_ms is None:
                    ttft_ms = (time.time() - entry["dispatch_time"]) * 1000
                worker.record_complete(entry["model"], output_tokens, True, ttft_ms)

            elif kind == "error":
                await q.put(("error", msg.get("error", "worker error")))
                worker.pending.pop(req_id, None)
                worker.active_requests = max(0, worker.active_requests - 1)
                # 失败请求不参与首 Token 平均
                worker.record_complete(entry["model"], 0, False, None)

    except WebSocketDisconnect:
        if worker is None:
            logger.info("[worker/ws] disconnected before register peer=%s", peer)
    except asyncio.TimeoutError:
        logger.warning("[worker/ws] registration timeout peer=%s", peer)
        try:
            await ws.close(code=4008, reason="Registration timeout")
        except Exception:
            pass
    except Exception as e:
        logger.error(
            "[worker/ws] error peer=%s worker_id=%s: %s",
            peer,
            worker.worker_id if worker else None,
            e,
        )
        if worker is None:
            try:
                await ws.close(code=1011, reason="Registration failed")
            except Exception:
                pass
    finally:
        if worker:
            pool.remove(worker)
            for entry in worker.pending.values():
                await entry["queue"].put(("error", "worker disconnected"))
            worker.pending.clear()
            for tid, entry in list(worker.pending_agents.items()):
                await entry["queue"].put({
                    "type": "agent_task_result",
                    "task_id": tid,
                    "status": "failed",
                    "error": "worker disconnected",
                })
            worker.pending_agents.clear()
            logger.info(
                "[worker/ws] offline peer=%s worker_id=%s name=%s",
                peer,
                worker.worker_id,
                worker.name,
            )


# ── 网关使用上报 ──────────────────────────────────────────────────────────────

class GatewayUsageReport(BaseModel):
    model: str = ""
    tokens: int = 0
    tier: str = "free"        # free | paid
    provider_id: str = ""


@app.post("/api/gateway/record-usage")
async def gateway_record_usage(
    req: GatewayUsageReport,
    uid: int = Depends(get_current_user_id),
):
    """Gateway reports free/paid-direct calls so they appear in dashboard stats."""
    if req.tokens < 0:
        raise HTTPException(400, "tokens must be >= 0")
    await db.record_gateway_usage(
        user_id=uid,
        model_name=req.model,
        tokens=req.tokens,
        tier=req.tier,
        provider_id=req.provider_id,
    )
    return {"ok": True}


# ── 用户 LLM 接口 ─────────────────────────────────────────────────────────────

async def auth_user(creds: Optional[HTTPAuthorizationCredentials] = Depends(_bearer)):
    """验证用户 API Key，返回 (key_info_dict)"""
    if not creds:
        raise HTTPException(401, "Missing API key")
    info = await db.verify_key(creds.credentials)
    if not info:
        raise HTTPException(401, "Invalid or disabled API key")
    return info


@app.get("/v1/models")
async def list_models(creds: Optional[HTTPAuthorizationCredentials] = Depends(_bearer)):
    # 支持 API Key 或 JWT 两种鉴权方式
    uid: Optional[int] = None
    if creds:
        info = await db.verify_key(creds.credentials)
        if info:
            uid = info.get("user_id")
        else:
            from auth import decode_token
            uid = decode_token(creds.credentials)
    circle_ids = set(await db.get_user_circle_ids(uid)) if uid else set()
    model_types = pool.models_for_user(owner_user_id=uid, user_circle_ids=circle_ids)
    circle_model_map = pool.circle_model_ids_for_user(owner_user_id=uid, user_circle_ids=circle_ids)
    # Build circle_id -> circle_name lookup
    circle_names: dict[int, str] = {}
    for cid in set(circle_model_map.values()):
        c = await db.get_circle_by_id(cid)
        if c:
            circle_names[cid] = c["name"]
    data = []
    for m in sorted(model_types):
        entry = {"id": m, "object": "model", "created": 0, "owned_by": "local",
                 "model_type": model_types.get(m, "chat")}
        cid = circle_model_map.get(m)
        if cid is not None:
            entry["circle_id"]   = cid
            entry["circle_name"] = circle_names.get(cid, "")
        data.append(entry)
    return {"object": "list", "data": data}


def _parse_route_header(request: Request) -> dict:
    """解析客户端网关带外传来的路由指令 X-TB-Route: strategy=auto;sharer=s_a1b2c3。
    社区(p2p)派发的策略/钉分享者靠此头传入，模型名保持裸名转给 worker。"""
    raw = request.headers.get("x-tb-route") or request.headers.get("X-TB-Route") or ""
    out: dict = {"strategy": None, "sharer": None}
    for part in raw.split(";"):
        if "=" not in part:
            continue
        k, v = part.split("=", 1)
        k, v = k.strip().lower(), v.strip()
        if k in out and v:
            out[k] = v
    return out


@app.post("/v1/chat/completions")
async def chat_completions(request: Request, key_info: dict = Depends(auth_user)):
    body = await request.json()
    consumer_user_id: Optional[int] = key_info.get("user_id")
    route = _parse_route_header(request)
    resp = await handle_chat(body, consumer_user_id=consumer_user_id, key_id=key_info.get("id"),
                             strategy=route["strategy"], sharer=route["sharer"])
    # 扣费（含个人源豁免）统一在 dispatch.handle_chat 内完成，避免双重扣费
    return resp


@app.post("/v1/images/generations")
async def image_generations(request: Request, key_info: dict = Depends(auth_user)):
    body = await request.json()
    consumer_user_id: Optional[int] = key_info.get("user_id")
    return await handle_image(body, consumer_user_id=consumer_user_id)


# ── Anthropic Messages API (/v1/messages) ────────────────────────────────────

async def _auth_anthropic(request: Request) -> dict:
    """Accept x-api-key (Anthropic style) or Authorization: Bearer."""
    api_key = request.headers.get("x-api-key") or request.headers.get("X-Api-Key")
    if not api_key:
        auth = request.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            api_key = auth[7:]
    if not api_key:
        raise HTTPException(401, "Missing API key")
    info = await db.verify_key(api_key)
    if not info:
        raise HTTPException(401, "Invalid or disabled API key")
    return info


def _anthropic_to_openai(body: dict) -> dict:
    """Anthropic Messages request → OpenAI Chat Completions request."""
    messages = list(body.get("messages", []))
    if body.get("system"):
        messages = [{"role": "system", "content": body["system"]}] + messages
    oai: dict = {
        "model": body.get("model", ""),
        "messages": messages,
        "stream": body.get("stream", False),
    }
    for key, oai_key in [("max_tokens", "max_tokens"), ("temperature", "temperature"),
                          ("top_p", "top_p")]:
        if key in body:
            oai[oai_key] = body[key]
    if "stop_sequences" in body:
        oai["stop"] = body["stop_sequences"]
    return oai


def _openai_to_anthropic(oai: dict, model: str) -> dict:
    """OpenAI Chat Completions response → Anthropic Messages response."""
    choice = (oai.get("choices") or [{}])[0]
    text = (choice.get("message") or {}).get("content") or ""
    finish = choice.get("finish_reason", "stop")
    stop_reason = "end_turn" if finish in ("stop", None) else finish
    usage = oai.get("usage") or {}
    return {
        "id": oai.get("id", "msg_" + uuid.uuid4().hex[:24]),
        "type": "message",
        "role": "assistant",
        "content": [{"type": "text", "text": text}],
        "model": model,
        "stop_reason": stop_reason,
        "stop_sequence": None,
        "usage": {
            "input_tokens": usage.get("prompt_tokens", 0),
            "output_tokens": usage.get("completion_tokens", 0),
        },
    }


@app.post("/v1/messages")
async def messages(request: Request, key_info: dict = Depends(_auth_anthropic)):
    body = await request.json()
    consumer_user_id: Optional[int] = key_info.get("user_id")
    model = body.get("model", "")
    streaming = body.get("stream", False)

    oai_body = _anthropic_to_openai(body)
    route = _parse_route_header(request)
    resp = await handle_chat(oai_body, consumer_user_id=consumer_user_id, key_id=key_info.get("id"),
                             strategy=route["strategy"], sharer=route["sharer"])

    if streaming:
        msg_id = "msg_" + uuid.uuid4().hex[:24]

        async def anthropic_sse():
            yield (
                f'event: message_start\ndata: {{"type":"message_start","message":{{"id":"{msg_id}",'
                f'"type":"message","role":"assistant","content":[],"model":"{model}",'
                f'"stop_reason":null,"stop_sequence":null,"usage":{{"input_tokens":0,"output_tokens":0}}}}}}\n\n'
            )
            yield 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'
            yield 'event: ping\ndata: {"type":"ping"}\n\n'

            output_tokens = 0
            async for chunk in resp.body_iterator:
                if isinstance(chunk, bytes):
                    chunk = chunk.decode()
                for line in chunk.splitlines():
                    if not line.startswith("data: "):
                        continue
                    data_str = line[6:]
                    if data_str == "[DONE]":
                        continue
                    try:
                        oai_chunk = json.loads(data_str)
                    except Exception:
                        continue
                    delta = (oai_chunk.get("choices") or [{}])[0].get("delta") or {}
                    text = delta.get("content") or ""
                    finish = (oai_chunk.get("choices") or [{}])[0].get("finish_reason")
                    if text:
                        output_tokens += 1
                        yield f'event: content_block_delta\ndata: {{"type":"content_block_delta","index":0,"delta":{{"type":"text_delta","text":{json.dumps(text)}}}}}\n\n'
                    if finish:
                        stop_reason = "end_turn" if finish == "stop" else finish
                        yield f'event: content_block_stop\ndata: {{"type":"content_block_stop","index":0}}\n\n'
                        yield f'event: message_delta\ndata: {{"type":"message_delta","delta":{{"stop_reason":"{stop_reason}","stop_sequence":null}},"usage":{{"output_tokens":{output_tokens}}}}}\n\n'
                        yield 'event: message_stop\ndata: {"type":"message_stop"}\n\n'

        _sh = {"X-Accel-Buffering": "no", "Cache-Control": "no-cache"}
        _wid = resp.headers.get("X-TB-Worker") if hasattr(resp, "headers") else None
        if _wid:
            _sh["X-TB-Worker"] = _wid
        return StreamingResponse(anthropic_sse(), media_type="text/event-stream", headers=_sh)

    # Non-streaming: 扣费已在 dispatch.handle_chat 内完成（含个人源豁免），此处仅转换格式。
    # resp 现为 JSONResponse（带 X-TB-Worker 头）：取出 OpenAI dict 转 Anthropic，并透传 worker 头。
    oai_result = json.loads(resp.body) if isinstance(resp, JSONResponse) else resp
    worker_hdr = resp.headers.get("X-TB-Worker") if isinstance(resp, JSONResponse) else None
    return JSONResponse(
        _openai_to_anthropic(oai_result, model),
        headers={"X-TB-Worker": worker_hdr} if worker_hdr else None,
    )
