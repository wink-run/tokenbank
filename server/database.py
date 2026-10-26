"""PostgreSQL 数据库操作层（全部异步）"""

import hashlib
import json
import logging
import random
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional


from avatar_utils import pick_random_avatar_url
from db_pool import init_pool, close_pool
from pg_compat import connect
logger = logging.getLogger(__name__)


# ── 初始化 & 迁移 ─────────────────────────────────────────────────────────────

async def init_db() -> None:
    await init_pool()
    async with connect() as db:
        # users（须先于引用它的表创建）
        await db.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id                SERIAL PRIMARY KEY,
                email             TEXT UNIQUE NOT NULL,
                nickname          TEXT DEFAULT '',
                password_hash     TEXT NOT NULL,
                credits_balance   REAL DEFAULT 0,
                credits_earned    REAL DEFAULT 0,
                credits_spent     REAL DEFAULT 0,
                referral_code     TEXT UNIQUE NOT NULL,
                referred_by       INTEGER REFERENCES users(id),
                show_on_wall      INTEGER DEFAULT 1,
                wall_display      TEXT DEFAULT 'masked',
                can_create_apikey INTEGER DEFAULT 1,
                worker_key        TEXT UNIQUE,
                created_at        TIMESTAMPTZ DEFAULT NOW()
            )
        """)

        # api_keys
        await db.execute("""
            CREATE TABLE IF NOT EXISTS api_keys (
                id         SERIAL PRIMARY KEY,
                key        TEXT    UNIQUE NOT NULL,
                note       TEXT    DEFAULT '',
                is_active  INTEGER DEFAULT 1,
                user_id    INTEGER REFERENCES users(id),
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        """)

        # model_configs
        await db.execute("""
            CREATE TABLE IF NOT EXISTS model_configs (
                id              SERIAL PRIMARY KEY,
                name            TEXT UNIQUE NOT NULL,
                display_name    TEXT DEFAULT '',
                tier            TEXT NOT NULL DEFAULT 'open',
                contribute_rate REAL NOT NULL DEFAULT 8,
                consume_rate    REAL NOT NULL DEFAULT 5,
                enabled         INTEGER DEFAULT 1,
                created_at      TIMESTAMPTZ DEFAULT NOW()
            )
        """)

        # transactions
        await db.execute("""
            CREATE TABLE IF NOT EXISTS transactions (
                id           SERIAL PRIMARY KEY,
                user_id      INTEGER NOT NULL REFERENCES users(id),
                type         TEXT NOT NULL,
                model_name   TEXT DEFAULT '',
                tokens       INTEGER DEFAULT 0,
                base_credits REAL DEFAULT 0,
                multiplier   REAL DEFAULT 1.0,
                delta        REAL NOT NULL,
                balance      REAL NOT NULL,
                note         TEXT DEFAULT '',
                created_at   TIMESTAMPTZ DEFAULT NOW()
            )
        """)
        # safe migration: add tier column if missing (idempotent)
        try:
            await db.execute("ALTER TABLE transactions ADD COLUMN tier TEXT NOT NULL DEFAULT ''")
            await db.commit()
        except Exception:
            pass  # column already exists

        # settlement_logs
        await db.execute("""
            CREATE TABLE IF NOT EXISTS settlement_logs (
                id              SERIAL PRIMARY KEY,
                worker_id       TEXT NOT NULL,
                user_id         INTEGER REFERENCES users(id),
                period_start    TEXT NOT NULL,
                period_end      TEXT NOT NULL,
                online_mins     REAL DEFAULT 0,
                output_tokens   INTEGER DEFAULT 0,
                avg_latency_ms  REAL DEFAULT 0,
                success_rate    REAL DEFAULT 0,
                multiplier      REAL DEFAULT 1.0,
                credits_awarded REAL DEFAULT 0,
                resources       TEXT DEFAULT '[]',
                created_at      TIMESTAMPTZ DEFAULT NOW()
            )
        """)
        try:
            await db.execute(
                "ALTER TABLE settlement_logs ADD COLUMN resources TEXT DEFAULT '[]'"
            )
            await db.commit()
        except Exception:
            pass

        # purchase_orders
        await db.execute("""
            CREATE TABLE IF NOT EXISTS purchase_orders (
                id             SERIAL PRIMARY KEY,
                user_id        INTEGER NOT NULL REFERENCES users(id),
                amount_credits REAL NOT NULL,
                note           TEXT DEFAULT '',
                status         TEXT DEFAULT 'pending',
                admin_note     TEXT DEFAULT '',
                created_at     TIMESTAMPTZ DEFAULT NOW()
            )
        """)

        # system_config
        await db.execute("""
            CREATE TABLE IF NOT EXISTS system_config (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL DEFAULT ''
            )
        """)

        # checkins
        await db.execute("""
            CREATE TABLE IF NOT EXISTS checkins (
                id         SERIAL PRIMARY KEY,
                user_id    INTEGER NOT NULL REFERENCES users(id),
                date       TEXT NOT NULL,
                credits    REAL NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(user_id, date)
            )
        """)

        # spin_logs
        await db.execute("""
            CREATE TABLE IF NOT EXISTS spin_logs (
                id         SERIAL PRIMARY KEY,
                user_id    INTEGER NOT NULL REFERENCES users(id),
                date       TEXT NOT NULL,
                credits    REAL NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        """)

        # circles
        await db.execute("""
            CREATE TABLE IF NOT EXISTS circles (
                id          SERIAL PRIMARY KEY,
                name        TEXT NOT NULL,
                description TEXT DEFAULT '',
                code        TEXT UNIQUE NOT NULL,
                owner_id    INTEGER NOT NULL REFERENCES users(id),
                max_members INTEGER DEFAULT 100,
                created_at  TIMESTAMPTZ DEFAULT NOW()
            )
        """)

        # circle_members — owner is also inserted here on circle creation
        await db.execute("""
            CREATE TABLE IF NOT EXISTS circle_members (
                circle_id   INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
                user_id     INTEGER NOT NULL REFERENCES users(id),
                joined_at   TIMESTAMPTZ DEFAULT NOW(),
                PRIMARY KEY (circle_id, user_id)
            )
        """)

        await db.execute("""
            CREATE TABLE IF NOT EXISTS circle_announcements (
                id          SERIAL PRIMARY KEY,
                circle_id   INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
                author_id   INTEGER NOT NULL REFERENCES users(id),
                content     TEXT NOT NULL,
                created_at  TIMESTAMPTZ DEFAULT NOW(),
                updated_at  TIMESTAMPTZ DEFAULT NOW()
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS circle_announcement_likes (
                announcement_id INTEGER NOT NULL REFERENCES circle_announcements(id) ON DELETE CASCADE,
                user_id         INTEGER NOT NULL REFERENCES users(id),
                created_at      TIMESTAMPTZ DEFAULT NOW(),
                PRIMARY KEY (announcement_id, user_id)
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS circle_post_replies (
                id          SERIAL PRIMARY KEY,
                post_id     INTEGER NOT NULL REFERENCES circle_announcements(id) ON DELETE CASCADE,
                author_id   INTEGER NOT NULL REFERENCES users(id),
                content     TEXT NOT NULL,
                created_at  TIMESTAMPTZ DEFAULT NOW()
            )
        """)

        # scene_routes
        await db.execute("""
            CREATE TABLE IF NOT EXISTS scene_routes (
                id          SERIAL PRIMARY KEY,
                user_id     INTEGER NOT NULL REFERENCES users(id),
                scene_name  TEXT NOT NULL,
                icon        TEXT DEFAULT '🔀',
                steps       TEXT NOT NULL DEFAULT '[]',
                created_at  TIMESTAMPTZ DEFAULT NOW()
            )
        """)

        # devices
        await db.execute("""
            CREATE TABLE IF NOT EXISTS devices (
                id           TEXT PRIMARY KEY,
                user_id      INTEGER REFERENCES users(id),
                type         TEXT NOT NULL DEFAULT 'desktop',
                name         TEXT NOT NULL DEFAULT '',
                platform     TEXT DEFAULT '',
                version      TEXT DEFAULT '',
                gateway_port INTEGER DEFAULT 11430,
                online       INTEGER DEFAULT 0,
                last_seen    TEXT,
                created_at   TIMESTAMPTZ DEFAULT NOW()
            )
        """)

        # device_stats_snapshots
        await db.execute("""
            CREATE TABLE IF NOT EXISTS device_stats_snapshots (
                id        SERIAL PRIMARY KEY,
                device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
                user_id   INTEGER,
                ts        TIMESTAMPTZ DEFAULT NOW(),
                calls     INTEGER DEFAULT 0,
                errors    INTEGER DEFAULT 0,
                providers INTEGER DEFAULT 0
            )
        """)

        # 忘记密码验证码（短时有效，code_hash 存 SHA-256）
        await db.execute("""
            CREATE TABLE IF NOT EXISTS password_reset_codes (
                id         SERIAL PRIMARY KEY,
                email      TEXT NOT NULL,
                code_hash  TEXT NOT NULL,
                expires_at TIMESTAMPTZ NOT NULL,
                attempts   INTEGER DEFAULT 0,
                used       INTEGER DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        """)
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_pwd_reset_email ON password_reset_codes(email)"
        )

        # 默认配置项
        for k, v in [
            ("referral_reward", "100"),
            ("newcomer_reward", "50"),
            ("contact_info", ""),
            ("checkin_reward", "5"),
            ("spin_daily_limit", "3"),
            ("spin_max_credits", "50"),
            ("circle_invite_reward", "50"),
            # 社区 skill：纳管扣减 / 推荐人奖励（后台可改）
            ("community_skill_install_cost", "8"),
            ("community_skill_recommend_reward", "5"),
        ]:
            await db.execute(
                "INSERT OR IGNORE INTO system_config(key,value) VALUES(?,?)", (k, v)
            )

        await db.commit()

    await _migrate()
    await _migrate_apikey_default_open()
    await _migrate_checkins()
    await _migrate_spin_logs()
    await _migrate_virtual_agents()
    await _migrate_image_support()
    await _migrate_scene_routes()
    await _migrate_devices()
    await _migrate_device_inventory()
    await _migrate_user_billing()
    await _migrate_circles()
    await _migrate_user_avatars()
    await _migrate_user_persona()
    await _migrate_password_reset_codes()
    await _migrate_community_catalog_installs()
    await _migrate_studio()


async def _migrate_password_reset_codes() -> None:
    """早期库补齐忘记密码验证码表。"""
    async with connect() as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS password_reset_codes (
                id         SERIAL PRIMARY KEY,
                email      TEXT NOT NULL,
                code_hash  TEXT NOT NULL,
                expires_at TIMESTAMPTZ NOT NULL,
                attempts   INTEGER DEFAULT 0,
                used       INTEGER DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        """)
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_pwd_reset_email ON password_reset_codes(email)"
        )
        await db.commit()


async def _migrate_community_catalog_installs() -> None:
    """社区 skill 纳管结算记录：同用户同 catalog_id 只扣一次。"""
    async with connect() as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS community_catalog_installs (
                id               SERIAL PRIMARY KEY,
                user_id          INTEGER NOT NULL,
                catalog_id       TEXT NOT NULL,
                recommender_id   INTEGER,
                credits_charged  REAL NOT NULL DEFAULT 0,
                credits_awarded  REAL NOT NULL DEFAULT 0,
                created_at       TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(user_id, catalog_id)
            )
        """)
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_cci_catalog ON community_catalog_installs(catalog_id)"
        )
        # 存量库补齐积分配置键
        for k, v in [
            ("community_skill_install_cost", "8"),
            ("community_skill_recommend_reward", "5"),
        ]:
            await db.execute(
                "INSERT OR IGNORE INTO system_config(key,value) VALUES(?,?)", (k, v)
            )
        await db.commit()


async def _migrate_studio() -> None:
    """社区圈内容：场景(scene) + 插件(mod/设定)，从 coterie 原生搬入。
    owner_id NULL = 官方/预定义（仅管理员改）；插件 content 仅作者/管理员可见（内容保护）。"""
    async with connect() as db:
        # 场景：开箱即用的对话玩法
        await db.execute("""
            CREATE TABLE IF NOT EXISTS studio_scenes (
                id            SERIAL PRIMARY KEY,
                owner_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
                circle_id     INTEGER REFERENCES circles(id) ON DELETE SET NULL,
                is_public     INTEGER NOT NULL DEFAULT 0,
                name          TEXT NOT NULL,
                icon          TEXT DEFAULT '',
                intro         TEXT DEFAULT '',
                category      TEXT DEFAULT '',
                default_model TEXT DEFAULT '',
                persona       TEXT DEFAULT '',
                greeting      TEXT DEFAULT '',
                created_at    TIMESTAMPTZ DEFAULT NOW(),
                updated_at    TIMESTAMPTZ DEFAULT NOW()
            )
        """)
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_studio_scene_circle ON studio_scenes(circle_id)")
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_studio_scene_owner ON studio_scenes(owner_id)")

        # 插件：世界书式设定（type 固定 setting）。intro 公开、content 作者/管理员可见。
        await db.execute("""
            CREATE TABLE IF NOT EXISTS studio_mods (
                id               SERIAL PRIMARY KEY,
                owner_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
                name             TEXT NOT NULL,
                type             TEXT NOT NULL DEFAULT 'setting',
                intro            TEXT DEFAULT '',
                content          TEXT DEFAULT '{}',
                price            INTEGER NOT NULL DEFAULT 0,
                trigger          TEXT NOT NULL DEFAULT 'always',
                trigger_keywords TEXT DEFAULT '',
                created_at       TIMESTAMPTZ DEFAULT NOW()
            )
        """)
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_studio_mod_owner ON studio_mods(owner_id)")

        # 插件分享进圈（多对多；price 可覆盖 mod.price）
        await db.execute("""
            CREATE TABLE IF NOT EXISTS studio_circle_mods (
                circle_id  INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
                mod_id     INTEGER NOT NULL REFERENCES studio_mods(id) ON DELETE CASCADE,
                shared_by  INTEGER REFERENCES users(id),
                price      INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                PRIMARY KEY (circle_id, mod_id)
            )
        """)

        # 购买记录：买家可用不可见
        await db.execute("""
            CREATE TABLE IF NOT EXISTS studio_mod_purchases (
                id         SERIAL PRIMARY KEY,
                user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                mod_id     INTEGER NOT NULL REFERENCES studio_mods(id) ON DELETE CASCADE,
                price      INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(user_id, mod_id)
            )
        """)
        await db.commit()


# ── 社区圈 · 场景 CRUD ────────────────────────────────────────────────────────
# 约定：DB 层返回完整行（含 content/persona/greeting）；由路由层决定是否投影掉私有字段。

def _scene_public(row: dict) -> dict:
    """场景公开视图：去掉 persona/greeting（运行时服务端注入，不下发）。"""
    d = dict(row)
    d.pop("persona", None)
    d.pop("greeting", None)
    return d


async def create_studio_scene(owner_id, data: dict) -> dict:
    async with connect() as db:
        async with db.execute(
            """INSERT INTO studio_scenes
               (owner_id, circle_id, is_public, name, icon, intro, category, default_model, persona, greeting)
               VALUES(?,?,?,?,?,?,?,?,?,?)""",
            (owner_id, data.get("circle_id"), 1 if data.get("is_public") else 0,
             data.get("name", ""), data.get("icon", ""), data.get("intro", ""),
             data.get("category", ""), data.get("default_model", ""),
             data.get("persona", ""), data.get("greeting", "")),
        ) as cur:
            sid = cur.lastrowid
        await db.commit()
        async with db.execute("SELECT * FROM studio_scenes WHERE id=?", (sid,)) as cur:
            return dict(await cur.fetchone())


async def update_studio_scene(scene_id: int, data: dict) -> Optional[dict]:
    fields, params = [], []
    for k in ("circle_id", "name", "icon", "intro", "category", "default_model", "persona", "greeting"):
        if k in data:
            fields.append(f"{k}=?"); params.append(data[k])
    if "is_public" in data:
        fields.append("is_public=?"); params.append(1 if data["is_public"] else 0)
    if not fields:
        return await get_studio_scene(scene_id)
    fields.append("updated_at=NOW()")
    params.append(scene_id)
    async with connect() as db:
        await db.execute(f"UPDATE studio_scenes SET {', '.join(fields)} WHERE id=?", tuple(params))
        await db.commit()
    return await get_studio_scene(scene_id)


async def delete_studio_scene(scene_id: int) -> None:
    async with connect() as db:
        await db.execute("DELETE FROM studio_scenes WHERE id=?", (scene_id,))
        await db.commit()


async def get_studio_scene(scene_id: int) -> Optional[dict]:
    async with connect() as db:
        async with db.execute("SELECT * FROM studio_scenes WHERE id=?", (scene_id,)) as cur:
            row = await cur.fetchone()
            return dict(row) if row else None


async def list_official_scenes() -> list:
    async with connect() as db:
        async with db.execute(
            "SELECT * FROM studio_scenes WHERE owner_id IS NULL ORDER BY id DESC") as cur:
            return [dict(r) async for r in cur]


async def list_scenes_owned(owner_id: int) -> list:
    async with connect() as db:
        async with db.execute(
            "SELECT * FROM studio_scenes WHERE owner_id=? ORDER BY id DESC", (owner_id,)) as cur:
            return [dict(r) async for r in cur]


async def list_circle_scenes(circle_id: int) -> list:
    async with connect() as db:
        async with db.execute(
            "SELECT * FROM studio_scenes WHERE circle_id=? ORDER BY id DESC", (circle_id,)) as cur:
            return [dict(r) async for r in cur]


# ── 社区圈 · 插件 CRUD ────────────────────────────────────────────────────────

def _mod_public(row: dict) -> dict:
    """插件公开视图：去掉 content 原文（作者/管理员之外不可见）。"""
    d = dict(row)
    d.pop("content", None)
    return d


async def create_studio_mod(owner_id, data: dict) -> dict:
    kws = data.get("trigger_keywords") or ""
    if isinstance(kws, (list, tuple)):
        kws = ",".join(str(x) for x in kws)
    content = data.get("content")
    if not isinstance(content, str):
        content = json.dumps(content or {}, ensure_ascii=False)
    async with connect() as db:
        async with db.execute(
            """INSERT INTO studio_mods
               (owner_id, name, type, intro, content, price, trigger, trigger_keywords)
               VALUES(?,?,?,?,?,?,?,?)""",
            (owner_id, data.get("name", ""), data.get("type", "setting"),
             data.get("intro", ""), content, int(data.get("price") or 0),
             data.get("trigger", "always"), kws),
        ) as cur:
            mid = cur.lastrowid
        await db.commit()
        async with db.execute("SELECT * FROM studio_mods WHERE id=?", (mid,)) as cur:
            return dict(await cur.fetchone())


async def update_studio_mod(mod_id: int, data: dict) -> Optional[dict]:
    fields, params = [], []
    for k in ("name", "type", "intro", "trigger"):
        if k in data:
            fields.append(f"{k}=?"); params.append(data[k])
    if "content" in data:
        c = data["content"]
        if not isinstance(c, str):
            c = json.dumps(c or {}, ensure_ascii=False)
        fields.append("content=?"); params.append(c)
    if "price" in data:
        fields.append("price=?"); params.append(int(data["price"] or 0))
    if "trigger_keywords" in data:
        kws = data["trigger_keywords"] or ""
        if isinstance(kws, (list, tuple)):
            kws = ",".join(str(x) for x in kws)
        fields.append("trigger_keywords=?"); params.append(kws)
    if not fields:
        return await get_studio_mod(mod_id)
    params.append(mod_id)
    async with connect() as db:
        await db.execute(f"UPDATE studio_mods SET {', '.join(fields)} WHERE id=?", tuple(params))
        await db.commit()
    return await get_studio_mod(mod_id)


async def delete_studio_mod(mod_id: int) -> None:
    async with connect() as db:
        await db.execute("DELETE FROM studio_mods WHERE id=?", (mod_id,))
        await db.commit()


async def get_studio_mod(mod_id: int) -> Optional[dict]:
    async with connect() as db:
        async with db.execute("SELECT * FROM studio_mods WHERE id=?", (mod_id,)) as cur:
            row = await cur.fetchone()
            return dict(row) if row else None


async def list_official_mods() -> list:
    async with connect() as db:
        async with db.execute(
            "SELECT * FROM studio_mods WHERE owner_id IS NULL ORDER BY id DESC") as cur:
            return [dict(r) async for r in cur]


async def list_mods_owned(owner_id: int) -> list:
    async with connect() as db:
        async with db.execute(
            "SELECT * FROM studio_mods WHERE owner_id=? ORDER BY id DESC", (owner_id,)) as cur:
            return [dict(r) async for r in cur]


async def share_mod_to_circle(circle_id: int, mod_id: int, shared_by: int, price: int) -> None:
    async with connect() as db:
        await db.execute(
            """INSERT INTO studio_circle_mods(circle_id, mod_id, shared_by, price)
               VALUES(?,?,?,?)
               ON CONFLICT(circle_id, mod_id) DO UPDATE SET price=EXCLUDED.price""",
            (circle_id, mod_id, shared_by, int(price or 0)),
        )
        await db.commit()


async def unshare_mod_from_circle(circle_id: int, mod_id: int) -> None:
    async with connect() as db:
        await db.execute(
            "DELETE FROM studio_circle_mods WHERE circle_id=? AND mod_id=?", (circle_id, mod_id))
        await db.commit()


async def list_circle_mods(circle_id: int) -> list:
    """圈内插件：join studio_mods 带出元数据（不含 content），price 取圈内定价。"""
    async with connect() as db:
        async with db.execute(
            """SELECT m.id, m.owner_id, m.name, m.type, m.intro, m.trigger, m.trigger_keywords,
                      cm.price, cm.shared_by, u.nickname AS author
               FROM studio_circle_mods cm
               JOIN studio_mods m ON m.id=cm.mod_id
               LEFT JOIN users u ON u.id=m.owner_id
               WHERE cm.circle_id=?
               ORDER BY cm.created_at DESC""",
            (circle_id,),
        ) as cur:
            return [dict(r) async for r in cur]


async def user_has_purchased_mod(user_id: int, mod_id: int) -> bool:
    async with connect() as db:
        async with db.execute(
            "SELECT 1 FROM studio_mod_purchases WHERE user_id=? AND mod_id=?", (user_id, mod_id)) as cur:
            return (await cur.fetchone()) is not None


async def list_purchased_mod_ids(user_id: int) -> list[int]:
    async with connect() as db:
        async with db.execute(
            "SELECT mod_id FROM studio_mod_purchases WHERE user_id=?", (user_id,)) as cur:
            return [row[0] async for row in cur]


async def record_mod_purchase(user_id: int, mod_id: int, price: int) -> None:
    async with connect() as db:
        await db.execute(
            "INSERT OR IGNORE INTO studio_mod_purchases(user_id, mod_id, price) VALUES(?,?,?)",
            (user_id, mod_id, int(price or 0)),
        )
        await db.commit()


async def get_community_catalog_install(user_id: int, catalog_id: str) -> dict | None:
    async with connect() as db:
        async with db.execute(
            """SELECT user_id, catalog_id, recommender_id, credits_charged, credits_awarded, created_at
               FROM community_catalog_installs WHERE user_id=? AND catalog_id=?""",
            (user_id, catalog_id),
        ) as cur:
            row = await cur.fetchone()
            return dict(row) if row else None


async def record_community_catalog_install(
    *,
    user_id: int,
    catalog_id: str,
    recommender_id: int | None,
    credits_charged: float,
    credits_awarded: float,
) -> None:
    async with connect() as db:
        await db.execute(
            """INSERT INTO community_catalog_installs
               (user_id, catalog_id, recommender_id, credits_charged, credits_awarded)
               VALUES(?,?,?,?,?)
               ON CONFLICT(user_id, catalog_id) DO NOTHING""",
            (user_id, catalog_id, recommender_id, credits_charged, credits_awarded),
        )
        await db.commit()


async def _migrate() -> None:
    """补齐早期 SQLite 库缺失列（仅 api_keys.user_id）"""
    async with connect() as db:
        async with db.execute("PRAGMA table_info(api_keys)") as cur:
            cols = {r[1] for r in await cur.fetchall()}
        if "user_id" not in cols:
            await db.execute("ALTER TABLE api_keys ADD COLUMN user_id INTEGER REFERENCES users(id)")
        await db.commit()


async def _migrate_checkins() -> None:
    """补齐 checkins 表和 checkin_reward 配置（早期数据库无此表）"""
    async with connect() as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS checkins (
                id         SERIAL PRIMARY KEY,
                user_id    INTEGER NOT NULL REFERENCES users(id),
                date       TEXT NOT NULL,
                credits    REAL NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(user_id, date)
            )
        """)
        await db.execute(
            "INSERT OR IGNORE INTO system_config(key,value) VALUES('checkin_reward','5')"
        )
        await db.commit()


async def _migrate_spin_logs() -> None:
    """Add spin_logs table and config keys for databases created before this feature."""
    async with connect() as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS spin_logs (
                id         SERIAL PRIMARY KEY,
                user_id    INTEGER NOT NULL REFERENCES users(id),
                date       TEXT NOT NULL,
                credits    REAL NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        """)
        await db.execute("INSERT OR IGNORE INTO system_config(key,value) VALUES('spin_daily_limit','3')")
        await db.execute("INSERT OR IGNORE INTO system_config(key,value) VALUES('spin_max_credits','50')")
        await db.commit()


async def _migrate_virtual_agents() -> None:
    """补齐 virtual_agents 表和 users.is_virtual 列（早期数据库无此结构）"""
    async with connect() as db:
        async with db.execute("PRAGMA table_info(users)") as cur:
            cols = {r[1] for r in await cur.fetchall()}
        if "is_virtual" not in cols:
            await db.execute("ALTER TABLE users ADD COLUMN is_virtual INTEGER DEFAULT 0")
        await db.execute("""
            CREATE TABLE IF NOT EXISTS virtual_agents (
                id          SERIAL PRIMARY KEY,
                name        TEXT NOT NULL,
                base_url    TEXT NOT NULL,
                api_key     TEXT NOT NULL,
                api_style   TEXT NOT NULL DEFAULT 'openai',
                models      TEXT NOT NULL DEFAULT '[]',
                enabled     INTEGER DEFAULT 1,
                user_id     INTEGER REFERENCES users(id),
                credentials TEXT DEFAULT '',
                owner_user_id INTEGER REFERENCES users(id),
                created_at  TIMESTAMPTZ DEFAULT NOW()
            )
        """)
        # 为旧库补列：credentials（OAuth 凭证 JSON）、owner_user_id（个人供给源归属，NULL=全局）
        async with db.execute("PRAGMA table_info(virtual_agents)") as cur:
            vcols = {r[1] for r in await cur.fetchall()}
        if "credentials" not in vcols:
            await db.execute("ALTER TABLE virtual_agents ADD COLUMN credentials TEXT DEFAULT ''")
        if "owner_user_id" not in vcols:
            await db.execute("ALTER TABLE virtual_agents ADD COLUMN owner_user_id INTEGER")
        await db.commit()


async def _migrate_image_support() -> None:
    """Add model_type column to model_configs and image_tokens_weight system config."""
    async with connect() as db:
        async with db.execute("PRAGMA table_info(model_configs)") as cur:
            cols = {r[1] for r in await cur.fetchall()}
        if "model_type" not in cols:
            await db.execute(
                "ALTER TABLE model_configs ADD COLUMN model_type TEXT NOT NULL DEFAULT 'chat'"
            )
        await db.execute(
            "INSERT OR IGNORE INTO system_config(key,value) VALUES('image_tokens_weight','2000')"
        )
        await db.commit()


async def _migrate_apikey_default_open() -> None:
    """一次性迁移：全体用户默认可自助创建 API Key（无需管理员预先开通）"""
    async with connect() as db:
        async with db.execute(
            "SELECT 1 FROM system_config WHERE key='migrate_selfserve_apikey_v1'"
        ) as cur:
            if await cur.fetchone():
                return
        await db.execute("UPDATE users SET can_create_apikey=1")
        await db.execute(
            "INSERT INTO system_config(key,value) VALUES('migrate_selfserve_apikey_v1','1')"
        )
        await db.commit()


# ── api_keys ──────────────────────────────────────────────────────────────────

async def create_key(note: str, user_id: Optional[int] = None) -> dict:
    key = "sk-" + secrets.token_urlsafe(32)
    async with connect() as db:
        cur = await db.execute(
            "INSERT INTO api_keys (key, note, user_id) VALUES (?,?,?)",
            (key, note, user_id),
        )
        await db.commit()
        return {
            "id": cur.lastrowid,
            "key": key,
            "note": note,
            "is_active": 1,
            "user_id": user_id,
            "created_at": datetime.now().isoformat(timespec="seconds"),
        }


async def list_keys(user_id: Optional[int] = None) -> list[dict]:
    async with connect() as db:
        if user_id is None:
            sql = "SELECT * FROM api_keys ORDER BY created_at DESC"
            args = ()
        else:
            sql = "SELECT * FROM api_keys WHERE user_id=? ORDER BY created_at DESC"
            args = (user_id,)
        async with db.execute(sql, args) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def set_key_active(key_id: int, is_active: bool, user_id: Optional[int] = None) -> None:
    async with connect() as db:
        if user_id is None:
            await db.execute("UPDATE api_keys SET is_active=? WHERE id=?", (int(is_active), key_id))
        else:
            await db.execute(
                "UPDATE api_keys SET is_active=? WHERE id=? AND user_id=?",
                (int(is_active), key_id, user_id),
            )
        await db.commit()


async def delete_key(key_id: int, user_id: Optional[int] = None) -> None:
    async with connect() as db:
        if user_id is None:
            await db.execute("DELETE FROM api_keys WHERE id=?", (key_id,))
        else:
            await db.execute("DELETE FROM api_keys WHERE id=? AND user_id=?", (key_id, user_id))
        await db.commit()


async def verify_key(key: str) -> Optional[dict]:
    """返回 key 记录（含 user_id），无效/禁用返回 None"""
    async with connect() as db:
        async with db.execute(
            "SELECT id, user_id, is_active FROM api_keys WHERE key=?", (key,)
        ) as cur:
            row = await cur.fetchone()
            if row and row["is_active"]:
                return dict(row)
            return None


# ── users ─────────────────────────────────────────────────────────────────────

async def create_user(email: str, nickname: str, password_hash: str, referred_by: Optional[int]) -> dict:
    ref_code = "REF-" + secrets.token_urlsafe(6).upper()
    worker_key = "wk-" + secrets.token_urlsafe(32)
    avatar_url = pick_random_avatar_url()
    async with connect() as db:
        cur = await db.execute(
            """INSERT INTO users
               (email, nickname, password_hash, referral_code, referred_by, worker_key,
                can_create_apikey, avatar_url)
               VALUES (?,?,?,?,?,?,1,?)""",
            (email, nickname, password_hash, ref_code, referred_by, worker_key, avatar_url),
        )
        await db.commit()
        return {"id": cur.lastrowid, "email": email, "nickname": nickname,
                "referral_code": ref_code, "worker_key": worker_key}


async def get_user_by_email(email: str) -> Optional[dict]:
    # 大小写不敏感，便于找回密码时输入
    email_n = (email or "").strip()
    async with connect() as db:
        async with db.execute(
            "SELECT * FROM users WHERE LOWER(email)=LOWER(?)",
            (email_n,),
        ) as cur:
            r = await cur.fetchone()
            return dict(r) if r else None


async def get_user_by_id(user_id: int) -> Optional[dict]:
    async with connect() as db:
        async with db.execute("SELECT * FROM users WHERE id=?", (user_id,)) as cur:
            r = await cur.fetchone()
            return dict(r) if r else None


async def get_user_by_worker_key(worker_key: str) -> Optional[dict]:
    async with connect() as db:
        async with db.execute("SELECT * FROM users WHERE worker_key=?", (worker_key,)) as cur:
            r = await cur.fetchone()
            return dict(r) if r else None


async def get_user_by_referral_code(code: str) -> Optional[dict]:
    async with connect() as db:
        async with db.execute("SELECT * FROM users WHERE referral_code=?", (code,)) as cur:
            r = await cur.fetchone()
            return dict(r) if r else None


async def list_users() -> list[dict]:
    async with connect() as db:
        async with db.execute(
            "SELECT id,email,nickname,credits_balance,credits_earned,credits_spent,"
            "can_create_apikey,referral_code,created_at FROM users ORDER BY created_at DESC"
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def set_user_apikey_permission(user_id: int, can: bool) -> None:
    async with connect() as db:
        await db.execute("UPDATE users SET can_create_apikey=? WHERE id=?", (int(can), user_id))
        await db.commit()


async def set_user_nickname(user_id: int, nickname: str) -> None:
    """管理员修改用户昵称"""
    async with connect() as db:
        await db.execute("UPDATE users SET nickname=? WHERE id=?", (nickname, user_id))
        await db.commit()


async def set_user_password(user_id: int, password_hash: str) -> None:
    """更新用户密码哈希（找回密码 / 管理员重置）"""
    async with connect() as db:
        await db.execute(
            "UPDATE users SET password_hash=? WHERE id=?",
            (password_hash, user_id),
        )
        await db.commit()


# ── 忘记密码验证码 ────────────────────────────────────────────────────────────

def _hash_reset_code(code: str) -> str:
    return hashlib.sha256(code.strip().encode()).hexdigest()


async def create_password_reset_code(email: str, ttl_minutes: int = 15) -> str:
    """作废该邮箱旧码，生成 6 位数字验证码并入库，返回明文 code。"""
    email_n = email.strip().lower()
    code = f"{secrets.randbelow(1_000_000):06d}"
    code_hash = _hash_reset_code(code)
    # asyncpg 要求 TIMESTAMPTZ 传 datetime，不能传 ISO 字符串
    expires = datetime.now(timezone.utc) + timedelta(minutes=ttl_minutes)
    async with connect() as db:
        # 旧码一律作废，避免多码并存
        await db.execute(
            "UPDATE password_reset_codes SET used=1 WHERE email=? AND used=0",
            (email_n,),
        )
        await db.execute(
            "INSERT INTO password_reset_codes(email, code_hash, expires_at) VALUES(?,?,?)",
            (email_n, code_hash, expires),
        )
        await db.commit()
    return code


async def recent_password_reset_count(email: str, within_seconds: int = 60) -> int:
    """统计近期发码次数（用于限流）。"""
    email_n = email.strip().lower()
    since = datetime.now(timezone.utc) - timedelta(seconds=within_seconds)
    async with connect() as db:
        async with db.execute(
            "SELECT COUNT(*) FROM password_reset_codes WHERE email=? AND created_at>=?",
            (email_n, since),
        ) as cur:
            row = await cur.fetchone()
            return int(row[0]) if row else 0


async def consume_password_reset_code(email: str, code: str, max_attempts: int = 5) -> bool:
    """校验验证码；成功则标记已用。过期 / 用尽 / 错误均返回 False。"""
    email_n = email.strip().lower()
    code_hash = _hash_reset_code(code)
    now = datetime.now(timezone.utc)
    async with connect() as db:
        async with db.execute(
            "SELECT id, code_hash, expires_at, attempts, used FROM password_reset_codes "
            "WHERE email=? AND used=0 ORDER BY id DESC LIMIT 1",
            (email_n,),
        ) as cur:
            row = await cur.fetchone()
        if not row:
            return False
        rid = row["id"] if hasattr(row, "keys") else row[0]
        stored = row["code_hash"] if hasattr(row, "keys") else row[1]
        expires_raw = row["expires_at"] if hasattr(row, "keys") else row[2]
        attempts = int(row["attempts"] if hasattr(row, "keys") else row[3])
        used = int(row["used"] if hasattr(row, "keys") else row[4])
        if used:
            return False
        # 兼容字符串 / datetime
        if isinstance(expires_raw, str):
            exp = datetime.fromisoformat(expires_raw.replace("Z", "+00:00"))
        else:
            exp = expires_raw
            if exp.tzinfo is None:
                exp = exp.replace(tzinfo=timezone.utc)
        if exp < now or attempts >= max_attempts:
            await db.execute("UPDATE password_reset_codes SET used=1 WHERE id=?", (rid,))
            await db.commit()
            return False
        if stored != code_hash:
            await db.execute(
                "UPDATE password_reset_codes SET attempts=attempts+1 WHERE id=?",
                (rid,),
            )
            await db.commit()
            return False
        await db.execute(
            "UPDATE password_reset_codes SET used=1 WHERE id=?",
            (rid,),
        )
        await db.commit()
        return True


async def adjust_user_credits(user_id: int, delta: float, note: str = "") -> float:
    """管理员手动调整积分，返回新余额"""
    async with connect() as db:
        async with db.execute("SELECT credits_balance FROM users WHERE id=?", (user_id,)) as cur:
            row = await cur.fetchone()
            if not row:
                raise ValueError("User not found")
            new_balance = row[0] + delta
        # credits_earned 只在充值（delta>=0）时增长，max(delta,0) 已守卫；
        # 不能把 ?>=0 放进 WHERE，否则扣分时整条 UPDATE 被跳过 → 余额没扣但流水照记，账实不符。
        await db.execute(
            "UPDATE users SET credits_balance=?, credits_earned=credits_earned+? WHERE id=?",
            (new_balance, max(delta, 0), user_id),
        )
        if delta < 0:
            await db.execute(
                "UPDATE users SET credits_spent=credits_spent+? WHERE id=?",
                (-delta, user_id),
            )
        await db.execute(
            "INSERT INTO transactions(user_id,type,delta,balance,note) VALUES(?,?,?,?,?)",
            (user_id, "adjust", delta, new_balance, note),
        )
        await db.commit()
        return new_balance


# ── 积分操作 ──────────────────────────────────────────────────────────────────

async def award_credits(user_id: int, delta: float, type_: str,
                        model_name: str = "", tokens: int = 0,
                        base_credits: float = 0, multiplier: float = 1.0,
                        note: str = "") -> float:
    """给用户增加积分，返回新余额"""
    async with connect() as db:
        async with db.execute("SELECT credits_balance FROM users WHERE id=?", (user_id,)) as cur:
            row = await cur.fetchone()
            if not row:
                return 0.0
            new_balance = row[0] + delta
        await db.execute(
            "UPDATE users SET credits_balance=?, credits_earned=credits_earned+? WHERE id=?",
            (new_balance, delta, user_id),
        )
        await db.execute(
            """INSERT INTO transactions
               (user_id,type,model_name,tokens,base_credits,multiplier,delta,balance,note)
               VALUES(?,?,?,?,?,?,?,?,?)""",
            (user_id, type_, model_name, tokens, base_credits, multiplier, delta, new_balance, note),
        )
        await db.commit()
        return new_balance


async def deduct_credits(user_id: int, delta: float, model_name: str = "", tokens: int = 0, tier: str = "p2p") -> tuple[bool, float]:
    """消费积分，余额不足返回 (False, balance)，成功返回 (True, new_balance)"""
    async with connect() as db:
        async with db.execute("SELECT credits_balance FROM users WHERE id=?", (user_id,)) as cur:
            row = await cur.fetchone()
            if not row or row[0] < delta:
                return False, (row[0] if row else 0.0)
            new_balance = row[0] - delta
        await db.execute(
            "UPDATE users SET credits_balance=?, credits_spent=credits_spent+? WHERE id=?",
            (new_balance, delta, user_id),
        )
        await db.execute(
            "INSERT INTO transactions(user_id,type,model_name,tokens,delta,balance,tier) VALUES(?,?,?,?,?,?,?)",
            (user_id, "consume", model_name, tokens, -delta, new_balance, tier),
        )
        await db.commit()
        return True, new_balance


async def record_gateway_usage(user_id: int, model_name: str, tokens: int, tier: str, provider_id: str = "") -> None:
    """Record a zero-cost gateway call (free/paid-direct tier) so it appears in stats."""
    async with connect() as db:
        async with db.execute("SELECT credits_balance FROM users WHERE id=?", (user_id,)) as cur:
            row = await cur.fetchone()
            if not row:
                return
            balance = row[0]
        await db.execute(
            "INSERT INTO transactions(user_id,type,model_name,tokens,delta,balance,tier) VALUES(?,?,?,?,?,?,?)",
            (user_id, "consume", model_name, tokens, 0.0, balance, tier),
        )
        await db.commit()


async def consume_credits_for_usage(
    user_id: int | None, model: str, usage: dict | None
) -> None:
    """按 OpenAI/兼容 usage 与模型消费率扣积分；无 user_id、无 tokens 或费率为 0 时跳过。"""
    if not user_id or not usage:
        return
    u = usage
    total_tokens = int(
        (u.get("prompt_tokens") or u.get("input_tokens") or 0)
        + (u.get("completion_tokens") or u.get("output_tokens") or 0)
    )
    if total_tokens <= 0 and u.get("total_tokens"):
        total_tokens = int(u["total_tokens"])
    if total_tokens <= 0:
        return
    rate = await get_consume_rate(model)
    if rate:
        cost = total_tokens / 1000 * rate
        await deduct_credits(user_id, cost, model_name=model, tokens=total_tokens)


async def get_transactions(user_id: int, limit: int = 50) -> list[dict]:
    async with connect() as db:
        async with db.execute(
            "SELECT * FROM transactions WHERE user_id=? ORDER BY created_at DESC LIMIT ?",
            (user_id, limit),
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


# ── model_configs ─────────────────────────────────────────────────────────────

async def list_model_configs(enabled_only: bool = False) -> list[dict]:
    async with connect() as db:
        sql = "SELECT * FROM model_configs"
        if enabled_only:
            sql += " WHERE enabled=1"
        sql += " ORDER BY tier, name"
        async with db.execute(sql) as cur:
            return [dict(r) for r in await cur.fetchall()]


# Worker 首次上报、后台尚未配置的模型：自动按 open 层默认倍率入库（不覆盖管理员已有配置）
_OPEN_DEFAULT_CONTRIBUTE = 8.0
_OPEN_DEFAULT_CONSUME = 5.0


async def ensure_default_open_models(
    names: list[str], model_types: dict[str, str] | None = None
) -> list[str]:
    """Insert missing model names with open defaults; update model_type if it changed.
    model_types maps name → type ('chat' | 'vision' | 'image' | 'embedding')."""
    if not names:
        return []
    model_types = model_types or {}
    created: list[str] = []
    async with connect() as db:
        for name in names:
            mtype = model_types.get(name, "chat")
            async with db.execute(
                "SELECT model_type FROM model_configs WHERE name=?", (name,)
            ) as cur:
                row = await cur.fetchone()
            if row is None:
                await db.execute(
                    """INSERT INTO model_configs
                       (name,display_name,tier,contribute_rate,consume_rate,enabled,model_type)
                       VALUES(?,?,?,?,?,?,?)""",
                    (name, name, "open", _OPEN_DEFAULT_CONTRIBUTE, _OPEN_DEFAULT_CONSUME, 1, mtype),
                )
                created.append(name)
            elif row[0] != mtype:
                # Worker re-registered with a different type — sync the column
                await db.execute(
                    "UPDATE model_configs SET model_type=? WHERE name=?", (mtype, name)
                )
        await db.commit()
    return created


async def upsert_model_config(
    name: str, display_name: str, tier: str,
    contribute_rate: float, consume_rate: float,
    enabled: bool, model_type: str = "chat"
) -> dict:
    async with connect() as db:
        await db.execute(
            """INSERT INTO model_configs
               (name,display_name,tier,contribute_rate,consume_rate,enabled,model_type)
               VALUES(?,?,?,?,?,?,?)
               ON CONFLICT(name) DO UPDATE SET
                 display_name=excluded.display_name,
                 tier=excluded.tier,
                 contribute_rate=excluded.contribute_rate,
                 consume_rate=excluded.consume_rate,
                 enabled=excluded.enabled,
                 model_type=excluded.model_type""",
            (name, display_name, tier, contribute_rate, consume_rate, int(enabled), model_type),
        )
        await db.commit()
    return {"name": name, "tier": tier, "contribute_rate": contribute_rate,
            "consume_rate": consume_rate, "enabled": enabled, "model_type": model_type}


async def delete_model_config(name: str) -> None:
    async with connect() as db:
        await db.execute("DELETE FROM model_configs WHERE name=?", (name,))
        await db.commit()


async def get_contribute_rate(model_name: str) -> Optional[float]:
    async with connect() as db:
        async with db.execute(
            "SELECT contribute_rate FROM model_configs WHERE name=? AND enabled=1", (model_name,)
        ) as cur:
            row = await cur.fetchone()
            return row[0] if row else None


async def get_consume_rate(model_name: str) -> Optional[float]:
    async with connect() as db:
        async with db.execute(
            "SELECT consume_rate FROM model_configs WHERE name=? AND enabled=1", (model_name,)
        ) as cur:
            row = await cur.fetchone()
            return row[0] if row else None


async def get_or_ensure_consume_rate(
    model_name: str, model_type: str = "chat"
) -> Optional[float]:
    """查询消费率；模型尚未入库时自动写入 open 层默认倍率（不覆盖管理员已有配置）。"""
    rate = await get_consume_rate(model_name)
    if rate is not None:
        return rate
    async with connect() as db:
        async with db.execute(
            "SELECT 1 FROM model_configs WHERE name=?", (model_name,)
        ) as cur:
            if await cur.fetchone():
                return None  # 已存在但被禁用等，尊重管理员配置
    created = await ensure_default_open_models([model_name], {model_name: model_type})
    if created:
        logger.info(
            "auto-created model_configs (open defaults): %s",
            model_name,
        )
    return await get_consume_rate(model_name)


async def get_image_tokens_weight() -> int:
    val = await get_config("image_tokens_weight", "2000")
    try:
        return int(val)
    except ValueError:
        return 2000


# ── settlement_logs ───────────────────────────────────────────────────────────

def _parse_settlement_resources(raw) -> list[str]:
    import json
    if isinstance(raw, list):
        return [str(x).strip() for x in raw if str(x).strip()]
    if not raw:
        return []
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
        if isinstance(data, list):
            return [str(x).strip() for x in data if str(x).strip()]
    except Exception:
        pass
    return []


async def log_settlement(worker_id: str, user_id: int, period_start: str, period_end: str,
                         online_mins: float, output_tokens: int, avg_latency: float,
                         success_rate: float, multiplier: float, credits_awarded: float,
                         resources: Optional[list] = None) -> None:
    """avg_latency 写入 avg_latency_ms 列：语义为首 Token 平均延迟（ms）。
    resources：本周期贡献的模型名或 agent:{id} 列表。"""
    import json
    res_json = json.dumps(
        [str(x).strip() for x in (resources or []) if str(x).strip()],
        ensure_ascii=False,
    )
    async with connect() as db:
        await db.execute(
            """INSERT INTO settlement_logs
               (worker_id,user_id,period_start,period_end,online_mins,output_tokens,
                avg_latency_ms,success_rate,multiplier,credits_awarded,resources)
               VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
            (worker_id, user_id, period_start, period_end, online_mins, output_tokens,
             avg_latency, success_rate, multiplier, credits_awarded, res_json),
        )
        await db.commit()


async def get_settlements(user_id: int, limit: int = 30) -> list[dict]:
    """返回最近结算；resources 仅读库内已存值（写入时由 settler / agent_task 填充）。
    不在读路径做历史回填，避免拖垮 /user/settlements。"""
    async with connect() as db:
        async with db.execute(
            "SELECT * FROM settlement_logs WHERE user_id=? ORDER BY created_at DESC LIMIT ?",
            (user_id, limit),
        ) as cur:
            rows = [dict(r) for r in await cur.fetchall()]
    for r in rows:
        r["resources"] = _parse_settlement_resources(r.get("resources"))
    return rows


async def get_contribute_summary(user_id: int) -> dict:
    """交易页汇总：累计贡献 token、赚取积分及 P2P 使用节省金额。"""
    from credit_pricing import credits_to_cny, cny_per_million_tokens

    async with connect() as db:
        async with db.execute(
            """SELECT COALESCE(SUM(tokens), 0) AS tokens,
                      COALESCE(SUM(delta), 0) AS credits
               FROM transactions WHERE user_id=? AND type='contribute'""",
            (user_id,),
        ) as cur:
            row = await cur.fetchone()
        contrib_tokens = int(row["tokens"] or 0)
        contrib_credits = float(row["credits"] or 0)

        async with db.execute(
            """SELECT model_name,
                      COALESCE(SUM(tokens), 0) AS tokens,
                      COALESCE(SUM(ABS(delta)), 0) AS credits_spent
               FROM transactions
               WHERE user_id=? AND type='consume' AND tier='p2p' AND tokens > 0
               GROUP BY model_name""",
            (user_id,),
        ) as cur:
            p2p_rows = [dict(r) for r in await cur.fetchall()]

    rate_map = {m["name"]: m["consume_rate"] for m in await list_model_configs()}

    p2p_tokens = 0
    p2p_credits_spent = 0.0
    saved_cny = 0.0
    for r in p2p_rows:
        tokens = int(r["tokens"] or 0)
        credits = float(r["credits_spent"] or 0)
        model = r["model_name"] or ""
        cpm = cny_per_million_tokens(rate_map.get(model))
        p2p_tokens += tokens
        p2p_credits_spent += credits
        saved_cny += tokens / 1_000_000 * cpm

    return {
        "contrib_tokens": contrib_tokens,
        "contrib_credits": round(contrib_credits, 2),
        "contrib_cny": round(credits_to_cny(contrib_credits), 4),
        "p2p_tokens": p2p_tokens,
        "p2p_credits_spent": round(p2p_credits_spent, 2),
        "saved_cny": round(saved_cny, 4),
    }


# ── purchase_orders ───────────────────────────────────────────────────────────

async def create_purchase_order(user_id: int, amount_credits: float, note: str) -> dict:
    async with connect() as db:
        cur = await db.execute(
            "INSERT INTO purchase_orders(user_id,amount_credits,note) VALUES(?,?,?)",
            (user_id, amount_credits, note),
        )
        await db.commit()
        return {"id": cur.lastrowid, "user_id": user_id,
                "amount_credits": amount_credits, "note": note, "status": "pending"}


async def list_purchase_orders(status: Optional[str] = None) -> list[dict]:
    async with connect() as db:
        if status:
            sql, args = "SELECT po.*,u.email,u.nickname FROM purchase_orders po JOIN users u ON po.user_id=u.id WHERE po.status=? ORDER BY po.created_at DESC", (status,)
        else:
            sql, args = "SELECT po.*,u.email,u.nickname FROM purchase_orders po JOIN users u ON po.user_id=u.id ORDER BY po.created_at DESC", ()
        async with db.execute(sql, args) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def approve_purchase_order(order_id: int, admin_note: str) -> None:
    async with connect() as db:
        async with db.execute("SELECT * FROM purchase_orders WHERE id=?", (order_id,)) as cur:
            row = await cur.fetchone()
        if row is None:
            raise ValueError("Order not found")
        order = dict(row)
        # 幂等：仅 pending → approved 这一次转换才发积分，防止重复批准重复发分（并发/重复点击）
        cur = await db.execute(
            "UPDATE purchase_orders SET status='approved', admin_note=? WHERE id=? AND status='pending'",
            (admin_note, order_id),
        )
        await db.commit()
        if cur.rowcount == 0:
            return  # 已被批准/拒绝，跳过发分
    await award_credits(
        order["user_id"], order["amount_credits"],
        type_="purchase", note=f"order_id={order_id} {admin_note}",
    )


async def reject_purchase_order(order_id: int, admin_note: str) -> None:
    async with connect() as db:
        await db.execute(
            "UPDATE purchase_orders SET status='rejected', admin_note=? WHERE id=?",
            (admin_note, order_id),
        )
        await db.commit()


async def get_user_purchase_orders(user_id: int) -> list[dict]:
    async with connect() as db:
        async with db.execute(
            "SELECT * FROM purchase_orders WHERE user_id=? ORDER BY created_at DESC",
            (user_id,),
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


# ── system_config ─────────────────────────────────────────────────────────────

async def get_config(key: str, default: str = "") -> str:
    async with connect() as db:
        async with db.execute("SELECT value FROM system_config WHERE key=?", (key,)) as cur:
            row = await cur.fetchone()
            return row[0] if row else default


async def set_config(key: str, value: str) -> None:
    async with connect() as db:
        await db.execute(
            "INSERT INTO system_config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )
        await db.commit()


async def get_all_configs() -> dict:
    async with connect() as db:
        async with db.execute("SELECT key,value FROM system_config") as cur:
            return {r[0]: r[1] for r in await cur.fetchall()}


# ── 鸣谢墙 ────────────────────────────────────────────────────────────────────

# ── 每日签到 ──────────────────────────────────────────────────────────────────

async def do_checkin(user_id: int) -> dict:
    """执行签到：已签到返回 already=True；否则发放积分并记录。"""
    today = datetime.utcnow().strftime("%Y-%m-%d")
    async with connect() as db:
        async with db.execute(
            "SELECT credits FROM checkins WHERE user_id=? AND date=?", (user_id, today)
        ) as cur:
            row = await cur.fetchone()
        if row:
            return {"already": True, "credits": row[0], "date": today}
        reward = float(await get_config("checkin_reward", "5"))
        try:
            await db.execute(
                "INSERT INTO checkins(user_id, date, credits) VALUES(?,?,?)",
                (user_id, today, reward),
            )
            await db.commit()
        except Exception:
            # race condition: another request just inserted — treat as already done
            return {"already": True, "credits": reward, "date": today}
    new_balance = await award_credits(user_id, reward, type_="checkin", note=f"每日签到 {today}")
    return {"already": False, "credits": reward, "new_balance": new_balance, "date": today}


async def get_checkin_status(user_id: int) -> dict:
    today = datetime.utcnow().strftime("%Y-%m-%d")
    reward = float(await get_config("checkin_reward", "5"))
    async with connect() as db:
        async with db.execute(
            "SELECT credits FROM checkins WHERE user_id=? AND date=?", (user_id, today)
        ) as cur:
            row = await cur.fetchone()
        async with db.execute(
            "SELECT COUNT(*) FROM checkins WHERE user_id=?", (user_id,)
        ) as cur:
            total = (await cur.fetchone())[0]
    return {
        "checked_in_today": row is not None,
        "credits_today": row[0] if row else 0,
        "total_checkins": total,
        "reward": reward,
    }


# ── 转盘抽奖 ──────────────────────────────────────────────────────────────

_SPIN_PRIZES  = [1,    3,    5,    15,   25,   50  ]
_SPIN_WEIGHTS = [0.25, 0.25, 0.20, 0.15, 0.10, 0.05]

def _weighted_spin_credits(max_credits: int = 50) -> int:
    """Return a fixed prize value sampled by probability, capped to max_credits."""
    valid = [(v, w) for v, w in zip(_SPIN_PRIZES, _SPIN_WEIGHTS) if v <= max_credits]
    if not valid:
        return 0
    values, weights = zip(*valid)
    total = sum(weights)
    return random.choices(values, weights=[w / total for w in weights], k=1)[0]


async def do_spin(user_id: int) -> dict:
    """Execute one spin. Returns already=True if daily limit reached."""
    today = datetime.utcnow().strftime("%Y-%m-%d")
    daily_limit = int(await get_config("spin_daily_limit", "3"))
    max_credits = int(await get_config("spin_max_credits", "50"))
    async with connect() as db:
        await db.execute("BEGIN IMMEDIATE")
        async with db.execute(
            "SELECT COUNT(*) FROM spin_logs WHERE user_id=? AND date=?", (user_id, today)
        ) as cur:
            spins_used = (await cur.fetchone())[0]
        if spins_used >= daily_limit:
            await db.execute("ROLLBACK")
            return {"already": True, "spins_used": spins_used, "spins_left": 0, "daily_limit": daily_limit}
        credits = _weighted_spin_credits(max_credits)
        await db.execute(
            "INSERT INTO spin_logs(user_id, date, credits) VALUES(?,?,?)",
            (user_id, today, credits),
        )
        await db.commit()
    spins_used += 1
    new_balance = await award_credits(user_id, credits, type_="spin", note=f"转盘抽奖 {today}")
    return {
        "already": False,
        "credits": credits,
        "spins_used": spins_used,
        "spins_left": max(0, daily_limit - spins_used),
        "new_balance": new_balance,
    }


async def get_spin_status(user_id: int) -> dict:
    today = datetime.utcnow().strftime("%Y-%m-%d")
    daily_limit = int(await get_config("spin_daily_limit", "3"))
    async with connect() as db:
        async with db.execute(
            "SELECT COUNT(*) FROM spin_logs WHERE user_id=? AND date=?", (user_id, today)
        ) as cur:
            spins_used = (await cur.fetchone())[0]
    return {
        "spins_used": spins_used,
        "spins_left": max(0, daily_limit - spins_used),
        "daily_limit": daily_limit,
    }


# ── virtual_agents ────────────────────────────────────────────────────────────

def _parse_agent_credentials(row: dict) -> dict:
    """把行里的 credentials 字段还原为 dict（解析失败回退空）。

    单一读入口：将来若启用对称加密（CREDENTIALS_KEY），只需在此解密后再 json.loads。
    """
    import json as _json
    raw = row.get("credentials")
    if not raw:
        return {}
    try:
        val = _json.loads(raw)
        return val if isinstance(val, dict) else {}
    except (ValueError, TypeError):
        return {}


def _dump_agent_credentials(credentials: Optional[dict]) -> str:
    """单一写入口：将 credentials dict 序列化落库。

    将来若启用对称加密（CREDENTIALS_KEY），只需在此 json.dumps 后再加密。
    """
    import json as _json
    return _json.dumps(credentials or {})


async def create_virtual_agent(name: str, base_url: str, api_key: str,
                                api_style: str, models_list: list,
                                enabled: bool = True,
                                credentials: Optional[dict] = None,
                                owner_user_id: Optional[int] = None) -> dict:
    """创建虚拟 Agent，同时创建关联虚拟账户，返回新记录。

    credentials：OAuth 账号凭证（claude_oauth 用），普通 api_key 账号传 None。
    owner_user_id：归属真实用户（个人供给源）；None=全局/管理员。
    """
    import json as _json
    ref_code = "VREF-" + secrets.token_urlsafe(6).upper()
    worker_key = "vwk-" + secrets.token_urlsafe(32)
    virtual_email = f"virtual-{secrets.token_urlsafe(8)}@virtual.local"
    creds_json = _dump_agent_credentials(credentials)
    avatar_url = pick_random_avatar_url()
    async with connect() as db:
        cur = await db.execute(
            """INSERT INTO users
               (email, nickname, password_hash, referral_code, worker_key, is_virtual,
                can_create_apikey, avatar_url)
               VALUES (?,?,?,?,?,1,0,?)""",
            (virtual_email, name, "", ref_code, worker_key, avatar_url),
        )
        virtual_user_id = cur.lastrowid
        models_json = _json.dumps(models_list)
        cur2 = await db.execute(
            """INSERT INTO virtual_agents
               (name, base_url, api_key, api_style, models, enabled, user_id, credentials, owner_user_id)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (name, base_url, api_key, api_style, models_json, int(enabled),
             virtual_user_id, creds_json, owner_user_id),
        )
        await db.commit()
        return {
            "id": cur2.lastrowid, "name": name, "base_url": base_url,
            "api_style": api_style, "models": models_list,
            "enabled": int(enabled), "user_id": virtual_user_id,
            "credentials": credentials or {}, "owner_user_id": owner_user_id,
        }


async def list_virtual_agents(enabled_only: bool = False,
                              owner_user_id: Optional[int] = None,
                              owner_is_null: bool = False) -> list:
    """列出虚拟 Agent。

    owner_user_id 非 None：仅该用户的个人源；owner_is_null=True：仅全局源（管理后台用）。
    """
    import json as _json
    where, args = [], []
    if enabled_only:
        where.append("enabled=1")
    if owner_user_id is not None:
        where.append("owner_user_id=?")
        args.append(owner_user_id)
    elif owner_is_null:
        where.append("owner_user_id IS NULL")
    sql = "SELECT * FROM virtual_agents"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY created_at DESC"
    async with connect() as db:
        async with db.execute(sql, args) as cur:
            rows = [dict(r) for r in await cur.fetchall()]
    for r in rows:
        r["models"] = _json.loads(r["models"] or "[]")
        r["credentials"] = _parse_agent_credentials(r)
    return rows


async def list_virtual_agents_by_owner(owner_user_id: int) -> list:
    """某用户的全部个人供给源（含禁用）。"""
    return await list_virtual_agents(owner_user_id=owner_user_id)


async def get_virtual_agent(agent_id: int) -> Optional[dict]:
    import json as _json
    async with connect() as db:
        async with db.execute("SELECT * FROM virtual_agents WHERE id=?", (agent_id,)) as cur:
            r = await cur.fetchone()
            if not r:
                return None
            row = dict(r)
    row["models"] = _json.loads(row["models"] or "[]")
    row["credentials"] = _parse_agent_credentials(row)
    return row


async def get_virtual_agent_owned(agent_id: int, owner_user_id: int) -> Optional[dict]:
    """按归属取个人供给源；非本人拥有则返回 None（防越权）。"""
    agent = await get_virtual_agent(agent_id)
    if not agent or agent.get("owner_user_id") != owner_user_id:
        return None
    return agent


async def update_virtual_agent(agent_id: int, name: str, base_url: str,
                                api_key: str, api_style: str,
                                models_list: list, enabled: bool,
                                credentials: Optional[dict] = None) -> None:
    """api_key 为空串时不更新密钥字段；credentials 为 None 时不更新凭证字段。"""
    import json as _json
    models_json = _json.dumps(models_list)
    async with connect() as db:
        if api_key:
            await db.execute(
                """UPDATE virtual_agents
                   SET name=?,base_url=?,api_key=?,api_style=?,models=?,enabled=?
                   WHERE id=?""",
                (name, base_url, api_key, api_style, models_json, int(enabled), agent_id),
            )
        else:
            await db.execute(
                """UPDATE virtual_agents
                   SET name=?,base_url=?,api_style=?,models=?,enabled=?
                   WHERE id=?""",
                (name, base_url, api_style, models_json, int(enabled), agent_id),
            )
        if credentials is not None:
            await db.execute(
                "UPDATE virtual_agents SET credentials=? WHERE id=?",
                (_dump_agent_credentials(credentials), agent_id),
            )
        await db.execute(
            "UPDATE users SET nickname=? WHERE id=(SELECT user_id FROM virtual_agents WHERE id=?)",
            (name, agent_id),
        )
        await db.commit()


async def update_virtual_agent_credentials(agent_id: int, credentials: dict) -> None:
    """仅更新 OAuth 凭证（token 刷新后回写，避免触动其它字段）。"""
    async with connect() as db:
        await db.execute(
            "UPDATE virtual_agents SET credentials=? WHERE id=?",
            (_dump_agent_credentials(credentials), agent_id),
        )
        await db.commit()


async def delete_virtual_agent(agent_id: int) -> None:
    """删除虚拟 Agent 记录（保留虚拟用户账户以保留积分历史）。"""
    async with connect() as db:
        await db.execute("DELETE FROM virtual_agents WHERE id=?", (agent_id,))
        await db.commit()


async def _migrate_scene_routes() -> None:
    """Add scene_route_id + app_name to api_keys, and model_key to scene_routes if missing."""
    import uuid as _uuid
    async with connect() as db:
        # api_keys columns
        async with db.execute("PRAGMA table_info(api_keys)") as cur:
            cols = {r[1] for r in await cur.fetchall()}
        if "scene_route_id" not in cols:
            await db.execute(
                "ALTER TABLE api_keys ADD COLUMN scene_route_id INTEGER REFERENCES scene_routes(id)"
            )
        if "app_name" not in cols:
            await db.execute(
                "ALTER TABLE api_keys ADD COLUMN app_name TEXT DEFAULT ''"
            )
        # scene_routes.model_key
        async with db.execute("PRAGMA table_info(scene_routes)") as cur:
            sr_cols = {r[1] for r in await cur.fetchall()}
        if "model_key" not in sr_cols:
            await db.execute(
                "ALTER TABLE scene_routes ADD COLUMN model_key TEXT"
            )
            # backfill existing routes
            async with db.execute("SELECT id FROM scene_routes WHERE model_key IS NULL") as cur:
                rows = await cur.fetchall()
            for (rid,) in rows:
                mkey = "llm-router-" + _uuid.uuid4().hex[:12]
                await db.execute(
                    "UPDATE scene_routes SET model_key=? WHERE id=?", (mkey, rid)
                )
        # scene_routes.caveman_level
        if "caveman_level" not in sr_cols:
            await db.execute(
                "ALTER TABLE scene_routes ADD COLUMN caveman_level TEXT"
            )
        # scene_routes.rules / classifier / flow（存全客户端配置，不丢；JSON 文本）
        for _col in ("rules", "classifier", "flow"):
            if _col not in sr_cols:
                await db.execute(f"ALTER TABLE scene_routes ADD COLUMN {_col} TEXT")
        await db.commit()


# ── Scene Routes ──────────────────────────────────────────────────────────────

async def list_scene_routes(user_id: int) -> list[dict]:
    async with connect() as db:
        async with db.execute(
            "SELECT * FROM scene_routes WHERE user_id=? ORDER BY id", (user_id,)
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


def _dump_json_or_none(v):
    import json as _json
    return _json.dumps(v, ensure_ascii=False) if v else None


async def create_scene_route(user_id: int, scene_name: str, icon: str, steps: list,
                              caveman_level: str | None = None,
                              rules: list | None = None, classifier: dict | None = None,
                              flow: str | None = None) -> dict:
    import json as _json
    import uuid as _uuid
    steps_json = _json.dumps(steps, ensure_ascii=False)
    model_key  = "llm-router-" + _uuid.uuid4().hex[:12]
    async with connect() as db:
        cur = await db.execute(
            "INSERT INTO scene_routes(user_id, scene_name, icon, steps, model_key, caveman_level, rules, classifier, flow) "
            "VALUES(?,?,?,?,?,?,?,?,?)",
            (user_id, scene_name, icon, steps_json, model_key, caveman_level or None,
             _dump_json_or_none(rules), _dump_json_or_none(classifier), flow or None),
        )
        row_id = cur.lastrowid
        await db.commit()
        async with db.execute("SELECT * FROM scene_routes WHERE id=?", (row_id,)) as c:
            row = await c.fetchone()
    return dict(row)


async def update_scene_route(route_id: int, user_id: int, scene_name: str, icon: str, steps: list,
                              caveman_level: str | None = None,
                              rules: list | None = None, classifier: dict | None = None,
                              flow: str | None = None) -> bool:
    import json as _json
    steps_json = _json.dumps(steps, ensure_ascii=False)
    async with connect() as db:
        cur = await db.execute(
            "UPDATE scene_routes SET scene_name=?, icon=?, steps=?, caveman_level=?, rules=?, classifier=?, flow=? "
            "WHERE id=? AND user_id=?",
            (scene_name, icon, steps_json, caveman_level or None,
             _dump_json_or_none(rules), _dump_json_or_none(classifier), flow or None, route_id, user_id),
        )
        await db.commit()
    return cur.rowcount > 0


async def delete_scene_route(route_id: int, user_id: int) -> bool:
    async with connect() as db:
        await db.execute(
            "UPDATE api_keys SET scene_route_id=NULL WHERE scene_route_id=? AND user_id=?",
            (route_id, user_id),
        )
        cur = await db.execute(
            "DELETE FROM scene_routes WHERE id=? AND user_id=?", (route_id, user_id)
        )
        await db.commit()
    return cur.rowcount > 0


async def get_scene_route_by_key(key_id: int) -> Optional[dict]:
    async with connect() as db:
        async with db.execute(
            """SELECT sr.* FROM scene_routes sr
               JOIN api_keys ak ON ak.scene_route_id = sr.id
               WHERE ak.id=?""",
            (key_id,),
        ) as cur:
            row = await cur.fetchone()
    return dict(row) if row else None


async def bind_key_to_scene_route(key_id: int, user_id: int, scene_route_id: Optional[int], app_name: str) -> bool:
    async with connect() as db:
        cur = await db.execute(
            "UPDATE api_keys SET scene_route_id=?, app_name=? WHERE id=? AND user_id=?",
            (scene_route_id, app_name, key_id, user_id),
        )
        await db.commit()
    return cur.rowcount > 0


async def list_keys_with_scene(user_id: int) -> list[dict]:
    async with connect() as db:
        async with db.execute(
            """SELECT ak.id, ak.key, ak.note, ak.app_name, ak.is_active,
                      ak.scene_route_id, sr.scene_name, sr.icon, sr.steps, sr.model_key,
                      ak.created_at
               FROM api_keys ak
               LEFT JOIN scene_routes sr ON sr.id = ak.scene_route_id
               WHERE ak.user_id=?
               ORDER BY ak.id""",
            (user_id,),
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def get_dashboard_stats(user_id: int, days: int = 30) -> list[dict]:
    async with connect() as db:
        async with db.execute(
            """SELECT
                 ak.id        AS key_id,
                 ak.key       AS api_key,
                 ak.app_name,
                 ak.note,
                 sr.scene_name,
                 sr.icon,
                 COALESCE(SUM(t.tokens), 0)       AS total_tokens,
                 COALESCE(SUM(ABS(t.delta)), 0)   AS total_credits,
                 COUNT(t.id)                       AS request_count,
                 COALESCE(SUM(CASE WHEN t.tier='free' THEN 1 ELSE 0 END), 0) AS free_count,
                 COALESCE(SUM(CASE WHEN t.tier='p2p'  THEN 1 ELSE 0 END), 0) AS p2p_count,
                 COALESCE(SUM(CASE WHEN t.tier='paid' THEN 1 ELSE 0 END), 0) AS paid_count
               FROM api_keys ak
               LEFT JOIN scene_routes sr ON sr.id = ak.scene_route_id
               LEFT JOIN transactions t
                 ON t.user_id = ak.user_id
                 AND t.type = 'consume'
                 AND t.created_at >= NOW() - ($1::int * INTERVAL '1 day')
               WHERE ak.user_id = $2
               GROUP BY ak.id
               ORDER BY total_tokens DESC""",
            (days, user_id),
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def get_model_stats(user_id: int, days: int = 30) -> list[dict]:
    """Top models by request count from transactions."""
    async with connect() as db:
        async with db.execute(
            """SELECT model_name,
                      COUNT(*) AS request_count,
                      COALESCE(SUM(tokens), 0) AS total_tokens,
                      COALESCE(SUM(ABS(delta)), 0) AS total_credits
               FROM transactions
               WHERE user_id=$1 AND type='consume'
                 AND model_name != ''
                 AND created_at >= NOW() - ($2::int * INTERVAL '1 day')
               GROUP BY model_name
               ORDER BY request_count DESC
               LIMIT 10""",
            (user_id, days),
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def get_hourly_stats(user_id: int) -> list[int]:
    """Request counts per hour for today (list of 24 ints)."""
    async with connect() as db:
        async with db.execute(
            """SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE current_setting('TIMEZONE'))::int AS hour,
                      COUNT(*) AS cnt
               FROM transactions
               WHERE user_id=$1 AND type='consume'
                 AND (created_at AT TIME ZONE current_setting('TIMEZONE'))::date = CURRENT_DATE
               GROUP BY hour""",
            (user_id,),
        ) as cur:
            rows = await cur.fetchall()
    hourly = [0] * 24
    for r in rows:
        hourly[r["hour"]] = r["cnt"]
    return hourly


async def _migrate_devices() -> None:
    """Add devices and device_stats_snapshots tables for databases created before this feature."""
    async with connect() as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS devices (
                id           TEXT PRIMARY KEY,
                user_id      INTEGER REFERENCES users(id),
                type         TEXT NOT NULL DEFAULT 'desktop',
                name         TEXT NOT NULL DEFAULT '',
                platform     TEXT DEFAULT '',
                version      TEXT DEFAULT '',
                gateway_port INTEGER DEFAULT 11430,
                online       INTEGER DEFAULT 0,
                last_seen    TEXT,
                created_at   TIMESTAMPTZ DEFAULT NOW()
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS device_stats_snapshots (
                id        SERIAL PRIMARY KEY,
                device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
                user_id   INTEGER,
                ts        TIMESTAMPTZ DEFAULT NOW(),
                calls     INTEGER DEFAULT 0,
                errors    INTEGER DEFAULT 0,
                providers INTEGER DEFAULT 0
            )
        """)
        await db.commit()


# ── devices ───────────────────────────────────────────────────────────────────

async def upsert_device(device_id: str, user_id: int, type_: str, name: str,
                        platform: str, version: str, gateway_port: int) -> dict:
    async with connect() as db:
        await db.execute(
            """INSERT INTO devices (id, user_id, type, name, platform, version, gateway_port, online, last_seen)
               VALUES (?,?,?,?,?,?,?,1,datetime('now'))
               ON CONFLICT(id) DO UPDATE SET
                 user_id=excluded.user_id,
                 type=excluded.type,
                 name=excluded.name,
                 platform=excluded.platform,
                 version=excluded.version,
                 gateway_port=excluded.gateway_port,
                 online=1,
                 last_seen=datetime('now')""",
            (device_id, user_id, type_, name, platform, version, gateway_port),
        )
        await db.commit()
        async with db.execute("SELECT * FROM devices WHERE id=?", (device_id,)) as cur:
            row = await cur.fetchone()
            return dict(row) if row else {}


async def _migrate_device_inventory() -> None:
    """devices.inventory_json：各端上报的盘点快照（按 1/7/30 天）。"""
    async with connect() as db:
        async with db.execute("PRAGMA table_info(devices)") as cur:
            cols = {r[1] for r in await cur.fetchall()}
        if "inventory_json" not in cols:
            await db.execute(
                "ALTER TABLE devices ADD COLUMN inventory_json TEXT NOT NULL DEFAULT '{}'"
            )
        await db.commit()


def _empty_inventory() -> dict:
    return {
        "total_calls": 0, "total_tokens": 0, "total_cost": 0,
        "tiers": {"free": 0, "p2p": 0, "paid": 0},
        "hourly": [0] * 24,
        "models": [], "providers": [], "agent_sources": [], "devices": [],
        "compression": {"count": 0, "before": 0, "after": 0, "saved": 0, "ratio": 0, "saved_usd": 0},
    }


def _empty_period_snap() -> dict:
    """单设备、单时间窗口的空盘点（用于尚未上报该窗口数据的设备）。"""
    return {
        "total_calls": 0, "total_tokens": 0, "total_cost": 0,
        "tiers": {"free": 0, "p2p": 0, "paid": 0},
        "hourly": [0] * 24,
        "models": [], "providers": [], "agent_sources": [], "app_usage": [],
        "compression": {"count": 0, "before": 0, "after": 0, "saved": 0, "ratio": 0, "saved_usd": 0},
    }


def _hourly_calls(v, index: int = 0) -> int:
    """hourly 槽位：旧格式为 int，新格式为 {hour, calls, tokens, ...}。"""
    if isinstance(v, dict):
        return int(v.get("calls") or 0)
    if isinstance(v, (int, float)):
        return int(v)
    return 0


def _merge_hourly_into(target: list, hourly: list) -> None:
    """合并单设备 hourly 到 24 位 calls 数组。"""
    if not isinstance(hourly, list):
        return
    for i, v in enumerate(hourly[:24]):
        if isinstance(v, dict):
            idx = int(v.get("hour", i))
            if 0 <= idx < 24:
                target[idx] += _hourly_calls(v, idx)
        elif isinstance(v, (int, float)):
            target[i] += int(v)


def _merge_inventory_list(rows_list: list, key_field: str) -> list:
    """合并多设备同名维度（provider/model/source）。"""
    acc: dict = {}
    for rows in rows_list:
        for r in rows or []:
            k = r.get(key_field)
            if not k:
                continue
            if k not in acc:
                acc[k] = dict(r)
            else:
                acc[k]["calls"] = acc[k].get("calls", 0) + (r.get("calls") or 0)
                acc[k]["tokens"] = acc[k].get("tokens", 0) + (r.get("tokens") or 0)
                if "cost_usd" in r or "cost_usd" in acc[k]:
                    acc[k]["cost_usd"] = (acc[k].get("cost_usd") or 0) + (r.get("cost_usd") or 0)
    return sorted(acc.values(), key=lambda x: x.get("calls", 0), reverse=True)


def _merge_app_usage(rows_list: list) -> list:
    """合并多设备按应用聚合的用量（app_usage）。"""
    acc: dict = {}
    for rows in rows_list:
        for r in rows or []:
            k = r.get("id") or r.get("name")
            if not k:
                continue
            if k not in acc:
                acc[k] = dict(r)
            else:
                for field in ("calls", "tokens", "proxyCalls", "sessionCalls"):
                    acc[k][field] = acc[k].get(field, 0) + (r.get(field) or 0)
    return sorted(acc.values(), key=lambda x: x.get("calls", 0), reverse=True)


def merge_device_inventories(device_rows: list, days: int) -> dict:
    """将各设备上报的盘点 JSON 按时间范围合并为用户总览。"""
    import json as _json

    key = str(days)
    merged = _empty_inventory()
    provider_rows, model_rows, agent_rows, app_usage_rows = [], [], [], []

    for dev in device_rows:
        raw = dev.get("inventory_json") or "{}"
        try:
            inv_all = _json.loads(raw) if isinstance(raw, str) else (raw or {})
        except (ValueError, TypeError):
            inv_all = {}
        # 无该窗口快照仍展示设备（用量为 0），避免多设备只显示有数据的一台
        snap = inv_all.get(key) or inv_all.get(str(days)) or _empty_period_snap()

        merged["total_calls"] += int(snap.get("total_calls") or 0)
        merged["total_tokens"] += int(snap.get("total_tokens") or 0)
        merged["total_cost"] += float(snap.get("total_cost") or 0)

        tiers = snap.get("tiers") or {}
        for t in ("free", "p2p", "paid"):
            merged["tiers"][t] += int(tiers.get(t) or 0)

        if days == 1:
            _merge_hourly_into(merged["hourly"], snap.get("hourly") or [])

        comp = snap.get("compression") or {}
        merged["compression"]["count"] += int(comp.get("count") or 0)
        merged["compression"]["before"] += int(comp.get("before") or 0)
        merged["compression"]["after"] += int(comp.get("after") or 0)
        merged["compression"]["saved_usd"] += float(comp.get("saved_usd") or 0)

        provider_rows.append(snap.get("providers") or [])
        model_rows.append(snap.get("models") or [])
        agent_rows.append(snap.get("agent_sources") or [])
        app_usage_rows.append(snap.get("app_usage") or [])

        dev_tiers = {t: int((tiers or {}).get(t) or 0) for t in ("free", "p2p", "paid")}
        dev_models = sorted(snap.get("models") or [], key=lambda x: x.get("calls", 0), reverse=True)
        dev_sources = sorted(snap.get("agent_sources") or [], key=lambda x: x.get("calls", 0), reverse=True)
        dev_providers = sorted(snap.get("providers") or [], key=lambda x: x.get("calls", 0), reverse=True)
        dev_app_usage = sorted(snap.get("app_usage") or [], key=lambda x: x.get("calls", 0), reverse=True)

        merged["devices"].append({
            "device_id": dev.get("id"),
            "name": dev.get("name") or dev.get("id"),
            "type": dev.get("type"),
            "platform": dev.get("platform"),
            "version": dev.get("version") or "",
            "online": bool(dev.get("online")),
            "calls": int(snap.get("total_calls") or 0),
            "tokens": int(snap.get("total_tokens") or 0),
            "cost": float(snap.get("total_cost") or 0),
            "tiers": dev_tiers,
            "providers_count": len(snap.get("providers") or []),
            "top_models": dev_models[:3],
            "top_sources": dev_sources[:3],
            "top_providers": dev_providers[:3],
            # 完整列表供分布图按端筛选
            "agent_sources": snap.get("agent_sources") or [],
            "app_usage": dev_app_usage,
            "providers": dev_providers,
            "models": dev_models,
            # 各端登记的订阅/供给源摘要（无凭证）
            "accounts_summary": snap.get("accounts_summary") or {},
            # 各端账户配置快照（无 Key），供其他终端「点击同步」合并
            "accounts_config": snap.get("accounts_config") if isinstance(snap.get("accounts_config"), dict) else {},
        })

    merged["devices"].sort(key=lambda d: d.get("calls", 0), reverse=True)
    total_calls = merged["total_calls"] or 0
    for d in merged["devices"]:
        d["share_pct"] = round(d["calls"] / total_calls * 100) if total_calls > 0 else 0
    merged["providers"] = _merge_inventory_list(provider_rows, "id")
    merged["models"] = _merge_inventory_list(model_rows, "model")
    merged["agent_sources"] = _merge_inventory_list(agent_rows, "source")
    merged["app_usage"] = _merge_app_usage(app_usage_rows)
    _c = merged["compression"]
    _c["saved"] = _c["before"] - _c["after"]
    _c["ratio"] = round((_c["before"] - _c["after"]) / _c["before"], 4) if _c["before"] > 0 else 0
    return merged


async def update_device_inventory(device_id: str, user_id: int, inventory: dict) -> None:
    """合并写入设备盘点快照（键：1 / 7 / 30）。"""
    import json as _json

    if not inventory:
        return
    async with connect() as db:
        async with db.execute(
            "SELECT inventory_json FROM devices WHERE id=? AND user_id=?",
            (device_id, user_id),
        ) as cur:
            row = await cur.fetchone()
        existing: dict = {}
        if row and row[0]:
            try:
                existing = _json.loads(row[0])
            except (ValueError, TypeError):
                existing = {}
        for k, v in inventory.items():
            if v is not None:
                # 部分心跳只上报用量、不含账户字段，保留已有摘要/配置避免被空覆盖。
                # accounts_config 仅在字段缺失时保留（旧客户端）；显式带上则用新值。
                if isinstance(v, dict):
                    prev = existing.get(str(k))
                    if isinstance(prev, dict) and prev.get("accounts_summary") and not v.get("accounts_summary"):
                        v = {**v, "accounts_summary": prev["accounts_summary"]}
                    if isinstance(prev, dict) and prev.get("accounts_config") and "accounts_config" not in v:
                        v = {**v, "accounts_config": prev["accounts_config"]}
                existing[str(k)] = v
        await db.execute(
            "UPDATE devices SET inventory_json=? WHERE id=? AND user_id=?",
            (_json.dumps(existing, ensure_ascii=False), device_id, user_id),
        )
        await db.commit()


async def get_user_inventory_stats(user_id: int, days: int = 1) -> dict:
    """汇总用户所有设备上报的盘点数据。"""
    async with connect() as db:
        async with db.execute(
            "SELECT * FROM devices WHERE user_id=? ORDER BY created_at DESC",
            (user_id,),
        ) as cur:
            rows = [dict(r) for r in await cur.fetchall()]
    out = merge_device_inventories(rows, days)
    out["days"] = days
    # 已注册设备总数（含尚未上报盘点快照的设备）
    out["device_count"] = len(rows)
    return out


async def record_device_heartbeat(device_id: str, user_id: int, online: bool,
                                   calls: int, errors: int, providers: int,
                                   inventory: dict | None = None,
                                   version: str = "", name: str = "",
                                   platform: str = "", type_: str = "") -> None:
    async with connect() as db:
        updates = ["online=?", "last_seen=datetime('now')"]
        params: list = [1 if online else 0]
        if version:
            updates.append("version=?")
            params.append(version)
        if name:
            updates.append("name=?")
            params.append(name)
        if platform:
            updates.append("platform=?")
            params.append(platform)
        if type_ in ("desktop", "cli"):
            updates.append("type=?")
            params.append(type_)
        params.append(device_id)
        await db.execute(
            f"UPDATE devices SET {', '.join(updates)} WHERE id=?",
            params,
        )
        await db.execute(
            """INSERT INTO device_stats_snapshots (device_id, user_id, calls, errors, providers)
               VALUES (?,?,?,?,?)""",
            (device_id, user_id, calls, errors, providers),
        )
        await db.commit()
    if inventory:
        await update_device_inventory(device_id, user_id, inventory)


async def get_user_devices(user_id: int) -> list[dict]:
    async with connect() as db:
        async with db.execute(
            "SELECT * FROM devices WHERE user_id=? ORDER BY created_at DESC", (user_id,)
        ) as cur:
            devices = [dict(r) for r in await cur.fetchall()]
        for dev in devices:
            # 每次心跳上报的 calls 是“今日累计总数”（非增量），故取最近一条快照即可，
            # 不能 SUM——否则把同一累计值重复相加，数字会随心跳次数无限膨胀。
            async with db.execute(
                """SELECT calls, errors, providers
                   FROM device_stats_snapshots
                   WHERE device_id=? AND ts >= datetime('now', '-24 hours')
                   ORDER BY ts DESC LIMIT 1""",
                (dev["id"],),
            ) as cur:
                snap = await cur.fetchone()
            dev["today_calls"] = snap["calls"] if snap and snap["calls"] is not None else 0
            dev["today_errors"] = snap["errors"] if snap and snap["errors"] is not None else 0
            dev["today_providers"] = snap["providers"] if snap and snap["providers"] is not None else 0
    return devices


async def get_device_owner(device_id: str) -> Optional[int]:
    """Return the user_id that owns device_id, or None if not found."""
    async with connect() as db:
        async with db.execute(
            "SELECT user_id FROM devices WHERE id=?", (device_id,)
        ) as cur:
            row = await cur.fetchone()
            return row[0] if row else None


async def delete_device(device_id: str, user_id: int) -> None:
    async with connect() as db:
        await db.execute(
            "DELETE FROM devices WHERE id=? AND user_id=?", (device_id, user_id)
        )
        await db.commit()


async def sweep_offline_devices() -> int:
    async with connect() as db:
        cur = await db.execute(
            # last_seen 为 TEXT，比较前需显式转为 TIMESTAMPTZ
            "UPDATE devices SET online=0 WHERE online=1 AND last_seen::TIMESTAMPTZ < datetime('now', '-2 minutes')"
        )
        await db.commit()
        return cur.rowcount


# ── 个人页账户配置（跨终端同步）────────────────────────────────────────────────

USER_BILLING_KEYS = (
    "user_subscriptions",
    "user_payg_providers",
    "provider_pricing_overrides",
    "subscription_plans",
)


def _empty_user_billing() -> dict:
    return {
        "user_subscriptions": [],
        "user_payg_providers": [],
        "provider_pricing_overrides": {},
        "subscription_plans": {},
    }


def _normalize_user_billing(raw: dict | None) -> dict:
    """归一化用户计费配置 JSON。"""
    import json as _json
    base = _empty_user_billing()
    if not raw:
        return base
    if isinstance(raw, str):
        try:
            raw = _json.loads(raw)
        except (ValueError, TypeError):
            return base
    if not isinstance(raw, dict):
        return base
    if isinstance(raw.get("user_subscriptions"), list):
        base["user_subscriptions"] = raw["user_subscriptions"]
    if isinstance(raw.get("user_payg_providers"), list):
        base["user_payg_providers"] = raw["user_payg_providers"]
    if isinstance(raw.get("provider_pricing_overrides"), dict):
        base["provider_pricing_overrides"] = raw["provider_pricing_overrides"]
    if isinstance(raw.get("subscription_plans"), dict):
        base["subscription_plans"] = raw["subscription_plans"]
    return base


async def _migrate_user_billing() -> None:
    """users.billing_json：个人页订阅 / 按量 provider / 刊例价覆盖。"""
    async with connect() as db:
        async with db.execute("PRAGMA table_info(users)") as cur:
            cols = {r[1] for r in await cur.fetchall()}
        if "billing_json" not in cols:
            await db.execute(
                "ALTER TABLE users ADD COLUMN billing_json TEXT NOT NULL DEFAULT '{}'"
            )
        await db.commit()


async def _migrate_user_avatars() -> None:
    """users.avatar_url：注册时随机分配 server/avatar 目录中的头像。"""
    async with connect() as db:
        async with db.execute("PRAGMA table_info(users)") as cur:
            cols = {r[1] for r in await cur.fetchall()}
        if "avatar_url" not in cols:
            await db.execute(
                "ALTER TABLE users ADD COLUMN avatar_url TEXT NOT NULL DEFAULT ''"
            )
        await db.commit()

    # 为历史用户补随机头像
    async with connect() as db:
        async with db.execute(
            "SELECT id FROM users WHERE avatar_url IS NULL OR avatar_url=''"
        ) as cur:
            rows = await cur.fetchall()
        for row in rows:
            url = pick_random_avatar_url()
            if url:
                await db.execute(
                    "UPDATE users SET avatar_url=? WHERE id=?",
                    (url, row["id"]),
                )
        await db.commit()


async def _migrate_user_persona() -> None:
    """users.persona：一句话画像，公开贡献者主页展示。"""
    async with connect() as db:
        async with db.execute("PRAGMA table_info(users)") as cur:
            cols = {r[1] for r in await cur.fetchall()}
        if "persona" not in cols:
            await db.execute(
                "ALTER TABLE users ADD COLUMN persona TEXT NOT NULL DEFAULT ''"
            )
        await db.commit()


async def set_user_persona(user_id: int, persona: str) -> None:
    """更新一句话画像；空串表示清除。最长 300 字。"""
    text = (persona or "").strip()
    if len(text) > 300:
        text = text[:300]
    async with connect() as db:
        await db.execute("UPDATE users SET persona=? WHERE id=?", (text, user_id))
        await db.commit()


async def get_user_billing(user_id: int) -> dict:
    import json as _json
    async with connect() as db:
        async with db.execute(
            "SELECT billing_json FROM users WHERE id=?", (user_id,)
        ) as cur:
            row = await cur.fetchone()
    if not row:
        return _empty_user_billing()
    return _normalize_user_billing(row[0])


async def set_user_billing(user_id: int, patch: dict) -> dict:
    """合并更新用户计费配置并返回完整快照。"""
    import json as _json
    current = await get_user_billing(user_id)
    for key in USER_BILLING_KEYS:
        if key in patch and patch[key] is not None:
            current[key] = patch[key]
    payload = _json.dumps(current, ensure_ascii=False)
    async with connect() as db:
        await db.execute(
            "UPDATE users SET billing_json=? WHERE id=?", (payload, user_id)
        )
        await db.commit()
    return current


async def get_wall_users(limit: int = 50) -> list[dict]:
    async with connect() as db:
        async with db.execute(
            """SELECT u.id, u.nickname, u.wall_display, u.credits_earned,
                      (SELECT COUNT(*) FROM users r WHERE r.referred_by=u.id) AS referral_count,
                      (CURRENT_DATE - u.created_at::date) AS days_online
               FROM users u
               WHERE u.show_on_wall=1 AND u.wall_display != 'hidden'
               ORDER BY (u.credits_earned*0.5 + (SELECT COUNT(*) FROM users r WHERE r.referred_by=u.id)*0.3 + (CURRENT_DATE - u.created_at::date)*0.2) DESC
               LIMIT $1""",
            (limit,),
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def _migrate_circles() -> None:
    """Add circle_id to virtual_agents; create circles/circle_members if not present (for old DBs)."""
    async with connect() as db:
        # Enable FK support for cascade to work at migration time
        await db.execute("PRAGMA foreign_keys = ON")
        await db.execute("""
            CREATE TABLE IF NOT EXISTS circles (
                id          SERIAL PRIMARY KEY,
                name        TEXT NOT NULL,
                description TEXT DEFAULT '',
                code        TEXT UNIQUE NOT NULL,
                owner_id    INTEGER NOT NULL REFERENCES users(id),
                max_members INTEGER DEFAULT 100,
                created_at  TIMESTAMPTZ DEFAULT NOW()
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS circle_members (
                circle_id   INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
                user_id     INTEGER NOT NULL REFERENCES users(id),
                joined_at   TIMESTAMPTZ DEFAULT NOW(),
                PRIMARY KEY (circle_id, user_id)
            )
        """)
        async with db.execute("PRAGMA table_info(virtual_agents)") as cur:
            cols = {row[1] async for row in cur}
        if "circle_id" not in cols:
            await db.execute("ALTER TABLE virtual_agents ADD COLUMN circle_id INTEGER REFERENCES circles(id)")
        await db.execute(
            "INSERT OR IGNORE INTO system_config(key,value) VALUES('circle_invite_reward','50')"
        )
        await db.execute("""
            CREATE TABLE IF NOT EXISTS circle_announcements (
                id          SERIAL PRIMARY KEY,
                circle_id   INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
                author_id   INTEGER NOT NULL REFERENCES users(id),
                content     TEXT NOT NULL,
                created_at  TIMESTAMPTZ DEFAULT NOW(),
                updated_at  TIMESTAMPTZ DEFAULT NOW()
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS circle_announcement_likes (
                announcement_id INTEGER NOT NULL REFERENCES circle_announcements(id) ON DELETE CASCADE,
                user_id         INTEGER NOT NULL REFERENCES users(id),
                created_at      TIMESTAMPTZ DEFAULT NOW(),
                PRIMARY KEY (announcement_id, user_id)
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS circle_post_replies (
                id          SERIAL PRIMARY KEY,
                post_id     INTEGER NOT NULL REFERENCES circle_announcements(id) ON DELETE CASCADE,
                author_id   INTEGER NOT NULL REFERENCES users(id),
                content     TEXT NOT NULL,
                created_at  TIMESTAMPTZ DEFAULT NOW()
            )
        """)
        # 公开浏览 + 入圈申请
        async with db.execute("PRAGMA table_info(circles)") as cur:
            circle_cols = {row[1] async for row in cur}
        if "is_public" not in circle_cols:
            await db.execute("ALTER TABLE circles ADD COLUMN is_public INTEGER DEFAULT 1")
        await db.execute("""
            CREATE TABLE IF NOT EXISTS circle_join_requests (
                id          SERIAL PRIMARY KEY,
                circle_id   INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
                user_id     INTEGER NOT NULL REFERENCES users(id),
                message     TEXT DEFAULT '',
                status      TEXT NOT NULL DEFAULT 'pending',
                created_at  TIMESTAMPTZ DEFAULT NOW(),
                updated_at  TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(circle_id, user_id)
            )
        """)
        await db.commit()


# ── circles ───────────────────────────────────────────────────────────────────

def _gen_circle_code() -> str:
    import string
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(8))


async def create_circle(owner_id: int, name: str, description: str = "") -> dict:
    code = _gen_circle_code()
    async with connect() as db:
        await db.execute("PRAGMA foreign_keys = ON")
        # Retry on code collision (astronomically unlikely)
        for _ in range(5):
            try:
                async with db.execute(
                    "INSERT INTO circles(name,description,code,owner_id,is_public) VALUES(?,?,?,?,1)",
                    (name, description, code, owner_id),
                ) as cur:
                    circle_id = cur.lastrowid
                break
            except Exception:
                code = _gen_circle_code()
        else:
            raise RuntimeError("Failed to generate unique circle code")
        # Owner is also a member
        await db.execute(
            "INSERT OR IGNORE INTO circle_members(circle_id,user_id) VALUES(?,?)",
            (circle_id, owner_id),
        )
        await db.commit()
        async with db.execute("SELECT * FROM circles WHERE id=?", (circle_id,)) as cur:
            row = await cur.fetchone()
            return dict(row)


async def get_circle_by_code(code: str) -> Optional[dict]:
    async with connect() as db:
        async with db.execute("SELECT * FROM circles WHERE code=?", (code,)) as cur:
            row = await cur.fetchone()
            return dict(row) if row else None


async def get_circle_by_id(circle_id: int) -> Optional[dict]:
    async with connect() as db:
        async with db.execute("SELECT * FROM circles WHERE id=?", (circle_id,)) as cur:
            row = await cur.fetchone()
            return dict(row) if row else None


async def list_circles_owned(owner_id: int) -> list:
    async with connect() as db:
        async with db.execute(
            "SELECT * FROM circles WHERE owner_id=? ORDER BY created_at DESC", (owner_id,)
        ) as cur:
            return [dict(r) async for r in cur]


async def list_circles_joined(user_id: int) -> list:
    """All circles the user belongs to (including owned)."""
    async with connect() as db:
        async with db.execute(
            """SELECT c.* FROM circles c
               JOIN circle_members m ON m.circle_id=c.id
               WHERE m.user_id=?
               ORDER BY m.joined_at DESC""",
            (user_id,),
        ) as cur:
            return [dict(r) async for r in cur]


async def get_user_circle_ids(user_id: int) -> list[int]:
    """Return list of circle IDs the user belongs to (for dispatch visibility)."""
    async with connect() as db:
        async with db.execute(
            "SELECT circle_id FROM circle_members WHERE user_id=?", (user_id,)
        ) as cur:
            return [row[0] async for row in cur]


async def circle_member_count(circle_id: int) -> int:
    async with connect() as db:
        async with db.execute(
            "SELECT COUNT(*) FROM circle_members WHERE circle_id=?", (circle_id,)
        ) as cur:
            row = await cur.fetchone()
            return row[0] if row else 0


async def is_circle_member(circle_id: int, user_id: int) -> bool:
    async with connect() as db:
        async with db.execute(
            "SELECT 1 FROM circle_members WHERE circle_id=? AND user_id=?", (circle_id, user_id)
        ) as cur:
            return (await cur.fetchone()) is not None


async def add_circle_member(circle_id: int, user_id: int) -> None:
    async with connect() as db:
        await db.execute(
            "INSERT OR IGNORE INTO circle_members(circle_id,user_id) VALUES(?,?)",
            (circle_id, user_id),
        )
        await db.commit()


async def remove_circle_member(circle_id: int, user_id: int) -> None:
    async with connect() as db:
        await db.execute(
            "DELETE FROM circle_members WHERE circle_id=? AND user_id=?", (circle_id, user_id)
        )
        await db.commit()


async def delete_circle(circle_id: int) -> None:
    async with connect() as db:
        await db.execute("PRAGMA foreign_keys = ON")
        # Detach virtual_agents from this circle first
        await db.execute(
            "UPDATE virtual_agents SET circle_id=NULL WHERE circle_id=?", (circle_id,)
        )
        # Delete cascade handles circle_members via FK
        await db.execute("DELETE FROM circles WHERE id=?", (circle_id,))
        await db.commit()


async def list_all_circles_admin() -> list:
    """管理员：全部圈子 + 圈主信息 + 成员数。"""
    async with connect() as db:
        async with db.execute(
            """SELECT c.id, c.name, c.description, c.code, c.owner_id, c.max_members,
                      c.is_public, c.created_at,
                      u.email AS owner_email, u.nickname AS owner_nickname,
                      (SELECT COUNT(*) FROM circle_members m WHERE m.circle_id=c.id) AS member_count
               FROM circles c
               LEFT JOIN users u ON u.id = c.owner_id
               ORDER BY c.created_at DESC"""
        ) as cur:
            rows = [dict(r) async for r in cur]
            for r in rows:
                r["member_count"] = int(r.get("member_count") or 0)
                r["is_public"] = int(r.get("is_public") if r.get("is_public") is not None else 1)
                r["max_members"] = int(r.get("max_members") or 100)
            return rows


async def update_circle_admin(
    circle_id: int,
    *,
    name: str | None = None,
    description: str | None = None,
    max_members: int | None = None,
    is_public: bool | None = None,
) -> Optional[dict]:
    """管理员更新圈子基础信息。"""
    updates, params = [], []
    if name is not None:
        updates.append("name=?")
        params.append(name.strip())
    if description is not None:
        updates.append("description=?")
        params.append(description.strip())
    if max_members is not None:
        updates.append("max_members=?")
        params.append(int(max_members))
    if is_public is not None:
        updates.append("is_public=?")
        params.append(1 if is_public else 0)
    if not updates:
        return await get_circle_by_id(circle_id)
    params.append(circle_id)
    async with connect() as db:
        await db.execute(
            f"UPDATE circles SET {','.join(updates)} WHERE id=?",
            tuple(params),
        )
        await db.commit()
    return await get_circle_by_id(circle_id)


async def count_circles_owned(owner_id: int) -> int:
    async with connect() as db:
        async with db.execute(
            "SELECT COUNT(*) FROM circles WHERE owner_id=?", (owner_id,)
        ) as cur:
            row = await cur.fetchone()
            return row[0] if row else 0


async def count_circles_joined_only(user_id: int) -> int:
    """Circles user is a member of but does NOT own."""
    async with connect() as db:
        async with db.execute(
            """SELECT COUNT(*) FROM circle_members m
               JOIN circles c ON c.id=m.circle_id
               WHERE m.user_id=? AND c.owner_id!=?""",
            (user_id, user_id),
        ) as cur:
            row = await cur.fetchone()
            return row[0] if row else 0


async def list_circle_members(circle_id: int) -> list:
    """Return basic info of all circle members (id, nickname, email, joined_at)."""
    async with connect() as db:
        async with db.execute(
            """SELECT u.id, u.nickname, u.email, u.avatar_url, m.joined_at
               FROM circle_members m
               JOIN users u ON u.id = m.user_id
               WHERE m.circle_id = ?
               ORDER BY m.joined_at ASC""",
            (circle_id,),
        ) as cur:
            return [dict(r) async for r in cur]


async def list_circle_announcements(circle_id: int, viewer_id: int) -> list:
    """圈子公告列表（含作者、点赞数、当前用户是否已赞）。"""
    async with connect() as db:
        async with db.execute(
            """SELECT a.id, a.circle_id, a.author_id, a.content, a.created_at, a.updated_at,
                      u.nickname, u.email, u.avatar_url,
                      (SELECT COUNT(*) FROM circle_announcement_likes l
                       WHERE l.announcement_id = a.id) AS like_count,
                      EXISTS(SELECT 1 FROM circle_announcement_likes l
                             WHERE l.announcement_id = a.id AND l.user_id = ?) AS liked_by_me
               FROM circle_announcements a
               JOIN users u ON u.id = a.author_id
               WHERE a.circle_id = ?
               ORDER BY a.updated_at DESC""",
            (viewer_id, circle_id),
        ) as cur:
            rows = [dict(r) async for r in cur]
            for r in rows:
                r["liked_by_me"] = bool(r.get("liked_by_me"))
                r["like_count"] = int(r.get("like_count") or 0)
            return rows


async def get_circle_announcement(announcement_id: int) -> Optional[dict]:
    async with connect() as db:
        async with db.execute(
            "SELECT * FROM circle_announcements WHERE id=?", (announcement_id,)
        ) as cur:
            row = await cur.fetchone()
            return dict(row) if row else None


async def create_circle_announcement(circle_id: int, author_id: int, content: str) -> dict:
    text = (content or "").strip()
    if not text:
        raise ValueError("empty content")
    async with connect() as db:
        async with db.execute(
            "INSERT INTO circle_announcements(circle_id, author_id, content) VALUES(?,?,?)",
            (circle_id, author_id, text),
        ) as cur:
            aid = cur.lastrowid
        await db.commit()
        async with db.execute(
            """SELECT a.*, u.nickname, u.email, u.avatar_url FROM circle_announcements a
               JOIN users u ON u.id = a.author_id WHERE a.id=?""",
            (aid,),
        ) as cur:
            row = await cur.fetchone()
            d = dict(row)
            d["like_count"] = 0
            d["liked_by_me"] = False
            return d


async def set_circle_announcement_content(announcement_id: int, content: str) -> bool:
    """更新公告正文（调用方已校验成员权限）。"""
    text = (content or "").strip()
    if not text:
        raise ValueError("empty content")
    async with connect() as db:
        async with db.execute(
            "UPDATE circle_announcements SET content=?, updated_at=datetime('now') WHERE id=?",
            (text, announcement_id),
        ) as cur:
            return cur.rowcount > 0


async def update_circle_announcement(announcement_id: int, author_id: int, content: str) -> Optional[dict]:
    text = (content or "").strip()
    if not text:
        raise ValueError("empty content")
    async with connect() as db:
        async with db.execute(
            "SELECT author_id, circle_id FROM circle_announcements WHERE id=?",
            (announcement_id,),
        ) as cur:
            row = await cur.fetchone()
            if not row:
                return None
            if row["author_id"] != author_id:
                return None
        await db.execute(
            "UPDATE circle_announcements SET content=?, updated_at=datetime('now') WHERE id=?",
            (text, announcement_id),
        )
        await db.commit()
        return await get_circle_announcement(announcement_id)


async def toggle_announcement_like(announcement_id: int, user_id: int) -> dict:
    """切换点赞；返回 {liked, like_count}。"""
    async with connect() as db:
        async with db.execute(
            "SELECT 1 FROM circle_announcement_likes WHERE announcement_id=? AND user_id=?",
            (announcement_id, user_id),
        ) as cur:
            exists = await cur.fetchone()
        if exists:
            await db.execute(
                "DELETE FROM circle_announcement_likes WHERE announcement_id=? AND user_id=?",
                (announcement_id, user_id),
            )
            liked = False
        else:
            await db.execute(
                "INSERT INTO circle_announcement_likes(announcement_id, user_id) VALUES(?,?)",
                (announcement_id, user_id),
            )
            liked = True
        await db.commit()
        async with db.execute(
            "SELECT COUNT(*) FROM circle_announcement_likes WHERE announcement_id=?",
            (announcement_id,),
        ) as cur:
            row = await cur.fetchone()
            count = int(row[0]) if row else 0
        return {"liked": liked, "like_count": count}


async def delete_circle_announcement(announcement_id: int, author_id: int) -> bool:
    async with connect() as db:
        async with db.execute(
            "DELETE FROM circle_announcements WHERE id=? AND author_id=?",
            (announcement_id, author_id),
        ) as cur:
            ok = cur.rowcount > 0
        await db.commit()
        return ok


async def get_circle_post_reply(reply_id: int) -> Optional[dict]:
    async with connect() as db:
        async with db.execute(
            "SELECT * FROM circle_post_replies WHERE id=?", (reply_id,)
        ) as cur:
            row = await cur.fetchone()
            return dict(row) if row else None


async def update_circle_post_reply(reply_id: int, author_id: int, content: str) -> Optional[dict]:
    text = (content or "").strip()
    if not text:
        raise ValueError("empty content")
    async with connect() as db:
        reply = await get_circle_post_reply(reply_id)
        if not reply or reply["author_id"] != author_id:
            return None
        await db.execute(
            "UPDATE circle_post_replies SET content=? WHERE id=? AND author_id=?",
            (text, reply_id, author_id),
        )
        await db.commit()
        async with db.execute(
            """SELECT r.id, r.post_id, r.author_id, r.content, r.created_at,
                      u.nickname, u.email, u.avatar_url
               FROM circle_post_replies r
               JOIN users u ON u.id = r.author_id
               WHERE r.id=?""",
            (reply_id,),
        ) as cur:
            row = await cur.fetchone()
            return dict(row) if row else None


async def delete_circle_post_reply(reply_id: int, author_id: int) -> bool:
    async with connect() as db:
        async with db.execute(
            "DELETE FROM circle_post_replies WHERE id=? AND author_id=?",
            (reply_id, author_id),
        ) as cur:
            ok = cur.rowcount > 0
        await db.commit()
        return ok


async def list_circle_post_replies(post_ids: list) -> dict:
    """批量获取帖子回复，按 post_id 分组。"""
    if not post_ids:
        return {}
    async with connect() as db:
        async with db.execute(
            """SELECT r.id, r.post_id, r.author_id, r.content, r.created_at,
                       u.nickname, u.email, u.avatar_url
                FROM circle_post_replies r
                JOIN users u ON u.id = r.author_id
                WHERE r.post_id = ANY($1)
                ORDER BY r.created_at ASC""",
            (post_ids,),
        ) as cur:
            rows = [dict(r) async for r in cur]
    grouped: dict = {}
    for row in rows:
        grouped.setdefault(row["post_id"], []).append(row)
    return grouped


async def list_circle_posts(circle_id: int, viewer_id: int) -> list:
    """圈子帖子列表（含点赞、回复）。"""
    posts = await list_circle_announcements(circle_id, viewer_id)
    if not posts:
        return posts
    replies_map = await list_circle_post_replies([p["id"] for p in posts])
    for p in posts:
        p["replies"] = replies_map.get(p["id"], [])
    return posts


async def create_circle_post_reply(post_id: int, author_id: int, content: str) -> dict:
    text = (content or "").strip()
    if not text:
        raise ValueError("empty content")
    async with connect() as db:
        async with db.execute(
            "INSERT INTO circle_post_replies(post_id, author_id, content) VALUES(?,?,?)",
            (post_id, author_id, text),
        ) as cur:
            rid = cur.lastrowid
        await db.commit()
        async with db.execute(
            """SELECT r.id, r.post_id, r.author_id, r.content, r.created_at,
                      u.nickname, u.email, u.avatar_url
               FROM circle_post_replies r
               JOIN users u ON u.id = r.author_id
               WHERE r.id=?""",
            (rid,),
        ) as cur:
            row = await cur.fetchone()
            return dict(row)


# ── 圈子浏览 / 入圈申请 ───────────────────────────────────────────────────────

async def list_browsable_circles(user_id: int, query: str = "") -> list:
    """公开圈子列表，附带当前用户的入圈状态。"""
    async with connect() as db:
        sql = """
            SELECT c.id, c.name, c.description, c.max_members, c.code, c.created_at, c.owner_id,
                   (SELECT COUNT(*) FROM circle_members m WHERE m.circle_id=c.id) AS member_count,
                   CASE
                     WHEN EXISTS(SELECT 1 FROM circle_members m WHERE m.circle_id=c.id AND m.user_id=?)
                       THEN 'member'
                     WHEN EXISTS(SELECT 1 FROM circle_join_requests r
                                  WHERE r.circle_id=c.id AND r.user_id=? AND r.status='pending')
                       THEN 'pending'
                     ELSE 'none'
                   END AS join_status
            FROM circles c
            WHERE c.is_public=1
        """
        params: list = [user_id, user_id]
        q = (query or "").strip()
        if q:
            sql += " AND (c.name LIKE ? OR c.description LIKE ?)"
            like = f"%{q}%"
            params.extend([like, like])
        sql += " ORDER BY member_count DESC, c.created_at DESC LIMIT 100"
        async with db.execute(sql, params) as cur:
            rows = [dict(r) async for r in cur]
            for r in rows:
                r["member_count"] = int(r.get("member_count") or 0)
                r["full"] = r["member_count"] >= int(r.get("max_members") or 0)
            return rows


async def count_public_circles() -> int:
    """公开圈子总数。"""
    async with connect() as db:
        async with db.execute("SELECT COUNT(*) FROM circles WHERE is_public=1") as cur:
            row = await cur.fetchone()
            return int(row[0] if row else 0)


async def list_public_circles(limit: int = 50) -> list:
    """公开圈子列表（无需登录）；含成员数与邀请码，不含个人入圈状态。"""
    lim = max(1, min(int(limit or 50), 100))
    async with connect() as db:
        async with db.execute(
            """
            SELECT c.id, c.name, c.description, c.max_members, c.code, c.created_at,
                   (SELECT COUNT(*) FROM circle_members m WHERE m.circle_id=c.id) AS member_count
            FROM circles c
            WHERE c.is_public=1
            ORDER BY member_count DESC, c.created_at DESC
            LIMIT ?
            """,
            (lim,),
        ) as cur:
            rows = [dict(r) async for r in cur]
            for r in rows:
                r["member_count"] = int(r.get("member_count") or 0)
                r["full"] = r["member_count"] >= int(r.get("max_members") or 0)
            return rows


async def get_circle_join_request(circle_id: int, user_id: int) -> Optional[dict]:
    async with connect() as db:
        async with db.execute(
            "SELECT * FROM circle_join_requests WHERE circle_id=? AND user_id=?",
            (circle_id, user_id),
        ) as cur:
            row = await cur.fetchone()
            return dict(row) if row else None


async def get_circle_join_request_by_id(request_id: int) -> Optional[dict]:
    async with connect() as db:
        async with db.execute(
            "SELECT * FROM circle_join_requests WHERE id=?", (request_id,)
        ) as cur:
            row = await cur.fetchone()
            return dict(row) if row else None


async def upsert_circle_join_request(circle_id: int, user_id: int, message: str = "") -> dict:
    """创建或重新提交入圈申请（被拒绝后可再次申请）。"""
    text = (message or "").strip()[:200]
    async with connect() as db:
        async with db.execute(
            "SELECT status FROM circle_join_requests WHERE circle_id=? AND user_id=?",
            (circle_id, user_id),
        ) as cur:
            row = await cur.fetchone()
        if row and row[0] == "pending":
            return await get_circle_join_request(circle_id, user_id)  # type: ignore[return-value]
        if row:
            await db.execute(
                """UPDATE circle_join_requests
                   SET status='pending', message=?, updated_at=datetime('now')
                   WHERE circle_id=? AND user_id=?""",
                (text, circle_id, user_id),
            )
        else:
            await db.execute(
                "INSERT INTO circle_join_requests(circle_id, user_id, message) VALUES(?,?,?)",
                (circle_id, user_id, text),
            )
        await db.commit()
    req = await get_circle_join_request(circle_id, user_id)
    if not req:
        raise RuntimeError("failed to create join request")
    return req


async def list_circle_join_requests(circle_id: int, status: str = "pending") -> list:
    async with connect() as db:
        async with db.execute(
            """SELECT r.id, r.circle_id, r.user_id, r.message, r.status, r.created_at, r.updated_at,
                      u.nickname, u.email, u.avatar_url
               FROM circle_join_requests r
               JOIN users u ON u.id = r.user_id
               WHERE r.circle_id=? AND r.status=?
               ORDER BY r.created_at ASC""",
            (circle_id, status),
        ) as cur:
            return [dict(r) async for r in cur]


async def set_circle_join_request_status(request_id: int, status: str) -> Optional[dict]:
    async with connect() as db:
        await db.execute(
            "UPDATE circle_join_requests SET status=?, updated_at=datetime('now') WHERE id=?",
            (status, request_id),
        )
        await db.commit()
    return await get_circle_join_request_by_id(request_id)

