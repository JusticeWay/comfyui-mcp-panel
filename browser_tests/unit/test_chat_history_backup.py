"""Validation tests for the optional server-side chat-history backup."""

import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("comfyui_agent_panel_init", ROOT / "__init__.py")
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class ChatHistoryBackupTests(unittest.TestCase):
    def test_accepts_versioned_snapshot(self):
        raw = MODULE._validate_chat_history(
            {"schemaVersion": 2, "threads": [{"id": "one", "msgs": []}], "meta": {}}
        )
        self.assertIn(b'"schemaVersion":2', raw)

    def test_rejects_invalid_shapes(self):
        for payload in (
            None,
            [],
            {},
            {"threads": "not-an-array"},
            {"schemaVersion": 1, "threads": [], "meta": {}},
            {"schemaVersion": 2, "threads": [], "meta": []},
            {"schemaVersion": 2, "threads": [{}], "meta": {}},
            {"schemaVersion": 2, "threads": [{"id": "one", "msgs": ["bad"]}], "meta": {}},
        ):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                MODULE._validate_chat_history(payload)

    def test_rejects_duplicate_ids_and_unbounded_collections(self):
        with self.assertRaisesRegex(ValueError, "duplicate"):
            MODULE._validate_chat_history({
                "schemaVersion": 2,
                "threads": [{"id": "same"}, {"id": "same"}],
                "meta": {},
            })
        with self.assertRaisesRegex(ValueError, "too many threads"):
            MODULE._validate_chat_history({
                "schemaVersion": 2,
                "threads": [{"id": str(index)} for index in range(501)],
                "meta": {},
            })
        with self.assertRaisesRegex(ValueError, "too many messages"):
            MODULE._validate_chat_history({
                "schemaVersion": 2,
                "threads": [{"id": "one", "msgs": [{}] * 5001}],
                "meta": {},
            })

    def test_rejects_non_finite_tombstone_timestamps(self):
        with self.assertRaisesRegex(ValueError, "timestamp"):
            MODULE._validate_chat_history({
                "schemaVersion": 2,
                "threads": [],
                "meta": {"deletedThreads": {"one": float("inf")}},
            })

    def test_merge_preserves_concurrent_threads_and_honors_tombstones(self):
        merged = MODULE._merge_chat_history(
            {
                "schemaVersion": 2,
                "threads": [
                    {"id": "keep-a", "updatedAt": 10, "msgs": []},
                    {"id": "removed", "updatedAt": 20, "msgs": []},
                ],
                "meta": {},
            },
            {
                "schemaVersion": 2,
                "threads": [{"id": "keep-b", "updatedAt": 30, "msgs": []}],
                "meta": {"deletedThreads": {"removed": 40}},
            },
        )

        self.assertEqual({thread["id"] for thread in merged["threads"]}, {"keep-a", "keep-b"})
        self.assertEqual(merged["meta"]["deletedThreads"]["removed"], 40)

    def test_merge_unions_identified_messages_in_one_thread(self):
        merged = MODULE._merge_chat_history(
            {
                "threads": [{
                    "id": "shared",
                    "updatedAt": 20,
                    "msgs": [{"id": "a", "createdAt": 10, "text": "A"}],
                }],
                "meta": {},
            },
            {
                "threads": [{
                    "id": "shared",
                    "updatedAt": 30,
                    "msgs": [{"id": "b", "createdAt": 20, "text": "B"}],
                }],
                "meta": {},
            },
        )

        self.assertEqual([message["text"] for message in merged["threads"][0]["msgs"]], ["A", "B"])


if __name__ == "__main__":
    unittest.main()
