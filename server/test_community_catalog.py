# server/test_community_catalog.py
# 仅覆盖纯函数 / 默认 YAML 装配，不依赖 PostgreSQL。
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
import unittest
import community_catalog as cc


class TestDefaultDoc(unittest.TestCase):
    def test_default_doc_has_four_sections(self):
        doc = cc.load_default_doc()
        for key in ("mcp", "prompts", "skills", "assistants"):
            self.assertIsInstance(doc[key], list, f"{key} must be a list")

    def test_mcp_reuses_client_catalog_with_builtin(self):
        doc = cc.load_default_doc()
        ids = {m.get("catalog_id") or m.get("id") for m in doc["mcp"]}
        self.assertIn("tokenbank-agent-bridge", ids)
        self.assertIn("tokenbank-prompts", ids)
        self.assertIn("pipeworx", ids)

    def test_resources_seeded_from_yaml(self):
        doc = cc.load_default_doc()
        prompt_names = {p["name"] for p in doc["prompts"]}
        skill_names = {s["name"] for s in doc["skills"]}
        assistant_names = {a["name"] for a in doc["assistants"]}
        # 原始种子条目必须仍在（新增社区推荐后集合会更大，故用成员判断）
        self.assertIn("code-review", prompt_names)
        self.assertLessEqual({"git-commit", "systematic-debugging"}, skill_names)
        self.assertIn("python-expert", assistant_names)
        # 扩充后的默认推荐规模（≥50，均匀分布）
        self.assertGreaterEqual(len(prompt_names) + len(skill_names) + len(assistant_names), 50)

    def test_normalize_fills_missing_sections(self):
        out = cc.normalize_catalog_doc({"mcp": [{"catalog_id": "x"}]})
        self.assertEqual(out["prompts"], [])
        self.assertEqual(out["skills"], [])
        self.assertEqual(out["assistants"], [])
        self.assertEqual(out["version"], 1)

    def test_payload_from_doc_roundtrip(self):
        payload = cc.catalog_payload_from_doc(cc.load_default_doc())
        self.assertIn("code-review", {p["name"] for p in payload["prompts"]})

    def test_public_payload_keeps_skill_files(self):
        # 公开目录下发整条 metadata，配套文件不能在过滤下架项时被剥掉
        files = [
            {"path": "references/core/style.md", "content": "# style\n"},
            {"path": "assets/icon.bin", "content": "aGVsbG8=", "encoding": "base64"},
        ]
        doc = {
            "version": 1,
            "skills": [{
                "catalog_id": "pkg-skill",
                "name": "pkg-skill",
                "content": "# skill\n",
                "metadata": {"enabled": True, "files": files, "tags": ["draw"]},
            }],
        }
        pub = cc.catalog_payload_from_doc(doc, public=True)
        self.assertEqual(pub["skills"][0]["content"], "# skill\n")
        self.assertEqual(pub["skills"][0]["metadata"]["files"], files)
        self.assertEqual(pub["skills"][0]["metadata"]["tags"], ["draw"])

    def test_public_payload_hides_disabled(self):
        doc = {
            "version": 1,
            "skills": [
                {"catalog_id": "a", "name": "a", "metadata": {"enabled": True}},
                {"catalog_id": "b", "name": "b", "metadata": {"enabled": False}},
                {"catalog_id": "c", "name": "c"},
            ],
        }
        pub = cc.catalog_payload_from_doc(doc, public=True)
        ids = {s.get("catalog_id") for s in pub["skills"]}
        self.assertIn("a", ids)
        self.assertIn("c", ids)
        self.assertNotIn("b", ids)

    def test_repeat_push_matches_own_item_by_name(self):
        bucket = [
            {
                "catalog_id": "user-skill-7-old-slug",
                "name": "handdraw-style-prompter",
                "metadata": {"user_recommended": True, "recommender_user_id": 7, "enabled": True},
            },
            {
                "catalog_id": "user-skill-8-handdraw-style-prompter",
                "name": "handdraw-style-prompter",
                "metadata": {"user_recommended": True, "recommender_user_id": 8},
            },
        ]
        # 同名但 catalog_id 变了：命中自己的旧条目，不碰别人的
        hit = cc._own_recommendation_index(
            bucket, "user-skill-7-handdraw-style-prompter", 7, "handdraw-style-prompter",
        )
        self.assertEqual(hit, 0)
        other = cc._own_recommendation_index(
            bucket, "user-skill-9-handdraw-style-prompter", 9, "handdraw-style-prompter",
        )
        self.assertIsNone(other)

    def test_public_resources_include_listed_at(self):
        doc = {
            "version": 1,
            "prompts": [],
            "skills": [{
                "catalog_id": "user-skill-1-draw",
                "name": "draw",
                "display_name": "画画",
                "metadata": {"user_recommended": True, "recommended_at": 1_700_000_000_000},
            }],
            "assistants": [{
                "catalog_id": "python-expert",
                "name": "python-expert",
                "display_name": "Python 专家",
            }],
        }
        rows = {r["catalog_id"]: r for r in cc.flatten_public_resources(doc)}
        self.assertEqual(rows["user-skill-1-draw"]["listed_at"], 1_700_000_000_000)
        self.assertNotIn("detail", rows["user-skill-1-draw"])
        self.assertGreater(rows["python-expert"]["listed_at"], 0)
        self.assertEqual(cc.listed_at_ms({"metadata": {"recommended_at": 1_700_000_000}}), 1_700_000_000_000)

    def test_detail_keeps_card_summary(self):
        skill = {
            "catalog_id": "git-commit-skill",
            "type": "skill",
            "name": "git-commit",
            "description": "生成规范提交信息",
            "content": "---\nname: git-commit\ndescription: x\n---\n\n# Git\n\n## 何时使用\n写 commit 时。\n",
        }
        prompt = {
            "catalog_id": "polish-prompt",
            "type": "prompt",
            "name": "polish",
            "description": "润色文字",
            "content": "请润色：{{text}}",
        }
        assistant = {
            "catalog_id": "coach-assistant",
            "type": "assistant",
            "name": "coach",
            "description": "写作教练",
            "content": '{"soul":"你是写作教练","skills":["proofreader"],"prompts":["text-polish"]}',
        }
        authored = {
            "catalog_id": "fast-skill",
            "type": "skill",
            "name": "fast",
            "description": "一句简介",
            "metadata": {"detail": "特点：快。\n用法：纳管后说一声。"},
            "content": "ignored",
        }
        self.assertIn("何时使用", cc.resource_detail(skill))
        self.assertNotIn("---", cc.resource_detail(skill))
        self.assertIn("{{text}}", cc.resource_detail(prompt))
        self.assertIn("润色文字", cc.resource_detail(prompt))
        self.assertIn("写作教练", cc.resource_detail(assistant))
        self.assertIn("proofreader", cc.resource_detail(assistant))
        self.assertEqual(cc.resource_detail(authored), "特点：快。\n用法：纳管后说一声。")
        rows = {r["name"]: r for r in cc.flatten_public_resources({
            "version": 1, "prompts": [prompt], "skills": [skill, authored], "assistants": [assistant],
        })}
        self.assertEqual(rows["git-commit"]["description"], "生成规范提交信息")
        self.assertIn("何时使用", rows["git-commit"]["detail"])
        self.assertEqual(rows["fast"]["description"], "一句简介")
        self.assertIn("纳管后说一声", rows["fast"]["detail"])

    def test_slug_and_paid_flag(self):
        self.assertEqual(cc._slug_name("Hello World!"), "hello-world")
        paid = {"metadata": {"user_recommended": True, "recommender_user_id": 3}}
        free = {"metadata": {"builtin": True}}
        self.assertTrue(cc.is_paid_community_item(paid))
        self.assertFalse(cc.is_paid_community_item(free))

    def test_extract_description_from_prompt_content(self):
        # 推荐无说明时，从提示词正文提炼首句
        content = "你是小黑，一只聪明的黑猫助手。请用简洁口吻回答用户问题。"
        desc = cc._extract_description_from_content("prompt", content, "小黑")
        self.assertTrue(desc)
        self.assertIn("小黑", desc)
        self.assertNotEqual(desc, "—")

    def test_extract_description_from_multiline_skill_frontmatter(self):
        content = (
            "---\nname: ai-image-prompts-skill\ndescription: |\n"
            "  Recommend curated prompts from a 10,000+ library.\n"
            "  Works with any image model.\n\n"
            "  Use this skill when users want to:\n"
            "  - Find prompts\n---\n\nYou are an expert.\n"
        )
        desc = cc._extract_description_from_content("skill", content, "ai-image-prompts-skill")
        self.assertIn("Recommend curated prompts", desc)
        self.assertNotIn("|", desc)
        self.assertNotIn("Find prompts", desc)
        # 推荐时若客户端把块标记当说明传来，应改用正文里的真介绍
        fixed = "| "
        self.assertTrue(cc._is_blank_desc(fixed.strip()))

    def test_extract_description_from_skill_frontmatter_body(self):
        content = "---\nname: html2app\n---\n\n# html2app\n\nPackage a local site into an Electron app.\n\n## Steps\n- clone\n"
        desc = cc._extract_description_from_content("skill", content, "html2app")
        self.assertIn("Electron", desc)


if __name__ == "__main__":
    unittest.main()
