"""上架智能体的介绍页。正文写在 HTML 里，搜索引擎不用执行脚本也能读到。"""

from __future__ import annotations

import json
from html import escape
from urllib.parse import quote

from agent_artifacts import public_origin


def agent_intro_path(assistant_id: str) -> str:
    return "/agents/" + quote(str(assistant_id or "").strip(), safe="")


def _esc(value) -> str:
    return escape(str(value or ""), quote=True)


def _name(card: dict) -> str:
    return str(card.get("display_name") or card.get("name") or card.get("id") or "智能体").strip() or "智能体"


def _description(card: dict) -> str:
    text = " ".join(str(card.get("description") or "").split())
    if text:
        return text
    return f"{_name(card)} 是 Token Bank 上架的智能体，打开网页就能开始对话。"


def _meta_description(card: dict) -> str:
    text = _description(card)
    if len(text) <= 150:
        return text
    return text[:147].rstrip() + "…"


def _json_ld(card: dict, page_url: str) -> str:
    name = _name(card)
    data = {
        "@context": "https://schema.org",
        "@type": "WebPage",
        "name": name,
        "description": _meta_description(card),
        "url": page_url,
        "isPartOf": {"@type": "WebSite", "name": "Token Bank", "url": public_origin()},
        "about": {
            "@type": "SoftwareApplication",
            "name": name,
            "applicationCategory": "AIApplication",
            "description": _description(card),
            "url": page_url,
        },
    }
    owner = str(card.get("owner_nickname") or "").strip()
    if owner:
        data["about"]["author"] = {"@type": "Person", "name": owner}
    raw = json.dumps(data, ensure_ascii=False).replace("<", "\\u003c")
    return raw


def render_agent_intro(card: dict, related: list | None = None) -> str:
    """一个智能体一页：标题、介绍、开始对话，以及少量其他上架智能体。"""
    aid = str(card.get("id") or "").strip()
    name = _name(card)
    desc = _description(card)
    meta = _meta_description(card)
    owner = str(card.get("owner_nickname") or "").strip()
    runtime = str(card.get("runtime") or "").strip()
    online = True if "online" not in card else bool(card.get("online"))
    origin = public_origin()
    page = origin + agent_intro_path(aid)
    status = "当前在线，可以直接对话。" if online else "暂时离线，仍可查看历史对话。"
    bits = [f"{_esc(name)} 在 Token Bank 上架。"]
    if owner:
        who = f'<a href="/u/{quote(owner, safe="")}">@{_esc(owner)}</a>'
        bits.append(f"由 {who} 分享。")
    if runtime:
        bits.append(f"运行时 {_esc(runtime)}。")
    bits.append(_esc(status))

    related_html = ""
    items = []
    for other in related or []:
        oid = str((other or {}).get("id") or "").strip()
        if not oid or oid == aid:
            continue
        items.append(
            f'<li><a href="{_esc(agent_intro_path(oid))}">{_esc(_name(other))}</a></li>'
        )
        if len(items) >= 8:
            break
    if items:
        related_html = (
            '<section class="more"><h2>其他上架智能体</h2><ul>'
            + "".join(items)
            + "</ul></section>"
        )

    owner_row = ""
    if owner:
        owner_row = f'<a class="fact" href="/u/{quote(owner, safe="")}">@{_esc(owner)}</a>'
    runtime_row = f'<span class="fact">{_esc(runtime)}</span>' if runtime else ""
    state = "在线" if online else "离线"

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{_esc(name)} · 智能体 · Token Bank</title>
<meta name="description" content="{_esc(meta)}">
<link rel="canonical" href="{_esc(page)}">
<meta property="og:type" content="website">
<meta property="og:title" content="{_esc(name)} · Token Bank">
<meta property="og:description" content="{_esc(meta)}">
<meta property="og:url" content="{_esc(page)}">
<meta name="twitter:card" content="summary">
<link rel="icon" href="/static/logo.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<script type="application/ld+json">{_json_ld(card, page)}</script>
<style>
*{{box-sizing:border-box;margin:0;padding:0}}
body{{font-family:Inter,-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;background:#fafafa;color:#0a0a0a;-webkit-font-smoothing:antialiased}}
a{{color:inherit}}
.top{{position:sticky;top:0;background:rgba(255,255,255,.92);backdrop-filter:blur(12px);border-bottom:1px solid #eee}}
.top-in{{max-width:760px;margin:0 auto;height:56px;padding:0 20px;display:flex;align-items:center;gap:16px}}
.brand{{display:flex;align-items:center;gap:8px;font-weight:650;text-decoration:none}}
.brand img{{width:26px;height:26px}}
.back{{font-size:13px;color:#71717a;text-decoration:none}}
.wrap{{max-width:760px;margin:0 auto;padding:40px 20px 72px}}
.kicker{{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;background:#eff6ff;color:#2563eb;font-size:13px;font-weight:600}}
h1{{margin-top:14px;font-size:40px;letter-spacing:-.03em;line-height:1.15}}
.lead{{margin-top:14px;font-size:18px;line-height:1.7;color:#3f3f46}}
.facts{{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}}
.fact{{padding:4px 10px;border-radius:999px;background:#fff;border:1px solid #e4e4e7;font-size:13px;color:#52525b;text-decoration:none}}
.prose{{margin-top:22px;font-size:15px;line-height:1.75;color:#3f3f46}}
.prose a{{color:#18181b}}
.cta{{display:inline-flex;margin-top:26px;padding:12px 18px;border-radius:12px;background:#18181b;color:#fff;text-decoration:none;font-weight:650}}
.more{{margin-top:48px;padding-top:22px;border-top:1px solid #e4e4e7}}
.more h2{{font-size:15px;color:#71717a;font-weight:650}}
.more ul{{display:flex;flex-wrap:wrap;gap:8px 14px;list-style:none;margin-top:12px}}
.more a{{font-size:14px}}
</style>
</head>
<body>
<header class="top">
  <div class="top-in">
    <a class="brand" href="/"><img src="/static/logo.svg" alt="Token Bank"><span>Token Bank</span></a>
    <a class="back" href="/agents">智能体广场</a>
  </div>
</header>
<main class="wrap">
  <span class="kicker">{_esc(state)}</span>
  <h1>{_esc(name)}</h1>
  <p class="lead">{_esc(desc)}</p>
  <div class="facts">{owner_row}{runtime_row}<span class="fact">{_esc(state)}</span></div>
  <p class="prose">{''.join(bits)}</p>
  <a class="cta" href="{_esc('/a/' + quote(aid, safe=''))}">开始对话</a>
  {related_html}
</main>
</body>
</html>
"""


def render_agent_index_links(agents: list | None) -> str:
    """广场页底部的文字链接。爬虫不跑脚本也能发现每个介绍页。"""
    items = []
    seen = set()
    for card in agents or []:
        if not isinstance(card, dict):
            continue
        aid = str(card.get("id") or "").strip()
        if not aid or aid in seen:
            continue
        seen.add(aid)
        items.append(f'<li><a href="{_esc(agent_intro_path(aid))}">{_esc(_name(card))}</a></li>')
        if len(items) >= 200:
            break
    if not items:
        return ""
    return (
        '<section class="ag-index" style="max-width:1200px;margin:0 auto;padding:8px 24px 56px;'
        'font-family:Inter,-apple-system,sans-serif">'
        '<h2 style="font-size:14px;color:#71717a;font-weight:650">上架智能体</h2>'
        '<ul style="display:flex;flex-wrap:wrap;gap:8px 16px;list-style:none;padding:0;margin:12px 0 0">'
        + "".join(items)
        + "</ul></section>"
    )


def render_sitemap(agents: list | None) -> str:
    origin = public_origin()
    locs = [origin + "/", origin + "/agents", origin + "/network"]
    seen = set()
    for card in agents or []:
        if not isinstance(card, dict):
            continue
        aid = str(card.get("id") or "").strip()
        if not aid or aid in seen:
            continue
        seen.add(aid)
        locs.append(origin + agent_intro_path(aid))
        if len(locs) >= 2000:
            break
    body = "".join(f"<url><loc>{_esc(loc)}</loc></url>" for loc in locs)
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        + body
        + "</urlset>"
    )


def apply_chat_seo(html: str, card: dict) -> str:
    """对话页补上介绍页的标题和规范地址。页面脚本随后仍可改标题。"""
    name = _name(card)
    meta = _meta_description(card)
    html = html.replace(
        "<title>Token Bank Agent</title>",
        f"<title>{_esc(name)} · Token Bank</title>",
        1,
    )
    html = html.replace(
        '<meta name="description" content="试用已分享的智能体">',
        f'<meta name="description" content="{_esc(meta)}">{chat_seo_tags(card)}',
        1,
    )
    return html


def chat_seo_tags(card: dict) -> str:
    """对话页把规范地址指到介绍页，避免两套网址抢同一个名字。"""
    aid = str(card.get("id") or "").strip()
    if not aid:
        return ""
    name = _name(card)
    meta = _meta_description(card)
    canon = public_origin() + agent_intro_path(aid)
    return (
        f'<link rel="canonical" href="{_esc(canon)}">'
        f'<meta property="og:title" content="{_esc(name)} · Token Bank">'
        f'<meta property="og:description" content="{_esc(meta)}">'
        f'<meta property="og:url" content="{_esc(canon)}">'
    )
