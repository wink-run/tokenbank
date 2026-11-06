"""分享正文只留下对方能打开的内容。"""

from agent_chat_share import normalize_share_messages

VIDEO = "https://tokenbank.wink.run/media/agent/at-1/clip.mp4"
LOCAL = "/Users/ully/.tokenbank/contribute-workspaces/a/u1/outputs/clip.mp4"


def test_share_keeps_transcript_and_proxy_video():
    out = normalize_share_messages([
        {"role": "user", "content": "做一支宣传片", "images": ["data:image/png;base64,aaaa"]},
        {
            "role": "assistant",
            "content": f"成片：{LOCAL}",
            "parts": [{"type": "text", "text": f"成片：{LOCAL}"}],
            "artifacts": [{
                "name": "轻记账技能-宣传片-16x9.mp4",
                "mime": "video/mp4",
                "kind": "file",
                "url": VIDEO,
                "dataUrl": "data:video/mp4;base64,bbbb",
            }],
        },
        {"role": "system", "content": "ignore"},
    ])
    assert len(out) == 2
    assert out[0]["role"] == "user"
    assert "images" not in out[0]
    art = out[1]["artifacts"][0]
    assert art["url"] == VIDEO
    assert "dataUrl" not in art
    assert art["name"].endswith(".mp4")


def test_share_appends_later_speaker_in_time_order():
    from agent_chat_share import append_share_turns
    base = [
        {"role": "user", "content": "阿达先问", "author": "阿达", "at": 1000},
        {"role": "assistant", "content": "好", "at": 1100},
    ]
    extra = [
        {"role": "user", "content": "小波接上", "author": "小波", "at": 5000},
        {"role": "assistant", "content": "好", "at": 5100},
    ]
    out = append_share_turns(base, extra)
    assert [m["content"] for m in out] == ["阿达先问", "好", "小波接上", "好"]
    assert append_share_turns(out, extra) == out


def test_cloud_clock_ignores_client_and_replay_keeps_it():
    from agent_chat_share import append_share_turns
    # 端上各自带来的 at 不入库。用户时间用抢到发言权时的云端时间，回复用落库时间
    incoming = [
        {"role": "user", "content": "钟鼓楼同框", "author": "adam", "at": 17_000},
        {"role": "assistant", "content": "图", "at": 1_000},
    ]
    out = append_share_turns([], incoming, now_ms=20_000, user_at=18_000)
    assert [m["role"] for m in out] == ["user", "assistant"]
    assert out[0]["at"] == 18_000
    assert out[1]["at"] == 20_000
    again = append_share_turns(out, incoming, now_ms=90_000, user_at=90_000)
    assert [m["at"] for m in again] == [18_000, 20_000]


def test_share_turn_expires_when_idle_or_too_long():
    from datetime import datetime, timedelta, timezone
    from agent_chat_share import share_turn_expired
    now = datetime(2026, 11, 3, tzinfo=timezone.utc)
    assert share_turn_expired(None, "", now) is True
    assert share_turn_expired(now - timedelta(seconds=10), "", now) is False
    assert share_turn_expired(now - timedelta(seconds=31), "", now) is True
    assert share_turn_expired(now - timedelta(minutes=5), "at-abc", now) is False
    assert share_turn_expired(now - timedelta(minutes=21), "at-abc", now) is True


def test_share_labels_people_and_preview():
    from agent_chat_share import share_author_label, share_preview
    assert share_author_label("阿达", "a@b.c") == "阿达"
    assert share_author_label("", "ada@example.com") == "ada"
    assert share_preview([
        {"role": "assistant", "content": "先别算"},
        {"role": "user", "content": "帮我做一张封面"},
    ]) == "帮我做一张封面"
    # 后面又说了别的，标题仍停在新对话的第一句
    assert share_preview([
        {"role": "user", "content": "先做封面"},
        {"role": "assistant", "content": "好"},
        {"role": "user", "content": "再改一版"},
    ]) == "先做封面"


def test_history_keeps_one_snapshot_per_chat():
    from agent_chat_share import dedupe_chat_snapshots
    older = {
        "id": "old",
        "messages": [
            {"role": "user", "content": "介绍一下你的能力和适合的任务"},
            {"role": "assistant", "content": "我可以做图"},
        ],
    }
    newer = {
        "id": "new",
        "messages": older["messages"] + [
            {"role": "user", "content": "再出一张"},
            {"role": "assistant", "content": "好"},
        ],
    }
    same_again = {"id": "copy", "messages": list(newer["messages"])}
    other = {
        "id": "other",
        "messages": [
            {"role": "user", "content": "另一场新对话"},
            {"role": "assistant", "content": "在"},
        ],
    }
    out = dedupe_chat_snapshots([newer, same_again, older, other], limit=5)
    assert [c["id"] for c in out] == ["new", "other"]
    blank = {"id": "blank", "messages": []}
    blank2 = {"id": "blank2", "messages": []}
    kept = dedupe_chat_snapshots([blank, blank2, other], limit=5)
    assert [c["id"] for c in kept] == ["blank", "blank2", "other"]


def test_share_drops_empty_chat():
    assert normalize_share_messages([]) == []
    assert normalize_share_messages([{"role": "assistant", "content": "  "}]) == []
