from __future__ import annotations

import sys
import tempfile
import unittest
import base64
import hashlib
import json
from pathlib import Path
from unittest.mock import AsyncMock, patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "papermind"))

import api  # noqa: E402
import llm_router  # noqa: E402
import memory_service  # noqa: E402
import search_service  # noqa: E402
from src import database  # noqa: E402


USER_A = "11111111-1111-4111-8111-111111111111"
USER_B = "22222222-2222-4222-8222-222222222222"


class HeaderRequest:
    def __init__(self, user_id: str = USER_A, cookie_user_id: str = ""):
        self.headers = {"X-User-ID": user_id} if user_id else {}
        self.cookies = {"papermind-uid": cookie_user_id} if cookie_user_id else {}


class ZoteroPluginDistributionTests(unittest.TestCase):
    def test_update_manifest_matches_packaged_xpi(self):
        response = api.api_zotero_plugin_update()
        update = response["addons"]["papermind-connector@papermind.local"]["updates"][0]
        xpi_path = ROOT / "zotero-plugin" / "papermind-connector.xpi"
        plugin_manifest = json.loads(
            (ROOT / "zotero-plugin" / "manifest.json").read_text(encoding="utf-8")
        )

        self.assertEqual(update["version"], plugin_manifest["version"])
        self.assertEqual(
            update["update_hash"],
            "sha256:" + hashlib.sha256(xpi_path.read_bytes()).hexdigest(),
        )
        self.assertEqual(
            update["update_link"],
            "https://papermindapp.com/api/zotero-plugin/papermind-connector.xpi",
        )


class LLMRouterTests(unittest.IsolatedAsyncioTestCase):
    async def test_no_configured_provider_returns_empty_without_crashing(self):
        provider = {
            "name": "empty",
            "api_key": "",
            "base_url": "https://example.invalid",
            "model": "empty-model",
        }
        with patch.object(llm_router, "_get_llm_slots", return_value=[provider]):
            self.assertFalse(llm_router._has_llm_config(task="chat"))
            client, model = llm_router._get_llm_client(task="chat")
            self.assertIsNone(client)
            self.assertEqual(model, "")

            content, provider_name, provider_model = await llm_router._llm_chat_complete_async(
                [{"role": "user", "content": "ping"}],
                task="chat",
            )
            self.assertEqual((content, provider_name, provider_model), ("", "", ""))

    def test_ocr_task_only_keeps_vision_capable_models(self):
        providers = [
            {"name": "qwen", "api_key": "key", "base_url": "https://example.com", "model": "qwen3.5-ocr"},
            {"name": "qwen", "api_key": "key", "base_url": "https://example.com", "model": "qwen3.7-plus"},
            {"name": "qwen", "api_key": "key", "base_url": "https://example.com", "model": "qwen3.5-flash"},
            {"name": "deepseek", "api_key": "key", "base_url": "https://example.com", "model": "deepseek-chat"},
        ]
        with patch.object(llm_router, "_get_llm_slots", return_value=providers):
            models = [provider["model"] for provider in llm_router._ordered_llm_slots(task="ocr")]

        self.assertEqual(models, ["qwen3.5-ocr", "qwen3.7-plus"])

    def test_vision_model_aliases_match_verified_capabilities(self):
        cases = {
            "qwen3.7-max": False,
            "qwen3.7-max-2026-06-08": True,
            "qwen3.7-plus": True,
            "qwen3.5-ocr": True,
            "qwen-vl-ocr-latest": True,
            "qwen3.5-flash": False,
        }

        for model, expected in cases.items():
            with self.subTest(model=model):
                self.assertEqual(llm_router._supports_vision(model), expected)


class SelectionOcrTests(unittest.IsolatedAsyncioTestCase):
    def test_garbled_selection_detector_rejects_scrambled_font_text(self):
        self.assertTrue(api._looks_like_garbled_selection(
            r'W-XYZ[E\]^_`abcBCEdefg"OhijklmXnopqrEabcBCsAtuEvwBC'
        ))
        self.assertFalse(api._looks_like_garbled_selection(
            "采用监督微调和检索增强生成技术，提高模型回答的准确性。"
        ))
        self.assertFalse(api._looks_like_garbled_selection(
            "The model was evaluated in a prospective usability study."
        ))

    async def test_selection_ocr_sends_only_the_crop_to_a_vision_model(self):
        image = "data:image/jpeg;base64," + base64.b64encode(b"fake-image").decode()
        llm_call = AsyncMock(return_value=(
            "采用监督微调和检索增强生成技术。",
            "qwen",
            "qwen3.5-ocr",
        ))
        with patch.object(api, "_has_llm_config", return_value=True), \
             patch.object(api, "check_rate_limit", return_value=True), \
             patch.object(api, "increment_rate_limit"), \
             patch.object(api, "_llm_chat_complete_async", llm_call):
            result = await api.api_ocr_selection(
                api.OcrSelectionRequest(image_data_url=image),
                HeaderRequest(),
            )

        self.assertTrue(result["ok"])
        self.assertEqual(result["text"], "采用监督微调和检索增强生成技术。")
        kwargs = llm_call.await_args.kwargs
        self.assertEqual(kwargs["task"], "ocr")
        content = llm_call.await_args.args[0][0]["content"]
        self.assertEqual(content[0]["image_url"]["url"], image)
        self.assertIn("不要总结、改写、补充", content[1]["text"])

    async def test_page_ocr_uses_full_page_instruction_and_larger_output_budget(self):
        image = "data:image/jpeg;base64," + base64.b64encode(b"fake-page").decode()
        llm_call = AsyncMock(return_value=(
            "1 前言\n现有问答系统仍存在准确性不足。",
            "qwen",
            "qwen3.5-ocr",
        ))
        with patch.object(api, "_has_llm_config", return_value=True), \
             patch.object(api, "check_rate_limit", return_value=True), \
             patch.object(api, "increment_rate_limit"), \
             patch.object(api, "_llm_chat_complete_async", llm_call):
            result = await api.api_ocr_selection(
                api.OcrSelectionRequest(image_data_url=image, scope="page"),
                HeaderRequest(),
            )

        self.assertTrue(result["ok"])
        self.assertEqual(llm_call.await_args.kwargs["max_tokens"], 4000)
        prompt = llm_call.await_args.args[0][0]["content"][1]["text"]
        self.assertIn("这一页", prompt)
        self.assertIn("按阅读顺序", prompt)

    async def test_page_ocr_caches_text_only_for_an_owned_paper(self):
        image = "data:image/jpeg;base64," + base64.b64encode(b"fake-page").decode()
        llm_call = AsyncMock(return_value=(
            "2 前言\n现有问答系统仍存在准确性不足。",
            "qwen",
            "qwen3.5-ocr",
        ))
        with patch.object(api, "_get_owned_paper_or_none", return_value={"id": 4}), \
             patch.object(api, "_has_llm_config", return_value=True), \
             patch.object(api, "check_rate_limit", return_value=True), \
             patch.object(api, "increment_rate_limit"), \
             patch.object(api, "save_paper_page_ocr") as save_ocr, \
             patch.object(api, "_llm_chat_complete_async", llm_call):
            result = await api.api_ocr_selection(
                api.OcrSelectionRequest(
                    image_data_url=image,
                    scope="page",
                    paper_rowid=4,
                    page_number=2,
                ),
                HeaderRequest(),
            )

        self.assertTrue(result["ok"])
        save_ocr.assert_called_once_with(
            4,
            2,
            "2 前言\n现有问答系统仍存在准确性不足。",
            "qwen3.5-ocr",
        )

    def test_cached_ocr_pages_require_paper_ownership(self):
        with patch.object(api, "_get_owned_paper_or_none", return_value=None), \
             patch.object(api, "get_paper_page_ocr") as get_pages:
            result = api.api_get_paper_ocr_pages(4, HeaderRequest(USER_B))

        self.assertEqual(result, {"ok": False, "error": "not found"})
        get_pages.assert_not_called()

    async def test_card_draft_with_quote_excludes_abstract_and_forbids_added_facts(self):
        llm_call = AsyncMock(return_value=(
            '{"title":"训练流程","content":"采用监督微调和检索增强生成。"}',
            "qwen",
            "qwen3.7-plus",
        ))
        payload = api.DraftCardRequest(
            paper_title="护理证据智慧问答模型",
            paper_abstract="摘要中的 BLEU 和 Likert 不应进入这张卡。",
            quote="采用监督微调和检索增强生成技术，提高模型回答的准确性。",
            card_type="method",
            page=3,
        )
        with patch.object(api, "_has_llm_config", return_value=True), \
             patch.object(api, "check_rate_limit", return_value=True), \
             patch.object(api, "increment_rate_limit"), \
             patch.object(api, "get_profile", return_value={}), \
             patch.object(api, "_llm_chat_complete_async", llm_call):
            result = await api.api_draft_card(payload, HeaderRequest())

        self.assertTrue(result["ok"])
        system_prompt = llm_call.await_args.args[0][0]["content"]
        self.assertNotIn("摘要中的 BLEU", system_prompt)
        self.assertIn("只能概括该段原文", system_prompt)
        self.assertIn("不得从论文摘要", system_prompt)

    def test_card_create_rejects_garbled_quote_before_saving(self):
        payload = api.CreateCardRequest(
            paper_rowid=4,
            card_type="method",
            title="错误卡片",
            content="看似正常的内容",
            quote=r'W-XYZ[E\]^_`abcBCEdefg"OhijklmXnopqrEabcBCsAtuEvwBC',
            page=3,
            source="quote",
        )
        with patch.object(api, "_get_owned_paper_or_none", return_value={"id": 4}), \
             patch.object(api, "save_card") as save_card:
            result = api.api_create_card(payload, HeaderRequest())

        self.assertFalse(result["ok"])
        self.assertIn("无法可靠提取", result["error"])
        save_card.assert_not_called()

    def test_self_test_discards_garbled_page_and_quote_from_corpus(self):
        garbled = r'W-XYZ[E\]^_`abcBCEdefg"OhijklmXnopqrEabcBCsAtuEvwBC'
        with patch.object(api, "get_cards", return_value=[]), \
             patch.object(api, "get_quotes", return_value=[{"text": garbled, "page": 2}]), \
             patch.object(api, "get_or_create_board", return_value={"sections": []}), \
             patch.object(api, "get_board_items", return_value=[]):
            sources, corpus = api._build_source_context(
                4,
                "现有问答系统在准确性和可溯源性方面存在不足。",
                garbled,
            )

        self.assertNotIn(garbled, sources)
        self.assertNotIn(garbled, corpus)
        self.assertIn("准确性和可溯源性", corpus)

    def test_anchor_page_is_derived_from_verified_full_text(self):
        corpus = (
            "[第 1 页]\n摘要与关键词。\n\n"
            "[第 2 页]\n然而，通用的大语言模型在回答医学问题时准确性和可溯源性不足。\n\n"
            "[第 3 页]\n本研究采用监督微调和检索增强生成技术。"
        )

        self.assertEqual(
            api._find_anchor_page("回答医学问题时准确性和可溯源性不足", corpus),
            2,
        )
        self.assertIsNone(api._find_anchor_page("原文中不存在的句子", corpus))


class MemoryServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_update_memory_recent_skips_when_there_are_no_recent_signals(self):
        profile = {
            "memory_core": "stable core",
            "memory_recent": "",
            "behavior_events_since_recent": "3",
        }
        with patch.object(memory_service, "get_profile", return_value=profile), \
             patch.object(memory_service, "get_saved_titles_since", return_value=[]), \
             patch.object(memory_service, "get_all_recent_chats_since", return_value=[]), \
             patch.object(memory_service, "get_reading_history_since", return_value=[]), \
             patch.object(memory_service, "_llm_chat_complete_async") as llm_call:
            result = await memory_service.update_memory_recent("user-1")

        self.assertEqual(result, {
            "ok": True,
            "skipped": True,
            "reason": "no_recent_signals",
            "core_generated": False,
        })
        llm_call.assert_not_called()

    def test_build_memory_context_includes_core_and_recent(self):
        context = memory_service.build_memory_context({
            "memory_core": "长期关注 COPD。",
            "memory_recent": "最近关注肺康复。",
        })

        self.assertIn("阅读画像：长期关注 COPD。", context)
        self.assertIn("近期关注变化：最近关注肺康复。", context)


class SearchGuardTests(unittest.TestCase):
    def test_generated_queries_keep_focus_and_drop_generic_or_excluded_terms(self):
        profile = {
            "focus_areas": "COPD",
            "method_interests": "qualitative research",
            "exclude_areas": "动物实验",
        }

        sanitized, dropped = search_service._sanitize_generated_queries(
            [
                "COPD symptom burden",
                "qualitative research",
                "animal model COPD",
                "lung cancer prediction",
            ],
            profile,
        )

        self.assertEqual(sanitized, ["COPD symptom burden"])
        self.assertEqual(
            {item["query"]: item["reason"] for item in dropped},
            {
                "qualitative research": "missing_focus_anchor",
                "animal model COPD": "matches_exclude",
                "lung cancer prediction": "missing_focus_anchor",
            },
        )

    def test_exclude_terms_hard_filter_papers(self):
        exclude_terms = search_service._expand_exclude_terms(search_service._split_profile_terms("动物实验"))

        self.assertTrue(search_service._paper_matches_exclude({
            "title": "Mouse model of COPD inflammation",
            "abstract": "A murine experiment.",
            "publication_types": ["Journal Article"],
        }, exclude_terms))
        self.assertFalse(search_service._paper_matches_exclude({
            "title": "COPD self-management in older adults",
            "abstract": "Clinical cohort study with patient-reported outcomes.",
            "publication_types": ["Journal Article"],
        }, exclude_terms))

    def test_low_value_and_no_abstract_papers_are_rejected(self):
        self.assertTrue(search_service._is_low_value_publication({
            "title": "Reply to comments on COPD care",
            "abstract": "Short correspondence.",
            "publication_types": ["Journal Article"],
            "has_abstract": True,
        }))
        self.assertTrue(search_service._is_low_value_publication({
            "title": "COPD rehabilitation update",
            "abstract": "",
            "publication_types": ["Journal Article"],
            "has_abstract": False,
        }))
        self.assertFalse(search_service._is_low_value_publication({
            "title": "COPD rehabilitation and quality of life",
            "abstract": "This study evaluates pulmonary rehabilitation outcomes.",
            "publication_types": ["Journal Article"],
            "has_abstract": True,
        }))

    def test_fetch_and_rank_filters_before_returning_recommendations(self):
        profile = {
            "focus_areas": "COPD",
            "method_interests": "",
            "exclude_areas": "动物实验",
            "tracking_days": "90",
        }
        pubmed_results = [
            {
                "title": "COPD self-management in older adults",
                "abstract": "Clinical cohort study with patient outcomes.",
                "publication_types": ["Journal Article"],
                "has_abstract": True,
                "pub_date": "2026-04-01",
            },
            {
                "title": "COPD self-management in older adults",
                "abstract": "Duplicate title should be removed.",
                "publication_types": ["Journal Article"],
                "has_abstract": True,
                "pub_date": "2026-04-02",
            },
            {
                "title": "Mouse model of COPD inflammation",
                "abstract": "A murine animal model experiment.",
                "publication_types": ["Journal Article"],
                "has_abstract": True,
                "pub_date": "2026-04-01",
            },
            {
                "title": "COPD editorial note",
                "abstract": "",
                "publication_types": ["Editorial"],
                "has_abstract": False,
                "pub_date": "2026-04-01",
            },
        ]

        with patch.object(search_service, "_get_llm_client", return_value=(None, "")), \
             patch.object(search_service, "get_saved_titles", return_value=[]), \
             patch.object(search_service, "save_search_run", return_value=42), \
             patch.object(search_service, "pubmed_get_papers", return_value=pubmed_results):
            papers, trace = search_service.fetch_and_rank_papers(
                ["COPD"],
                days=3650,
                source="pubmed",
                profile=profile,
                user_id="user-1",
            )

        self.assertEqual([paper["title"] for paper in papers], ["COPD self-management in older adults"])
        self.assertEqual(trace["run_id"], 42)
        self.assertEqual(trace["totals"]["raw_papers"], 4)
        self.assertEqual(trace["totals"]["after_dedupe"], 3)
        self.assertEqual(trace["totals"]["after_low_value_filter"], 2)
        self.assertEqual(trace["totals"]["after_exclude_filter"], 1)
        self.assertEqual(trace["totals"]["final_papers"], 1)


class ProfileSaveTests(unittest.TestCase):
    def test_profile_save_preserves_backend_managed_memory_fields(self):
        previous = {
            "focus_areas": "COPD",
            "exclude_areas": "",
            "method_interests": "",
            "current_goal": "",
            "background": "",
            "discipline": "",
            "tracking_days": "90",
            "interests_summary": "old summary",
            "interests_summary_is_manual": "1",
            "interests_summary_updated_at": "2026-01-01T00:00:00",
            "behavior_events_since_summary": "3",
            "memory_core": "stable core",
            "memory_recent": "recent changes",
            "behavior_events_since_recent": "5",
            "last_recent_updated_at": "2026-01-02T00:00:00",
            "last_core_merged_at": "2026-01-03T00:00:00",
            "core_source": "auto",
        }
        saved = {}

        def capture_save(user_id, profile):
            saved["user_id"] = user_id
            saved["profile"] = profile

        payload = api.ProfileData(
            focus_areas="COPD",
            memory_core="malicious overwrite",
            memory_recent="malicious recent",
        )

        with patch.object(api, "get_profile", return_value=previous), \
             patch.object(api, "save_profile", side_effect=capture_save), \
             patch.object(api, "_reset_user_cache") as reset_cache:
            response = api.api_save_profile(payload, HeaderRequest(USER_A))

        self.assertEqual(response, {"ok": True})
        self.assertEqual(saved["user_id"], USER_A)
        self.assertEqual(saved["profile"]["memory_core"], "stable core")
        self.assertEqual(saved["profile"]["memory_recent"], "recent changes")
        self.assertEqual(saved["profile"]["behavior_events_since_recent"], "5")
        reset_cache.assert_not_called()


class DeviceIsolationTests(unittest.TestCase):
    def test_device_id_accepts_header_or_same_origin_cookie(self):
        self.assertEqual(api._get_user_id(HeaderRequest(USER_A)), USER_A)
        self.assertEqual(api._get_user_id(HeaderRequest("", USER_B)), USER_B)

    def test_missing_or_malformed_device_id_is_rejected(self):
        for request in (HeaderRequest(""), HeaderRequest("anonymous"), HeaderRequest("not-a-uuid")):
            with self.subTest(headers=request.headers):
                with self.assertRaises(api.FastAPIHTTPException) as raised:
                    api._get_user_id(request)
                self.assertEqual(raised.exception.status_code, 401)

    def test_server_configuration_is_owner_only(self):
        with patch.object(api, "OWNER_UID", USER_A):
            self.assertEqual(api._require_owner(HeaderRequest(USER_A)), USER_A)
            with self.assertRaises(api.FastAPIHTTPException) as raised:
                api._require_owner(HeaderRequest(USER_B))
            self.assertEqual(raised.exception.status_code, 403)

    def test_foreign_project_cannot_be_assigned_to_owned_paper(self):
        payload = api.SetPaperProjectRequest(project_id=22)
        with patch.object(api, "_get_owned_paper_or_none", return_value={"id": 7, "user_id": USER_A}), \
             patch.object(api, "get_projects", return_value=[{"id": 11}]), \
             patch.object(api, "set_paper_project") as setter:
            result = api.api_set_paper_project(7, payload, HeaderRequest(USER_A))

        self.assertEqual(result, {"ok": False, "error": "not found"})
        setter.assert_not_called()

    def test_note_edit_cannot_target_another_devices_note(self):
        payload = api.SaveNoteRequest(paper_rowid=7, content="changed", note_id=91)
        with patch.object(api, "_get_owned_paper_or_none", return_value={"id": 7, "user_id": USER_A}), \
             patch.object(api, "get_note_owner", return_value=USER_B), \
             patch.object(api, "save_note") as saver:
            result = api.api_save_note(payload, HeaderRequest(USER_A))

        self.assertEqual(result, {"ok": False, "error": "not found"})
        saver.assert_not_called()

    def test_foreign_paper_cannot_be_exported_or_added_to_history(self):
        with patch.object(api, "_get_owned_paper_or_none", return_value=None), \
             patch.object(api, "record_reading") as recorder:
            export = api.api_export_ris(7, HeaderRequest(USER_B))
            history = api.api_record_reading(
                {"paper_rowid": 7, "title": "Private paper"},
                HeaderRequest(USER_B),
            )

        self.assertEqual(export.status_code, 404)
        self.assertEqual(history, {"ok": False, "error": "not found"})
        recorder.assert_not_called()

    def test_same_title_is_stored_separately_for_two_devices(self):
        with tempfile.TemporaryDirectory() as temp_dir, \
             patch.object(database, "DB_PATH", Path(temp_dir) / "isolation.db"):
            database.init_db()
            first_id = database.save_paper({"title": "Shared title"}, USER_A)
            second_id = database.save_paper({"title": "Shared title"}, USER_B)

            self.assertNotEqual(first_id, second_id)
            self.assertEqual([paper["id"] for paper in database.get_saved_papers(USER_A)], [first_id])
            self.assertEqual([paper["id"] for paper in database.get_saved_papers(USER_B)], [second_id])

    def test_page_ocr_cache_upserts_and_returns_pages_in_order(self):
        with tempfile.TemporaryDirectory() as temp_dir, \
             patch.object(database, "DB_PATH", Path(temp_dir) / "ocr-cache.db"):
            database.init_db()
            paper_id = database.save_paper({"title": "OCR paper"}, USER_A)
            database.save_paper_page_ocr(paper_id, 2, "旧的第二页", "model-a")
            database.save_paper_page_ocr(paper_id, 1, "第一页", "model-a")
            database.save_paper_page_ocr(paper_id, 2, "新的第二页", "model-b")

            pages = database.get_paper_page_ocr(paper_id)

            self.assertEqual([page["page_number"] for page in pages], [1, 2])
            self.assertEqual(pages[1]["text"], "新的第二页")
            self.assertEqual(pages[1]["model"], "model-b")

    def test_deleting_paper_removes_self_test_and_detaches_history(self):
        with tempfile.TemporaryDirectory() as temp_dir, \
             patch.object(database, "DB_PATH", Path(temp_dir) / "cleanup.db"):
            database.init_db()
            paper_id = database.save_paper({"title": "Cleanup paper"}, USER_A)
            database.init_self_test(paper_id)
            database.save_paper_page_ocr(paper_id, 2, "缓存的第二页正文", "qwen3.5-ocr")
            database.record_reading(paper_id, "Cleanup paper", USER_A)
            database.record_method_gap(USER_A, "selection bias", paper_id)

            database.delete_saved_paper(paper_id)

            conn = database.get_conn()
            try:
                self.assertEqual(
                    conn.execute(
                        "SELECT COUNT(*) FROM self_test_sessions WHERE paper_rowid = ?",
                        (paper_id,),
                    ).fetchone()[0],
                    0,
                )
                self.assertEqual(
                    conn.execute(
                        "SELECT COUNT(*) FROM paper_page_ocr WHERE paper_rowid = ?",
                        (paper_id,),
                    ).fetchone()[0],
                    0,
                )
                self.assertIsNone(
                    conn.execute(
                        "SELECT paper_rowid FROM reading_history WHERE user_id = ?",
                        (USER_A,),
                    ).fetchone()[0]
                )
                self.assertIsNone(
                    conn.execute(
                        "SELECT last_paper_rowid FROM method_gaps WHERE user_id = ?",
                        (USER_A,),
                    ).fetchone()[0]
                )
            finally:
                conn.close()


class ExportFlagTests(unittest.TestCase):
    """「已导出」必须只反映真实导出，不能反映「打开过精读台」。

    汇报板行在 GET /api/board/{id} 时惰性创建，而精读台一打开就会调它。
    曾把 has_export 定义为 EXISTS(presentation_boards)，结果每篇打开过的论文
    都显示「已导出」。判定只认 saved_papers.last_exported_at。
    """

    def test_has_export_reads_last_exported_at_not_board_existence(self):
        source = (ROOT / "papermind" / "src" / "database.py").read_text(encoding="utf-8")
        start = source.index("def get_saved_papers")
        block = source[start:start + 1200]
        self.assertIn("last_exported_at", block,
                      "has_export 应由 last_exported_at 推导")
        self.assertNotIn("presentation_boards", block,
                         "has_export 不得由汇报板是否存在推导——打开精读台就会创建它")

    def test_export_endpoint_marks_exported(self):
        source = (ROOT / "papermind" / "api.py").read_text(encoding="utf-8")
        start = source.index("def api_export_board_marp")
        block = source[start:start + 900]
        self.assertIn("mark_exported(", block,
                      "导出接口必须调用 mark_exported，否则「已导出」永远不会亮")


if __name__ == "__main__":
    unittest.main()
