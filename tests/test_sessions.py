"""CLI-level fixtures for the read-only OmO session collector."""

import json
import os
import select
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "plugin" / "omo_sessions.py"
EXTENSION = SCRIPT.with_name("omo-status.ts")

ADAPTER = """
import { createInterface } from "node:readline";
const handlers = new Map();
const ctx = { sessionManager: {
  getSessionId: () => process.env.TEST_SESSION_ID,
  getSessionFile: () => process.env.TEST_SESSION_FILE,
}};
const extension = await import(process.env.TEST_EXTENSION);
extension.default({ on: (name, handler) => handlers.set(name, handler) });
for await (const line of createInterface({ input: process.stdin })) {
  const event = JSON.parse(line);
  const handler = handlers.get(event.type);
  if (handler) await handler(event, ctx);
  process.stdout.write("DONE\\n");
}
"""


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
        self.runtime = root / "runtime"
        self.runtime.mkdir(mode=0o700)

    def cli(self, *args):
        return subprocess.run(
            [sys.executable, "-B", str(SCRIPT), "--agent-dir", str(self.agent),
             "--task-dir", str(self.tasks), *args],
            capture_output=True, text=True, check=False, timeout=8,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1",
                 "XDG_RUNTIME_DIR": str(self.runtime)},
        )

    def write_session(self, *entries, sid="abc-123", path=None):
        path = path or self.path
        header = {"type": "session", "version": 3, "id": sid,
                  "cwd": str(self.cwd), "timestamp": "2026-09-26T00:00:00Z"}
        path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n"
                                for row in (header, *entries)), encoding="utf-8")

    def adapter(self, sid="abc-123", path=None, lazy_file=False):
        process = subprocess.Popen(
            ["bun", "-e", ADAPTER], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True,
            env={**os.environ, "XDG_RUNTIME_DIR": str(self.runtime),
                 "TEST_SESSION_ID": sid,
                 "TEST_SESSION_FILE": "" if lazy_file else str(path or self.path),
                 "TEST_EXTENSION": str(EXTENSION)},
        )
        def cleanup():
            if process.poll() is None:
                process.terminate()
            process.communicate(timeout=4)
        self.addCleanup(cleanup)
        return process

    def emit(self, process, event):
        process.stdin.write(json.dumps({"type": event}) + "\n")
        process.stdin.flush()
        ready, _, _ = select.select([process.stdout], [], [], 4)
        self.assertTrue(ready, f"adapter failed: {process.poll()}")
        self.assertEqual(process.stdout.readline(), "DONE\n")

    def listing(self):
        result = self.cli("list")
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_empty_roots_produce_stable_schema(self):
        self.assertEqual(self.listing(), {"schemaVersion": 1, "sessions": [], "error": None})

    def test_session_without_todo_state_does_not_invent_progress(self):
        self.write_session()
        item = self.listing()["sessions"][0]
        self.assertIsNone(item["todos"])
        self.assertFalse(item["partial"])

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
                "successCriteria": [{"status": "pass"}, {"status": "pending"}]}]}))
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
        self.assertIn("abc-123", [s["id"] for s in self.listing()["sessions"]])

    def test_large_named_session_preserves_exact_branch_todos(self):
        self.write_session(
            {"type": "message", "id": "first", "parentId": None,
             "message": {"role": "user", "content": "<ultrawork-mode>scaffolding"}},
            {"type": "session_info", "id": "named", "parentId": "first",
             "name": "Current work"},
        )
        parent = "named"
        with self.path.open("a") as stream:
            for index in range(70):
                eid = f"body-{index}"
                stream.write(json.dumps({"type": "message", "id": eid, "parentId": parent,
                    "message": {"role": "toolResult", "toolName": "read",
                                "content": "x" * (260 * 1024)}}) + "\n")
                parent = eid
            stream.write(json.dumps({"type": "message", "id": "huge", "parentId": parent,
                "message": {"role": "toolResult", "toolName": "read",
                            "content": "x" * (2 * 1024 * 1024)}}) + "\n")
            stream.write(json.dumps({"type": "custom", "id": "branch", "parentId": "huge",
                "customType": "senpi.todo-state",
                "data": {"schema": "v2", "phases": [{"name": "work", "tasks": [
                    {"content": str(i), "status": "completed" if i < 6 else
                     "in_progress" if i == 6 else "pending"} for i in range(13)]}]}}) + "\n")
            stream.write(json.dumps({"type": "custom", "id": "fork", "parentId": "named",
                "customType": "senpi.todo-state",
                "data": {"todos": [{"content": "wrong", "status": "completed"}]}}) + "\n")
            stream.write(json.dumps({"type": "message", "id": "leaf", "parentId": "branch",
                "message": {"role": "assistant"}}) + "\n")
        self.assertGreater(self.path.stat().st_size, 16 * 1024 * 1024)
        item = self.listing()["sessions"][0]
        self.assertEqual(item["title"], "Current work")
        self.assertEqual(item["todos"], {"completed": 6, "pending": 6,
                         "inProgress": 1, "abandoned": 0, "total": 13})
        self.assertFalse(item["partial"])
        self.assertNotIn("x" * 100, json.dumps(item))

    def test_scan_limit_retains_header_without_inventing_todos(self):
        self.write_session({"type": "session_info", "id": "named", "parentId": None,
                            "name": "Bounded session"})
        with self.path.open("a") as stream:
            for index in range(70):
                stream.write(json.dumps({"type": "message", "id": f"row-{index}",
                    "parentId": "named", "message": {"role": "toolResult",
                    "toolName": "read", "content": "x" * (1024 * 1024)}}) + "\n")
        item = self.listing()["sessions"][0]
        self.assertEqual(item["title"], "Bounded session")
        self.assertIsNone(item["todos"])
        self.assertTrue(item["partial"])

    def test_task_registry_budget_preserves_collected_sessions(self):
        self.write_session()
        directory = self.tasks / "tasks"
        directory.mkdir(parents=True)
        for index in range(220):
            (directory / f"st_{index:08x}.json").write_text(json.dumps({
                "parent_session_id": "abc-123", "status": "running"}))
        result = self.listing()
        self.assertEqual(result["sessions"][0]["id"], "abc-123")
        self.assertEqual(result["error"], "scan limit reached")

    def test_live_waiting_idle_and_shutdown_follow_exact_events(self):
        self.write_session()
        process = self.adapter()
        self.emit(process, "session_start")
        self.assertEqual(self.listing()["sessions"][0]["runtime"]["status"], "idle")
        signal = self.runtime / "omo-session-state.changed"
        previous_signal = signal.read_text()
        self.emit(process, "agent_start")
        self.assertNotEqual(signal.read_text(), previous_signal)
        self.assertEqual(self.listing()["sessions"][0]["runtime"]["working"], True)
        self.emit(process, "ui_prompt_start")
        self.assertEqual(self.listing()["sessions"][0]["runtime"],
                         {"kind": "live", "working": False, "status": "waiting",
                          "evidence": "senpi extension and verified process"})
        self.emit(process, "ui_prompt_end")
        self.emit(process, "agent_end")
        self.assertTrue(self.listing()["sessions"][0]["runtime"]["working"])
        self.emit(process, "agent_settled")
        self.assertEqual(self.listing()["sessions"][0]["runtime"]["kind"], "idle")
        self.emit(process, "ui_prompt_start")
        self.assertEqual(self.listing()["sessions"][0]["runtime"]["status"], "waiting")
        self.emit(process, "ui_prompt_end")
        self.emit(process, "session_shutdown")
        self.assertEqual(self.listing()["sessions"][0]["runtime"]["kind"], "ended")

    def test_fresh_session_without_allocated_file_tracks_first_turn(self):
        self.write_session()
        process = self.adapter(lazy_file=True)
        self.emit(process, "session_start")
        self.emit(process, "agent_start")
        self.assertTrue(self.listing()["sessions"][0]["runtime"]["working"])

    def test_exited_process_and_reused_pid_never_remain_working(self):
        self.write_session()
        process = self.adapter()
        self.emit(process, "session_start")
        self.emit(process, "agent_start")
        state = self.runtime / "omo-session-state" / "abc-123.json"
        data = json.loads(state.read_text())
        data["processStart"] = str(int(data["processStart"]) + 1)
        state.write_text(json.dumps(data))
        self.assertEqual(self.listing()["sessions"][0]["runtime"]["kind"], "ended")
        state.write_text(json.dumps({**data, "processStart": str(int(data["processStart"]) - 1)}))
        self.assertTrue(self.listing()["sessions"][0]["runtime"]["working"])
        process.terminate()
        process.wait(timeout=4)
        self.assertEqual(self.listing()["sessions"][0]["runtime"]["kind"], "ended")

    def test_two_sessions_are_independent_and_untrusted_state_is_unknown(self):
        other = self.folder / "2026-09-26T01-00-00Z_def-456.jsonl"
        self.write_session()
        self.write_session(sid="def-456", path=other)
        first = self.adapter()
        second = self.adapter("def-456", other)
        self.emit(first, "session_start")
        self.emit(second, "session_start")
        self.emit(first, "agent_start")
        by_id = {item["id"]: item["runtime"] for item in self.listing()["sessions"]}
        self.assertTrue(by_id["abc-123"]["working"])
        self.assertEqual(by_id["def-456"]["kind"], "idle")
        state = self.runtime / "omo-session-state" / "abc-123.json"
        state.chmod(0o644)
        self.assertEqual({s["id"]: s["runtime"] for s in self.listing()["sessions"]}
                         ["abc-123"]["kind"], "unknown")
        state.chmod(0o600)
        state.unlink()
        state.symlink_to(self.runtime / "omo-session-state" / "def-456.json")
        self.assertEqual({s["id"]: s["runtime"] for s in self.listing()["sessions"]}
                         ["abc-123"]["kind"], "unknown")


if __name__ == "__main__":
    unittest.main()
