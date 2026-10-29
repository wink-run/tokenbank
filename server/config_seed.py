"""首次启动时将 static/defaults 写入 system_config，保证客户端同步有内容可拉。"""

from pathlib import Path

import yaml

import database as db
from config_merge import merge_apps_yaml_text, _BILLING_KEYS

_DEFAULTS_DIR = Path(__file__).resolve().parent / "static" / "defaults"

_SEED_KEYS = (
    ("config.apps", "apps.default.yaml"),
    ("config.scenes", "scenes.default.yaml"),
)


async def seed_default_configs() -> None:
    """DB 中 config.apps / config.scenes 为空时，从内置 YAML 种子初始化。供给源目录只走数据库。"""
    # 旧库迁移：config.apps / config.sources 计费段 → config.providers（须在 seed 之前）
    await migrate_legacy_billing_to_providers()

    for key, filename in _SEED_KEYS:
        if await db.get_config(key, ""):
            continue
        if key == "config.apps":
            import app_catalog as ac
            compiled = ac.compile_apps_doc(ac.import_from_defaults())
            content = yaml.dump(
                compiled, allow_unicode=True, sort_keys=False, default_flow_style=False,
            ).rstrip()
        else:
            path = _DEFAULTS_DIR / filename
            if not path.is_file():
                continue
            content = path.read_text(encoding="utf-8").strip()
        if content:
            await db.set_config(key, content)

    await migrate_apps_config_with_defaults()


async def seed_default_studio() -> None:
    """社区圈：studio 无官方场景/插件时，从 studio.default.yaml 幂等灌入（owner_id NULL）。"""
    path = _DEFAULTS_DIR / "studio.default.yaml"
    if not path.is_file():
        return
    try:
        doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except Exception:
        return
    # 已有官方数据则跳过（幂等，避免重复灌入 / 覆盖管理员改动）
    if await db.list_official_scenes() or await db.list_official_mods():
        return
    for s in (doc.get("scenes") or []):
        if s.get("name"):
            await db.create_studio_scene(None, s)
    for m in (doc.get("mods") or []):
        if m.get("name"):
            await db.create_studio_mod(None, m)


async def migrate_legacy_billing_to_providers() -> None:
    """一次性迁移：旧 config.sources / config.apps 计费段 → config.providers。幂等。"""
    if await db.get_config("config.providers", ""):
        return
    import billing_sources as bs

    sources_text = await db.get_config("config.sources", "")
    if sources_text.strip():
        try:
            doc = yaml.safe_load(sources_text) or {}
            sources = bs.import_from_billing_sections_doc(doc)
            if sources:
                await bs.publish_sources({"version": 1, "sources": sources})
                return
        except yaml.YAMLError:
            pass

    apps_text = await db.get_config("config.apps", "")
    if not apps_text.strip():
        return
    try:
        apps_doc = yaml.safe_load(apps_text) or {}
    except yaml.YAMLError:
        return
    if not isinstance(apps_doc, dict):
        return
    billing = {k: apps_doc[k] for k in _BILLING_KEYS if k in apps_doc}
    if not billing:
        return
    sources = bs.import_from_billing_sections_doc({"version": 1, **billing})
    if sources:
        await bs.publish_sources({"version": 1, "sources": sources})


async def migrate_apps_config_with_defaults() -> None:
    """将 DB 中的 config.apps 与内置默认合并后写回（有变更才更新）。"""
    content = await db.get_config("config.apps", "")
    if not content.strip():
        return
    merged = merge_apps_yaml_text(content)
    if merged and merged != content.strip():
        await db.set_config("config.apps", merged)
        content = merged
    await _ensure_app_entities_in_apps_config(content)
    await _backfill_missing_default_entities()


async def _ensure_app_entities_in_apps_config(content: str = "") -> None:
    """旧库仅有 tools 扁平段、或 merge 剥离后缺 app_entities → 从目录默认实体补全。"""
    if not content:
        content = await db.get_config("config.apps", "")
    if not content.strip():
        return
    try:
        doc = yaml.safe_load(content) or {}
    except yaml.YAMLError:
        return
    if not isinstance(doc, dict):
        return
    if doc.get("app_entities"):
        return
    import app_catalog as ac
    catalog = await ac.load_catalog_doc()
    entities = catalog.get("entities") or []
    if not entities:
        entities = ac.import_from_defaults().get("entities") or []
    if not entities:
        return
    compiled = ac.compile_apps_doc({"version": doc.get("version") or 1, "entities": entities})
    yaml_text = yaml.dump(
        compiled, allow_unicode=True, sort_keys=False, default_flow_style=False,
    ).rstrip()
    await db.set_config("config.apps", yaml_text)


async def _backfill_missing_default_entities(content: str = "") -> None:
    """升级回填：目录默认新增实体（如 deepseek-harness）→ 按 id 补进已存 app_entities。
    仅追加缺失项、保留既有实体与用户定制（vars / 手动新建的 API 应用），再按 seed 同路径重编译。"""
    if not content:
        content = await db.get_config("config.apps", "")
    if not content.strip():
        return
    try:
        doc = yaml.safe_load(content) or {}
    except yaml.YAMLError:
        return
    if not isinstance(doc, dict):
        return
    stored = doc.get("app_entities")
    if not isinstance(stored, list) or not stored:
        return  # 空则交给 _ensure_app_entities_in_apps_config 从默认重建
    import app_catalog as ac
    import app_handlers as ah
    defaults = ah.default_entities_compact()
    if not defaults:
        return
    existing_ids = {str(e.get("id")) for e in stored if isinstance(e, dict) and e.get("id")}
    missing = [e for e in defaults if str(e.get("id")) not in existing_ids]
    if not missing:
        return
    merged_entities = list(stored) + missing
    compiled = ac.compile_apps_doc({"version": doc.get("version") or 1, "entities": merged_entities})
    yaml_text = yaml.dump(
        compiled, allow_unicode=True, sort_keys=False, default_flow_style=False,
    ).rstrip()
    await db.set_config("config.apps", yaml_text)
