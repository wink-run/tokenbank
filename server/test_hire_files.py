"""云端转发的雇佣文件走 COS 引用：上限 500MB、私有随机路径、转发前核对。"""

import unittest
from unittest import mock

import hire_files
from web_public import normalize_agent_files, normalize_agent_images

KEY = "agent-media/hire/abcdefghijklmnopqrstuvwx/a.png"


class HireFilesTest(unittest.TestCase):
    def test_upload_url_random_private_path_and_cap(self):
        seen = {}

        def presign(key, ctype):
            seen["key"], seen["type"] = key, ctype
            return f"https://cos.example/{key}?sign=put"

        a = hire_files.new_upload("报告 v2.pdf", 1024, "application/pdf", presign=presign)
        b = hire_files.new_upload("报告 v2.pdf", 1024, "application/pdf", presign=presign)
        self.assertTrue(a["cos_key"].startswith("agent-media/hire/"))
        self.assertNotEqual(a["cos_key"], b["cos_key"])
        self.assertTrue(hire_files._KEY_RE.match(a["cos_key"]))
        self.assertEqual(a["headers"], {"Content-Type": "application/pdf"})
        with self.assertRaisesRegex(ValueError, "too large"):
            hire_files.new_upload("big.mov", 500 * 1024 * 1024 + 1, "video/quicktime", presign=presign)
        hire_files.new_upload("ok.mov", 500 * 1024 * 1024, "video/quicktime", presign=presign)

    def test_no_cos_means_fallback(self):
        with mock.patch.object(hire_files.cos_media, "enabled", lambda: False):
            with self.assertRaises(hire_files.CosUnavailable):
                hire_files.new_upload("a.png", 10, "image/png")

    def test_resolve_ref_checks_object(self):
        got = hire_files.resolve_ref(
            {"cos_key": KEY, "name": "图.png", "mime": "image/png"},
            size_of=lambda k: 2048, presign_get=lambda k: f"https://cos.example/{k}?sign=get",
        )
        self.assertEqual(got, {"name": "图.png", "mime": "image/png", "size": 2048, "url": f"https://cos.example/{KEY}?sign=get"})
        with self.assertRaisesRegex(ValueError, "not uploaded"):
            hire_files.resolve_ref({"cos_key": KEY}, size_of=lambda k: None, presign_get=lambda k: "x")
        with self.assertRaisesRegex(ValueError, "too large"):
            hire_files.resolve_ref({"cos_key": KEY}, size_of=lambda k: hire_files.HIRE_FILE_MAX_BYTES + 1, presign_get=lambda k: "x")
        with self.assertRaisesRegex(ValueError, "invalid"):
            hire_files.resolve_ref({"cos_key": "agent-media/task_x/a.png"}, size_of=lambda k: 1, presign_get=lambda k: "x")

    def test_normalize_keeps_refs_and_base64(self):
        imgs = normalize_agent_images([{"cos_key": KEY, "name": "a.png", "mime": "image/png", "size": 9}, {"dataUrl": "data:image/png;base64,AAAA"}])
        self.assertEqual(imgs[0], {"cos_key": KEY, "name": "a.png", "mime": "image/png", "size": 9})
        self.assertTrue(imgs[1]["dataUrl"].startswith("data:image/png"))
        files = normalize_agent_files([{"cos_key": KEY.replace("a.png", "b.zip"), "name": "b.zip"}])
        self.assertTrue(files[0]["cos_key"].endswith("b.zip"))
        with self.assertRaisesRegex(ValueError, "invalid"):
            normalize_agent_files([{"cos_key": "secret/other-bucket-object"}])
        # 二次规范化不改引用
        self.assertEqual(normalize_agent_images(imgs[:1]), imgs[:1])


if __name__ == "__main__":
    unittest.main()
