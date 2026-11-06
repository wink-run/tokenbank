"""上架智能体介绍页：标题和正文要在 HTML 里，不能等脚本。"""

from agent_seo import chat_seo_tags, render_agent_cards, render_agent_intro, render_sitemap


def test_intro_page_is_crawlable():
    html = render_agent_intro({
        "id": "poet",
        "display_name": "写诗专家",
        "description": "按题目写短诗。<script>",
        "owner_nickname": "ada",
        "runtime": "codex",
        "online": True,
    }, related=[{"id": "draw", "display_name": "画图"}])
    assert "<h1>写诗专家</h1>" in html
    assert "按题目写短诗。&lt;script&gt;" in html
    assert "<script>" not in html.split('type="application/ld+json"')[0]
    assert 'rel="canonical"' in html
    assert "/agents/poet" in html
    assert 'href="/a/poet"' in html
    assert 'class="ag-card"' in html
    assert 'href="/agents/draw"' in html
    assert "<li>" not in html
    assert 'href="/u/ada"' in html
    assert "\\u003c" in html or "&lt;script&gt;" in html


def test_index_links_and_sitemap_list_each_agent():
    agents = [
        {"id": "poet", "display_name": "写诗", "owner_nickname": "ada", "online": True},
        {"id": "poet", "display_name": "重复"},
        {"id": "a b", "display_name": "有空格"},
        {"id": "skip", "display_name": "跳过"},
    ]
    links = render_agent_cards(agents, skip_id="skip")
    assert links.count('class="ag-card"') == 2
    assert "<li>" not in links
    assert "上架智能体" not in links
    assert "/agents/poet" in links
    assert "/agents/a%20b" in links
    assert "@ada" in links
    assert "在线" in links
    xml = render_sitemap(agents)
    assert xml.startswith("<?xml")
    assert "/agents/poet" in xml
    assert "<loc>" in xml
    tags = chat_seo_tags({"id": "poet", "display_name": "写诗", "description": "短诗"})
    assert 'href="https://tokenbank.wink.run/agents/poet"' in tags or "/agents/poet" in tags
