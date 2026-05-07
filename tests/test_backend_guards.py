from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "papermind"))

import api  # noqa: E402
import llm_router  # noqa: E402
import memory_service  # noqa: E402
import search_service  # noqa: E402


class HeaderRequest:
    def __init__(self, user_id: str = "test-user"):
        self.headers = {"X-User-ID": user_id}


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
            response = api.api_save_profile(payload, HeaderRequest("user-1"))

        self.assertEqual(response, {"ok": True})
        self.assertEqual(saved["user_id"], "user-1")
        self.assertEqual(saved["profile"]["memory_core"], "stable core")
        self.assertEqual(saved["profile"]["memory_recent"], "recent changes")
        self.assertEqual(saved["profile"]["behavior_events_since_recent"], "5")
        reset_cache.assert_not_called()


if __name__ == "__main__":
    unittest.main()
