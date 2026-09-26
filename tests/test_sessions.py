"""CLI-level fixtures for the read-only OmO session collector."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "plugin" / "omo_sessions.py"


class SessionCollectorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.agent = root / "agent"
        self.tasks = root / "tasks"
        self.cwd = root / "project"
        self.cwd.mkdir()
        self.folder = self.agent / "sessions" / "--project--"
        self.folder.mkdir(parents=True)
        self.path = self.folder / "2026-09-26T00-00-00Z_abc-123.jsonl"

    def cli(self, *args):
        return subprocess.run(
            [sys.executable, "-B", str(SCRIPT), "--agent-dir", str(self.agent),
             "--task-dir", str(self.tasks), *args],
            capture_output=True, text=True, check=False, timeout=8,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )

    def write_session(self, *entries):
        header = {"type": "session", "version": 3, "id": "abc-123",
                  "cwd": str(self.cwd), "timestamp": "2026-09-26T00:00:00Z"}
        self.path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n"
                                     for row in (header, *entries)), encoding="utf-8")

    def listing(self):
        result = self.cli("list")
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_empty_roots_produce_stable_schema(self):
        self.assertEqual(self.listing(), {"schemaVersion": 1, "sessions": [], "error": None})

    def test_branch_counts_and_explicit_goal_are_independent_of_runtime(self):
        self.write_session(
            {"type": "message", "id": "a", "parentId": None, "timestamp": "2026-09-26T01:00:00Z",
             "message": {"role": "user", "content": "작업 세션"}},
            {"type": "custom", "id": "b", "parentId": "a", "customType": "senpi.todo-state",
             "data": {"schema": "v2", "phases": [{"name": "work", "tasks": [
                 {"content": "1", "status": "completed"}, {"content": "2", "status": "pending"},
                 {"content": "3", "status": "in_progress"}, {"content": "4", "status": "abandoned"}]}]}},
            {"type": "custom", "id": "fork", "parentId": "a", "customType": "senpi.todo-state",
             "data": {"todos": [{"content": "other branch", "status": "completed"}]}},
            {"type": "message", "id": "c", "parentId": "b", "message": {"role": "assistant"}},
        )
        goal_dir = self.folder / "extensions" / "goal"
        goal_dir.mkdir(parents=True)
        (goal_dir / "abc-123.json").write_text('{"version":1,"goal":{"status":"active"}}')
        ulw_dir = self.cwd / ".omo" / "ulw-loop" / "abc-123"
        ulw_dir.mkdir(parents=True)
        (ulw_dir / "goals.json").write_text(json.dumps({
            "activeGoalId": "g", "goals": [{"id": "g", "status": "in_progress",
                "successCriteria": [{"status": "passed"}, {"status": "pending"}]}]}))
        task_dir = self.tasks / "tasks"
        task_dir.mkdir(parents=True)
        (task_dir / "st_123.json").write_text(json.dumps({
            "parent_session_id": "abc-123", "status": "running"}))
        (task_dir / "st_456.json").write_text(json.dumps({
            "parent_session_id": "abc-123", "status": "completed"}))

        item = self.listing()["sessions"][0]
        self.assertEqual(item["title"], "작업 세션")
        self.assertEqual(item["activityAt"], "2026-09-26T01:00:00Z")
        self.assertEqual(item["todos"], {"completed": 1, "pending": 1,
                           "inProgress": 1, "abandoned": 1, "total": 4})
        self.assertEqual(item["goal"], {"status": "active"})
        self.assertEqual(item["ulw"], {"passed": 1, "total": 2, "status": "in_progress"})
        self.assertEqual(item["runningDelegatedTasks"], 1)
        self.assertEqual(item["runtime"]["kind"], "unknown")

    def test_latest_branch_todo_result_replaces_stale_completed_task(self):
        self.write_session(
            {"type": "custom", "id": "a", "parentId": None, "customType": "senpi.todo-state",
             "data": {"todos": [{"content": "old", "status": "in_progress"}]}},
            {"type": "message", "id": "b", "parentId": "a",
             "message": {"role": "toolResult", "toolName": "todo",
                         "details": {"schema": "v2", "phases": [{"name": "done", "tasks": [
                             {"content": "new", "status": "completed"}]}]}}},
        )
        item = self.listing()["sessions"][0]
        self.assertEqual(item["todos"]["completed"], 1)
        self.assertEqual(item["todos"]["inProgress"], 0)
        self.assertEqual(item["runtime"]["kind"], "unknown")

    def test_malformed_lines_and_truncated_tail_are_ignored(self):
        self.write_session({"type": "custom", "id": "a", "parentId": None,
                            "customType": "senpi.todo-state", "data": {
                                "todos": [{"content": "ok", "status": "completed"}]}})
        with self.path.open("a") as stream:
            stream.write("not json\n")
            stream.write('{"type":"custom","id":"partial"')
        item = self.listing()["sessions"][0]
        self.assertEqual(item["todos"]["total"], 1)
        self.assertIsNone(item["goal"])

    def test_cjk_title_and_view_output_are_bounded(self):
        self.write_session({"type": "message", "id": "a", "parentId": None,
                            "message": {"role": "user", "content": "한글" * 500 + "\x1b[31m"}})
        item = self.listing()["sessions"][0]
        self.assertLessEqual(len(item["title"]), 100)
        self.assertNotIn("\x1b", item["title"])
        result = self.cli("view", "--session", str(self.path))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("한글", result.stdout)
        self.assertLess(len(result.stdout.encode()), 2048)

    def test_path_escape_and_symlink_are_rejected(self):
        self.write_session()
        outside = Path(self.temp.name) / "elsewhere.jsonl"
        outside.write_text(self.path.read_text())
        link = self.folder / "linked.jsonl"
        link.symlink_to(outside)
        self.assertNotEqual(self.cli("view", "--session", str(outside)).returncode, 0)
        self.assertNotEqual(self.cli("view", "--session", str(link)).returncode, 0)
        self.assertEqual(len(self.listing()["sessions"]), 1)

    def test_oversize_and_many_sessions_are_capped(self):
        self.write_session()
        for number in range(30):
            candidate = self.folder / f"2026-09-25T{number:02d}-00-00Z_abc-{number}.jsonl"
            candidate.write_text(json.dumps({"type": "session", "version": 3,
                "id": f"abc-{number}", "cwd": str(self.cwd),
                "timestamp": "2026-09-25T00:00:00Z"}) + "\n")
        self.assertEqual(len(self.listing()["sessions"]), 12)
        with self.path.open("ab") as stream:
            stream.write(b"x" * (16 * 1024 * 1024 + 1))
        self.assertNotIn("abc-123", [s["id"] for s in self.listing()["sessions"]])


if __name__ == "__main__":
    unittest.main()
