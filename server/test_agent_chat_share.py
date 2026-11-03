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


def test_share_drops_empty_chat():
    assert normalize_share_messages([]) == []
    assert normalize_share_messages([{"role": "assistant", "content": "  "}]) == []
