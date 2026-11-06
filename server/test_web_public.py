"""web_public：网页试用校验与贡献者聚合"""

from web_public import (
    validate_web_chat_body,
    extract_assistant_text,
    aggregate_sharer_profile,
    guest_trial_allowed,
    release_guest_trial,
    validate_guest_web_chat_messages,
    _guest_hits,
)


def test_validate_web_chat_ok():
    out = validate_web_chat_body(
        "glm-5.2",
        [{"role": "user", "content": "hello"}],
        "s_abcdef12",
    )
    assert out["model"] == "glm-5.2"
    assert out["sharer"] == "s_abcdef12"
    assert out["messages"][0]["content"] == "hello"


def test_validate_web_chat_rejects_bad():
    try:
        validate_web_chat_body("", [{"role": "user", "content": "x"}])
        assert False
    except ValueError as e:
        assert "model" in str(e)

    try:
        validate_web_chat_body("m", [{"role": "user", "content": ""}])
        assert False
    except ValueError:
        pass

    try:
        validate_web_chat_body("m", [{"role": "user", "content": "hi"}], "not-a-sharer")
        assert False
    except ValueError as e:
        assert "sharer" in str(e)


def test_guest_one_turn_and_rate_limit():
    """访客仅一条 user；IP 滑动窗口限流。"""
    validate_guest_web_chat_messages([{"role": "user", "content": "hi"}])
    try:
        validate_guest_web_chat_messages([
            {"role": "user", "content": "a"},
            {"role": "assistant", "content": "b"},
        ])
        assert False
    except ValueError as e:
        assert "guest" in str(e).lower() or "sign in" in str(e).lower()

    _guest_hits.clear()
    assert guest_trial_allowed("10.0.0.1", now=1000.0, limit=2) is True
    assert guest_trial_allowed("10.0.0.1", now=1001.0, limit=2) is True
    assert guest_trial_allowed("10.0.0.1", now=1002.0, limit=2) is False
    # 另一 IP 不受影响
    assert guest_trial_allowed("10.0.0.2", now=1002.0, limit=2) is True
    # 窗口滑出后恢复
    assert guest_trial_allowed("10.0.0.1", now=1000.0 + 3601.0, limit=2) is True
    # 没跑起来的那次要退回，下一次仍算第一条
    assert guest_trial_allowed("10.0.0.3", now=5.0, limit=1) is True
    assert guest_trial_allowed("10.0.0.3", now=6.0, limit=1) is False
    release_guest_trial("10.0.0.3")
    assert guest_trial_allowed("10.0.0.3", now=7.0, limit=1) is True


def test_validate_web_chat_multimodal_and_agent_images():
    """网页对话支持 image_url parts；智能体附图仅 data URL。"""
    from web_public import normalize_agent_images, WEB_CHAT_MAX_IMAGES

    tiny = "data:image/png;base64,aaaa"
    out = validate_web_chat_body(
        "vl-model",
        [{"role": "user", "content": [
            {"type": "text", "text": "这是什么"},
            {"type": "image_url", "image_url": {"url": tiny}},
        ]}],
    )
    parts = out["messages"][0]["content"]
    assert isinstance(parts, list)
    assert parts[0]["type"] == "text"
    assert parts[1]["type"] == "image_url"
    assert parts[1]["image_url"]["url"] == tiny

    # 仅图：自动补 text part
    only_img = validate_web_chat_body(
        "vl-model",
        [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": tiny}},
        ]}],
    )
    assert any(p.get("type") == "text" for p in only_img["messages"][0]["content"])

    try:
        validate_web_chat_body(
            "m",
            [{"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": "https://evil.example/x.png"}},
            ]}],
        )
        assert False
    except ValueError as e:
        assert "data URL" in str(e)

    imgs = normalize_agent_images([
        {"dataUrl": tiny, "name": "shot.png"},
        tiny,
    ])
    assert len(imgs) == 2
    assert imgs[0]["name"] == "shot.png"
    assert imgs[1]["dataUrl"] == tiny

    try:
        normalize_agent_images([{"dataUrl": tiny}] * (WEB_CHAT_MAX_IMAGES + 1))
        assert False
    except ValueError as e:
        assert "at most" in str(e)

    from web_public import normalize_agent_files
    files = normalize_agent_files([
        {"dataUrl": "data:text/plain;base64,aGVsbG8=", "name": "../notes.txt"},
    ])
    assert files == [{"dataUrl": "data:text/plain;base64,aGVsbG8=", "name": "notes.txt"}]
    try:
        normalize_agent_files([{"dataUrl": "https://evil.example/a.pdf"}])
        assert False
    except ValueError as e:
        assert "data URL" in str(e)


def test_extract_assistant_text():
    assert extract_assistant_text({
        "choices": [{"message": {"role": "assistant", "content": "你好"}}],
    }) == "你好"
    assert extract_assistant_text({}) == ""
    assert extract_assistant_text(None) == ""


def test_infer_and_validate_image():
    from web_public import (
        infer_model_type,
        infer_model_type_from_name,
        normalize_model_type,
        is_chat_capable,
        validate_web_image_body,
        MODEL_TYPES,
    )
    assert MODEL_TYPES == ("chat", "vision", "image", "embedding")
    assert normalize_model_type("vl") == "vision"
    assert normalize_model_type("text") == "chat"
    assert infer_model_type_from_name("text-embedding-3-small") == "embedding"
    assert infer_model_type("glm-5.2", {"glm-5.2": "chat"}) == "chat"
    assert infer_model_type("gpt-4o", {"gpt-4o": "vision"}) == "vision"
    assert infer_model_type("agnes-image-2.1-flash", {"agnes-image-2.1-flash": "image"}) == "image"
    assert infer_model_type("agnes-image-2.1-flash", {}) == "image"
    # 供给源误报 chat 时，按名称纠偏为 image
    assert infer_model_type("agnes-image-2.1-flash", {"agnes-image-2.1-flash": "chat"}) == "image"
    assert infer_model_type("bge-m3", {"bge-m3": "chat"}) == "embedding"
    assert is_chat_capable("vision") and is_chat_capable("chat")
    assert not is_chat_capable("image")
    out = validate_web_image_body("agnes-image-2.1-flash", "a cat", 1)
    assert out["n"] == 1
    try:
        validate_web_image_body("m", "")
        assert False
    except ValueError:
        pass


def test_aggregate_sharer_profile():
    class W:
        def __init__(self, **kw):
            for k, v in kw.items():
                setattr(self, k, v)

    w1 = W(
        worker_id="w1",
        name="adam-mac",
        owner_nickname="adam",
        models=["glm-5.2", "glm-4.7"],
        agents=[
            {"id": "poet", "name": "poet", "display_name": "写诗专家", "visibility": "public", "description": "d"},
            {"id": "priv", "name": "priv", "visibility": "circle"},
        ],
        period_stats={
            "glm-5.2": {"output_tokens": 1000, "ttft_sum": 2000, "ttft_count": 2},
            "__agent__:poet": {"agent_count": 3, "output_tokens": 0},
        },
        _sharer="s_aaa11111",
    )
    w2 = W(
        worker_id="vw-1",
        name="adam-agent",
        owner_nickname="adam",
        models=["glm-5.2"],
        agents=[{"id": "poet", "name": "poet", "display_name": "写诗专家", "visibility": "public"}],
        period_stats={"glm-5.2": {"output_tokens": 500, "ttft_sum": 1000, "ttft_count": 1}},
        _sharer="s_aaa11111",
    )
    other = W(
        worker_id="w3", name="bob", owner_nickname="bob", models=["x"],
        agents=[], period_stats={}, _sharer="s_bbb22222",
    )

    def mask(n):
        return n[0] + "***" if n else "***"

    def sharer_fn(w):
        return getattr(w, "_sharer", None)

    profile = aggregate_sharer_profile(
        [w1, w2, other], "s_aaa11111",
        mask_name=mask, worker_sharer_fn=sharer_fn,
    )
    assert profile is not None
    assert profile["sharer"] == "s_aaa11111"
    assert profile["name"] == "a***"
    assert profile["online_nodes"] == 2
    assert profile["period_tokens"] == 1500
    assert profile["period_agent_jobs"] == 3
    assert "glm-5.2" in profile["models"]
    assert "glm-4.7" in profile["models"]
    assert len(profile["agents"]) == 1
    assert profile["agents"][0]["id"] == "poet"

    assert aggregate_sharer_profile([], "s_aaa11111", mask_name=mask, worker_sharer_fn=sharer_fn) is None
    assert aggregate_sharer_profile([w1], "s_missing", mask_name=mask, worker_sharer_fn=sharer_fn) is None
