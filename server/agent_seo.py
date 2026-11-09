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


OG_IMAGE = "/static/og/token-bank.png"


def _keywords(card: dict) -> str:
    name, owner = _split_name(card)
    bits = [name, "智能体", "AI 智能体", "在线使用"]
    rt = _runtime_label(card.get("runtime"))
    if rt:
        bits.append(rt)
    if owner:
        bits.append(owner)
    bits.append("Token Bank")
    return ",".join(b for b in bits if b)


def _crumbs_ld(name: str, page_url: str) -> str:
    origin = public_origin()
    data = {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Token Bank", "item": origin + "/"},
            {"@type": "ListItem", "position": 2, "name": "智能体广场", "item": origin + "/agents"},
            {"@type": "ListItem", "position": 3, "name": name, "item": page_url},
        ],
    }
    return json.dumps(data, ensure_ascii=False).replace("<", "\\u003c")


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


_RUNTIMES = {
    "claude-code": ("Claude Code", "claudecode-color.svg"),
    "codex": ("Codex", "codex-color.svg"),
    "cursor": ("Cursor", "cursor.svg"),
    "kimi-code": ("Kimi Code", "kimi-color.svg"),
    "kimi": ("Kimi", "kimi-color.svg"),
    "pi": ("Pi", ""),
    "gemini": ("Gemini CLI", "geminicli-color.svg"),
    "gemini-cli": ("Gemini CLI", "geminicli-color.svg"),
    "openclaw": ("OpenClaw", "openclaw-color.svg"),
    "hermes": ("Hermes", "hermesagent.svg"),
    "opencode": ("OpenCode", "opencode.svg"),
    "qwen": ("Qwen Code", "qwen-color.svg"),
    "grokbot": ("GrokBot", "grokbot.svg"),
    "muse": ("Muse", "muse.svg"),
    "workbuddy": ("WorkBuddy", "codebuddy-color.svg"),
}


def _runtime_label(runtime: str) -> str:
    k = str(runtime or "").strip().lower()
    if not k:
        return ""
    return _RUNTIMES.get(k, (k[:1].upper() + k[1:], ""))[0]


def _split_name(card: dict) -> tuple[str, str]:
    """和广场页 splitName 一致：去掉「作者的」前缀，名片上作者单独显示。"""
    name = _name(card)
    owner = str(card.get("owner_nickname") or "").strip()
    if owner:
        if name.startswith(owner + "的") and len(name) > len(owner) + 1:
            return name[len(owner) + 1:].strip(), owner
        return name, owner
    import re
    m = re.match(r"^(.{1,24}?)的(.+)$", name)
    return (m.group(2).strip(), m.group(1).strip()) if m else (name, "")


def _app_icon(card: dict) -> str:
    """直接出租的应用（id 里带 app:xxx）用应用图标，自定义智能体用首字。"""
    import re
    m = re.search(r"(?:^|:)app:([A-Za-z0-9._-]+)", str(card.get("id") or ""))
    if not m:
        return ""
    rt = m.group(1).split("@")[0].lower()
    icon = _RUNTIMES.get(rt, ("", ""))[1]
    return "/static/brand-icons/" + icon if icon else ""


def _friendly_desc(card: dict) -> str:
    d = _description(card)
    if "在出租者本机的该应用里执行" in d or "runs inside that app on the owner" in d:
        app = _runtime_label(card.get("runtime")) or _split_name(card)[0]
        return f"基于 {app} 的通用编程智能体：写代码、改 bug、跑脚本，任务在分享者的电脑上完成。"
    return d


def _avatar_html(card: dict, cls: str = "ag-av") -> str:
    icon = _app_icon(card)
    if icon:
        return f'<span class="{cls} brand"><img src="{_esc(icon)}" alt=""></span>'
    name = _split_name(card)[0]
    return f'<span class="{cls}" style="background:{_avatar_color(name)}">{_esc(name[:1] or "?")}</span>'


_NAV_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 16.5h14M6.5 16.5l1.3-4.6A2 2 0 0 1 9.7 10.5h4.6a2 2 0 0 1 1.9 1.4l1.3 4.6"/><path d="M4.5 16.5v2.25M19.5 16.5v2.25"/><circle cx="8" cy="16.5" r="1"/><circle cx="16" cy="16.5" r="1"/></svg>'


def render_agent_intro(card: dict, related: list | None = None) -> str:
    """一个智能体一页：深色首屏（名片 + 开始对话）、怎么用、为什么放心、其他智能体。正文都在 HTML 里。"""
    aid = str(card.get("id") or "").strip()
    name, owner = _split_name(card)
    full = _name(card)
    desc = _friendly_desc(card)
    meta = _meta_description(card)
    runtime = _runtime_label(card.get("runtime"))
    online = True if "online" not in card else bool(card.get("online"))
    hires = int(card.get("hire_count") or 0) if str(card.get("hire_count") or "0").isdigit() else 0
    page = public_origin() + agent_intro_path(aid)
    chat = "/a/" + quote(aid, safe="")
    state = "在线" if online else "离线"
    state_tip = "现在就能对话" if online else "分享者的设备暂时离线，可以先看历史对话"
    cta = "开始对话" if online else "看历史对话"

    owner_html = f'<a href="/u/{quote(owner, safe="")}">@{_esc(owner)}</a>' if owner else ""
    facts = []
    if owner:
        facts.append(f'<div><span>分享者</span><b>{owner_html}</b></div>')
    if runtime:
        facts.append(f'<div><span>运行引擎</span><b>{_esc(runtime)}</b></div>')
    facts.append(f'<div><span>状态</span><b class="ad-state {"on" if online else "off"}"><i></i>{state}</b></div>')
    if hires:
        facts.append(f'<div><span>被使用</span><b>{hires} 次</b></div>')

    related_html = ""
    others = render_agent_cards(related, skip_id=aid, limit=6)
    if others:
        related_html = (
            '<section class="pz-sec ad-more"><div class="pz-kicker">MORE AGENTS</div>'
            '<h2 class="pz-h2">其他智能体</h2>'
            f'<div class="ag-grid">{others}</div>'
            '<a class="ad-all" href="/agents">逛逛整个智能体广场 →</a></section>'
        )

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{_esc(full)} · 智能体 · Token Bank</title>
<meta name="description" content="{_esc(meta)}">
<link rel="canonical" href="{_esc(page)}">
<meta property="og:type" content="website">
<meta property="og:title" content="{_esc(full)} · Token Bank">
<meta property="og:description" content="{_esc(meta)}">
<meta property="og:url" content="{_esc(page)}">
<meta property="og:site_name" content="Token Bank">
<meta property="og:locale" content="zh_CN">
<meta property="og:image" content="{_esc(public_origin() + OG_IMAGE)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{_esc(full)} · Token Bank">
<meta name="twitter:description" content="{_esc(meta)}">
<meta name="twitter:image" content="{_esc(public_origin() + OG_IMAGE)}">
<meta name="keywords" content="{_esc(_keywords(card))}">
<meta name="theme-color" content="#17150f">
<link rel="icon" href="/static/logo.svg" type="image/svg+xml">
<script type="application/ld+json">{_json_ld(card, page)}</script>
<script type="application/ld+json">{_crumbs_ld(full, page)}</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/static/plaza.css?v=36">
<script src="/static/plaza-nav.js?v=20"></script>
<style>
*{{box-sizing:border-box;margin:0;padding:0}}
body{{font-family:Inter,-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;background:#faf8f3;color:#0a0a0a;-webkit-font-smoothing:antialiased}}
a{{color:inherit;text-decoration:none}}
</style>
</head>
<body>
<a class="pz-promo" id="tb-promo" href="/app?signup=1"><i aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="8.5" width="17" height="4" rx="1"/><path d="M5 12.5V20h14v-7.5M12 8.5V20M12 8.5S10.5 4 8 4.5 7.5 8.5 12 8.5zM12 8.5s1.5-4.5 4-4 .5 4-4 4z"/></svg></i><b>限时免费中</b><span>注册就送 50 积分</span><em>立即注册 →</em></a>
<nav class="ag-top">
  <div class="ag-top-in">
    <a class="ag-brand" href="/"><img src="/static/logo.svg" alt=""><span>Token Bank</span></a>
    <div class="ag-modes ag-main"><a class="ag-mode on" href="/agents">智能体广场</a><a class="ag-mode" href="/share">分享与收益</a><a class="ag-mode" href="/market">资源市场</a></div>
    <div class="ag-top-r">
      <a class="ag-nav hide-sm" href="/app">登录</a>
      <details class="ag-menu"><summary aria-label="菜单"><i></i><i></i><i></i></summary><div class="ag-menu-p"><div class="ag-menu-g"><a href="/">首页</a><a class="on" href="/agents">智能体广场</a><a href="/share">分享与收益</a><a href="/market">资源市场</a></div><div class="ag-menu-f"><a href="/app">登录</a><a class="dl" href="/#download">下载客户端</a></div></div></details>
    </div>
  </div>
</nav>

<header class="pz-hero ad-hero">
  <div class="pz-grid-bg" aria-hidden="true"></div>
  <div class="ad-hero-in">
    <a class="ad-crumb" href="/agents">← 智能体广场</a>
    <div class="ad-id">
      {_avatar_html(card, "ag-av ad-av")}
      <div class="ad-title">
        <h1>{_esc(name)}</h1>
        <div class="ad-sub">{owner_html}{' · ' if owner and runtime else ''}{_esc(runtime)}<span class="ad-state {'on' if online else 'off'}"><i></i>{state}</span></div>
      </div>
    </div>
    <p class="ad-lead">{_esc(desc)}</p>
    <div class="ad-ctas nw-ctas">
      <a class="pz-btn pri" href="{_esc(chat)}">{cta} →</a>
      <button class="pz-btn ghost" type="button" data-share="{_esc(page)}">复制分享链接</button>
    </div>
    <p class="ad-tip">{_esc(state_tip)}。未登录也能先试一轮，<a href="/app?signup=1">注册就送 50 积分</a>。</p>
    <div class="ad-chat" aria-hidden="true">
      <div class="ad-chat-bar"><i></i><i></i><i></i><span>{_esc(name)}</span><b class="ad-state {'on' if online else 'off'}"><i></i>{state}</b></div>
      <div class="ad-chat-body">
        <div class="ad-msg bot">{_avatar_html(card, "ag-av ad-mini")}<span>你好，我是{_esc(name)}。说说你想做什么？</span></div>
        <div class="ad-msg me"><span>{_esc(desc[:28] + ("…" if len(desc) > 28 else ""))}</span></div>
        <div class="ad-msg bot">{_avatar_html(card, "ag-av ad-mini")}<span class="ad-dots"><i></i><i></i><i></i></span></div>
      </div>
      <div class="ad-chat-in">输入你的需求…<em>发送</em></div>
    </div>
    <div class="ad-facts">{''.join(facts)}</div>
  </div>
</header>

<main class="ag-page">
  <section class="pz-sec">
    <div class="pz-kicker">HOW IT WORKS</div>
    <h2 class="pz-h2">像打车一样用</h2>
    <div class="ad-steps">
      <div><em>1</em><b>说清要做什么</b><span>网页里直接打字，可以带图片和文件。</span></div>
      <div><em>2</em><b>在分享者设备上执行</b><span>{_esc(name)} 跑在 {owner_html or '分享者'} 调好的环境里，你不用装任何东西。</span></div>
      <div><em>3</em><b>拿结果，按次付</b><span>用一次扣一次积分，不用订阅。</span></div>
    </div>
    <div class="ad-safe">
      <div><b>配方不外泄</b><span>提示词、Skill 和 Key 留在分享者设备上，你拿到的是结果。</span></div>
      <div><b>先试再用</b><span>不登录也能先试一轮，觉得好再登录接着聊。</span></div>
      <div><b>一个链接拉朋友</b><span>把链接发给朋友，大家能在同一场对话里接着聊。</span></div>
    </div>
  </section>
  {related_html}
</main>

<a class="pz-ride-band" href="/why">
  <div class="pz-ride-in">
    <i class="pz-ride-ic" aria-hidden="true">{_NAV_ICON}</i>
    <span><b>买车不如打车</b><small>不用订阅、不用配置，用一次付一次</small></span>
    <em>为什么 →</em>
  </div>
</a>
<footer class="nw-foot"><span>Token Bank</span><a href="/agents">智能体广场</a><a href="/why">为什么用</a><a href="/">开发者概览</a><a href="/share">分享与收益</a><a href="/market">资源市场</a></footer>
<script>
try {{ if (localStorage.getItem('user_token')) document.getElementById('tb-promo').remove(); }} catch (e) {{}}
document.querySelectorAll('[data-share]').forEach(function (b) {{
  b.addEventListener('click', function () {{
    var u = b.getAttribute('data-share'), t = b.textContent;
    function done() {{ b.textContent = '已复制'; setTimeout(function () {{ b.textContent = t; }}, 1500); }}
    if (navigator.clipboard) navigator.clipboard.writeText(u).then(done, function () {{ prompt('复制链接', u); }});
    else prompt('复制链接', u);
  }});
}});
</script>
</body>
</html>
"""


_AVATAR_COLORS = ("#0a0a0a", "#7c3aed", "#2563eb", "#047857", "#b45309", "#be123c")


def _avatar_color(name: str) -> str:
    """和广场页 avatarColor 同一套取色，服务端卡片和前端卡片对得上。"""
    n = 0
    for ch in name or "?":
        n = (n + ord(ch)) % len(_AVATAR_COLORS)
    return _AVATAR_COLORS[n]


def render_agent_cards(agents: list | None, skip_id: str = "", limit: int = 50) -> str:
    """广场上的同一张名片。链接指向介绍页，不另做一排文字链接。"""
    items = []
    seen = set()
    skip = str(skip_id or "").strip()
    for card in agents or []:
        if not isinstance(card, dict):
            continue
        aid = str(card.get("id") or "").strip()
        if not aid or aid in seen or aid == skip:
            continue
        seen.add(aid)
        name, owner = _split_name(card)
        runtime = _runtime_label(card.get("runtime"))
        meta = []
        if owner:
            meta.append("@" + owner)
        if runtime:
            meta.append(runtime)
        desc = _friendly_desc(card) if card.get("description") else ""
        online = True if "online" not in card else bool(card.get("online"))
        state = "在线" if online else "离线"
        action = "去使用" if online else "看记录"
        dot = "ok" if online else "off"
        items.append(
            f'<a class="ag-card{"" if online else " is-off"}" href="{_esc(agent_intro_path(aid))}">'
            '<div class="ag-h">'
            + _avatar_html(card) +
            '<div style="min-width:0;flex:1">'
            f'<div class="ag-name">{_esc(name)}</div>'
            f'<div class="ag-meta">{_esc(" · ".join(meta))}</div>'
            "</div></div>"
            f'<p class="ag-desc">{_esc(desc)}</p>'
            '<div class="ag-foot">'
            f'<i class="ag-dot {dot}"></i><span>{state}</span>'
            f'<span class="ag-go">{action}</span>'
            "</div></a>"
        )
        if len(items) >= limit:
            break
    return "".join(items)


def render_sitemap(agents: list | None, models: list | None = None) -> str:
    origin = public_origin()
    locs = [origin + "/", origin + "/agents", origin + "/why", origin + "/share", origin + "/market", origin + "/circles"]
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
    for m in models or []:
        m = str(m or "").strip()
        if m and len(locs) < 2000:
            locs.append(origin + "/m/" + quote(m, safe=""))
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
        f'<meta property="og:image" content="{_esc(public_origin() + OG_IMAGE)}">'
        '<meta name="twitter:card" content="summary_large_image">'
        f'<meta name="twitter:image" content="{_esc(public_origin() + OG_IMAGE)}">'
    )


def apply_model_seo(html: str, model: str) -> str:
    """模型试用页：按模型名写标题、描述和规范地址，搜索引擎不用执行脚本也能读到。"""
    model = " ".join(str(model or "").split())[:120]
    if not model:
        return html
    page = public_origin() + "/m/" + quote(model, safe="")
    title = f"{model} 在线试用 · Token Bank"
    desc = f"在浏览器里直接试用 {model}：不用自己的 API Key，由社区节点提供，按积分计费。接进 Claude Code、Codex 等客户端后模型名不变。限时免费，注册送 50 积分。"
    img = public_origin() + OG_IMAGE
    tags = (
        f'<link rel="canonical" href="{_esc(page)}">'
        f'<meta name="keywords" content="{_esc(model)},在线试用,AI 模型,大模型,模型 API,Token Bank">'
        '<meta property="og:type" content="website"><meta property="og:site_name" content="Token Bank">'
        f'<meta property="og:title" content="{_esc(title)}"><meta property="og:description" content="{_esc(desc)}">'
        f'<meta property="og:url" content="{_esc(page)}"><meta property="og:image" content="{_esc(img)}">'
        '<meta name="twitter:card" content="summary_large_image">'
        f'<meta name="twitter:image" content="{_esc(img)}">'
    )
    html = html.replace("<title>模型试用 · Token Bank</title>", f"<title>{_esc(title)}</title>", 1)
    html = html.replace(
        '<meta name="description" content="在资源市场试用开发者共享的模型">',
        f'<meta name="description" content="{_esc(desc)}">{tags}',
        1,
    )
    return html
