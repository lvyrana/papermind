from __future__ import annotations

import sys
import tempfile
import unittest
import hashlib
import json
from pathlib import Path
from unittest.mock import patch


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

        self.assertIn("长期研究画像：长期关注 COPD。", context)
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

    def test_deleting_paper_removes_self_test_and_detaches_history(self):
        with tempfile.TemporaryDirectory() as temp_dir, \
             patch.object(database, "DB_PATH", Path(temp_dir) / "cleanup.db"):
            database.init_db()
            paper_id = database.save_paper({"title": "Cleanup paper"}, USER_A)
            database.init_self_test(paper_id)
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


if __name__ == "__main__":
    unittest.main()
