#!/usr/bin/env python3
"""Bounded, read-only snapshots of local OmO sessions."""

import argparse
import heapq
import json
import os
import re
import stat
import time
from contextlib import ExitStack
from pathlib import Path

SESSION_LIMIT = 12
CANDIDATE_LIMIT = 128
PATH_LIMIT = 2048
FILE_LIMIT = 192
BYTE_LIMIT = 96 * 1024 * 1024
SCAN_LIMIT = 512 * 1024 * 1024
JSON_BYTES = 256 * 1024
LINE_BYTES = 256 * 1024
ENTRY_LIMIT = 30000
OUTPUT_BYTES = 128 * 1024
SECONDS = 4
ID_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9-]{0,100}$")
CTRL = re.compile(r"[\x00-\x1f\x7f-\x9f]")
STATUSES = ("completed", "pending", "in_progress", "abandoned")
LARGE_RESULT = re.compile(
    rb'^\s*\{\s*"type"\s*:\s*"message"\s*,\s*"id"\s*:\s*"([^"\\]{1,120})"\s*,'
    rb'\s*"parentId"\s*:\s*(?:"([^"\\]{1,120})"|null)\s*,'
    rb'(?:\s*"timestamp"\s*:\s*"([^"\\]{1,40})"\s*,)?'
    rb'\s*"message"\s*:\s*\{\s*"role"\s*:\s*"toolResult"\s*,'
    rb'(?:\s*"toolCallId"\s*:\s*"[^"\\]{0,200}"\s*,)?'
    rb'\s*"toolName"\s*:\s*"([^"\\]{1,100})"')


def record(value):
    return value if isinstance(value, dict) else {}


def text(value, limit=100):
    if not isinstance(value, str):
        return ""
    return re.sub(r"\s+", " ", CTRL.sub(" ", value)).strip()[:limit]


class Budget:
    """Shared limits across a single CLI request."""

    def __init__(self):
        self.deadline = time.monotonic() + SECONDS
        self.paths = 0
        self.files = 0
        self.bytes = 0
        self.scanned = 0
        self.limited = False

    def check(self, size=0, path=False):
        if path:
            self.paths += 1
        else:
            self.files += 1
            self.bytes += size
        ok = (time.monotonic() < self.deadline and self.paths <= PATH_LIMIT
              and self.files <= FILE_LIMIT and self.bytes <= BYTE_LIMIT)
        self.limited |= not ok
        return ok


def safe_file(path, root):
    """Reject symlinks in every component, including the named file."""
    path = Path(os.path.abspath(path))
    root = Path(os.path.abspath(root))
    try:
        parts = path.relative_to(root).parts
        if not parts or root.is_symlink():
            return False
        current = root
        for part in parts:
            current /= part
            if stat.S_ISLNK(current.lstat().st_mode):
                return False
        return stat.S_ISREG(path.stat().st_mode)
    except (OSError, ValueError):
        return False


def read_bytes(path, root, budget, limit, owner=None):
    if not safe_file(path, root):
        return None
    try:
        with ExitStack() as stack:
            directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            stack.callback(os.close, directory)
            parts = Path(path).relative_to(root).parts
            for part in parts[:-1]:
                directory = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                    dir_fd=directory)
                stack.callback(os.close, directory)
            fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                         dir_fd=directory)
            with os.fdopen(fd, "rb") as stream:
                before = os.fstat(stream.fileno())
                if (not stat.S_ISREG(before.st_mode) or before.st_size > limit
                        or (owner is not None and
                            (before.st_uid != owner or before.st_mode & 0o077))):
                    budget.limited |= before.st_size > limit
                    return None
                if not budget.check(before.st_size):
                    return None
                data = stream.read(limit + 1)
                after = os.fstat(stream.fileno())
        if (len(data) > limit or before.st_size != after.st_size
                or before.st_mtime_ns != after.st_mtime_ns):
            budget.limited = True
            return None
        return data
    except OSError:
        return None


def read_json(path, root, budget):
    raw = read_bytes(path, root, budget, JSON_BYTES)
    if raw is None:
        return {}
    try:
        return record(json.loads(raw))
    except (ValueError, UnicodeDecodeError, RecursionError):
        return {}


def count_todos(data):
    phases = data.get("phases")
    tasks = data.get("todos")
    if isinstance(phases, list):
        tasks = []
        for phase in phases:
            items = record(phase).get("tasks")
            if not isinstance(items, list) or not isinstance(record(phase).get("name"), str):
                return None
            tasks.extend(items)
    if not isinstance(tasks, list):
        return None
    counts = dict.fromkeys(STATUSES, 0)
    for item in tasks:
        item = record(item)
        if not isinstance(item.get("content"), str):
            return None
        status = item.get("status")
        if status == "cancelled":
            status = "abandoned"
        elif status not in STATUSES:
            if isinstance(phases, list):
                return None
            status = "pending"
        counts[status] += 1
    return {"completed": counts["completed"], "pending": counts["pending"],
            "inProgress": counts["in_progress"], "abandoned": counts["abandoned"],
            "total": len(tasks)}


def runtime_state(sid, budget):
    unknown = {"kind": "unknown", "working": False, "status": "unknown",
               "evidence": "no verified session process"}
    runtime = os.environ.get("XDG_RUNTIME_DIR")
    if not runtime or not os.path.isabs(runtime):
        return unknown
    root = Path(runtime) / "omo-session-state"
    try:
        uid = os.getuid()
        for directory in (Path(runtime), root):
            info = directory.lstat()
            if (not stat.S_ISDIR(info.st_mode) or info.st_uid != uid
                    or info.st_mode & 0o077):
                return unknown
        raw = read_bytes(root / (sid + ".json"), root, budget, 1024, owner=uid)
        if raw is None:
            return unknown
        data = record(json.loads(raw))
        pid = data.get("pid")
        start = data.get("processStart")
        state = data.get("state")
        if (data.get("version") != 1 or data.get("sessionId") != sid
                or type(pid) is not int or pid < 1 or not isinstance(start, str)
                or not start.isascii() or not start.isdecimal()
                or state not in ("live", "idle", "ended")
                or type(data.get("waiting")) is not bool):
            return unknown
        if state == "ended":
            return {"kind": "ended", "working": False, "status": "ended",
                    "evidence": "session_shutdown"}
        proc = Path("/proc") / str(pid)
        if proc.stat().st_uid != uid:
            return unknown
        fields = (proc / "stat").read_text().rsplit(") ", 1)[1].split()
        alive = fields[0] not in ("Z", "X") and fields[19] == start
        if not alive:
            return {"kind": "ended", "working": False, "status": "ended",
                    "evidence": "session process exited"}
        waiting = data["waiting"]
        return {"kind": state, "working": state == "live" and not waiting,
                "status": "waiting" if waiting else ("working" if state == "live" else "idle"),
                "evidence": "senpi extension and verified process"}
    except FileNotFoundError:
        # The state file was verified, but its process disappeared.
        return ({"kind": "ended", "working": False, "status": "ended",
                 "evidence": "session process exited"} if "data" in locals() else unknown)
    except (OSError, ValueError, IndexError, UnicodeDecodeError, RecursionError):
        return unknown


def session(path, root, agent_dir, budget):
    if not safe_file(path, root):
        return None
    entries = {}
    leaf = None
    header = None
    title = ""
    named = False
    activity = ""
    partial = False
    try:
        with ExitStack() as stack:
            directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            stack.callback(os.close, directory)
            parts = path.relative_to(root).parts
            for part in parts[:-1]:
                directory = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                    dir_fd=directory)
                stack.callback(os.close, directory)
            fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                         dir_fd=directory)
            with os.fdopen(fd, "rb") as stream:
                before = os.fstat(stream.fileno())
                if not stat.S_ISREG(before.st_mode) or not budget.check():
                    return None
                while len(entries) < ENTRY_LIMIT:
                    if (time.monotonic() >= budget.deadline or budget.bytes >= BYTE_LIMIT
                            or budget.scanned >= SCAN_LIMIT):
                        partial = True
                        budget.limited = True
                        break
                    line = stream.readline(min(LINE_BYTES + 1, SCAN_LIMIT - budget.scanned))
                    if not line:
                        break
                    budget.scanned += len(line)
                    if not line.endswith(b"\n"):
                        prefix = line
                        while line and not line.endswith(b"\n"):
                            if (time.monotonic() >= budget.deadline
                                    or budget.scanned >= SCAN_LIMIT):
                                break
                            line = stream.readline(min(LINE_BYTES, SCAN_LIMIT - budget.scanned))
                            budget.scanned += len(line)
                        if not line.endswith(b"\n"):
                            if stream.tell() < before.st_size:
                                partial = True
                                budget.limited = True
                            break
                        match = LARGE_RESULT.match(prefix)
                        if header is None or match is None or match[4] in (b"todo", b"todowrite"):
                            partial = True
                            continue
                        if budget.bytes + match.end() > BYTE_LIMIT:
                            partial = True
                            budget.limited = True
                            break
                        budget.bytes += match.end()
                        entry = {"type": "message", "id": match[1].decode(),
                                 "parentId": match[2].decode() if match[2] else None,
                                 "timestamp": match[3].decode() if match[3] else "",
                                 "message": {"role": "toolResult", "toolName": match[4].decode()}}
                    else:
                        if budget.bytes + len(line) > BYTE_LIMIT:
                            partial = True
                            budget.limited = True
                            break
                        budget.bytes += len(line)
                        try:
                            entry = record(json.loads(line))
                        except (ValueError, UnicodeDecodeError, RecursionError):
                            continue
                    if header is None:
                        if (entry.get("type") != "session" or entry.get("version") != 3
                                or not ID_RE.fullmatch(str(entry.get("id", "")))
                                or not path.name.endswith("_" + entry["id"] + ".jsonl")
                                or not isinstance(entry.get("cwd"), str)
                                or not os.path.isabs(entry["cwd"])):
                            return None
                        header = entry
                        activity = text(entry.get("timestamp"), 40)
                        continue
                    eid = entry.get("id")
                    if not isinstance(eid, str) or not eid or len(eid) > 120:
                        continue
                    parent = entry.get("parentId")
                    payload = None
                    if entry.get("type") == "custom" and entry.get("customType") == "senpi.todo-state":
                        payload = record(entry.get("data"))
                    elif entry.get("type") == "message":
                        message = record(entry.get("message"))
                        if message.get("role") in ("user", "assistant"):
                            activity = text(entry.get("timestamp"), 40) or activity
                        if not named and not title and message.get("role") == "user":
                            content = message.get("content")
                            if isinstance(content, str):
                                title = text(content)
                            elif isinstance(content, list):
                                title = next((text(record(part).get("text")) for part in content
                                              if text(record(part).get("text"))), "")
                        if message.get("role") == "toolResult" and message.get("toolName") in ("todo", "todowrite"):
                            payload = record(message.get("details"))
                    if entry.get("type") == "session_info":
                        name = text(entry.get("name"))
                        if name:
                            title = name
                            named = True
                    entries[eid] = (parent, count_todos(payload) if payload is not None else None)
                    leaf = eid
                if stream.tell() < before.st_size:
                    partial = True
                    budget.limited = True
                after = os.fstat(stream.fileno())
                if before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns:
                    partial = True
    except (OSError, ValueError):
        return None
    if header is None:
        return None
    lineage = set()
    while leaf in entries and leaf not in lineage:
        lineage.add(leaf)
        parent = entries[leaf][0]
        leaf = parent if isinstance(parent, str) else None
    todos = None
    if not partial and leaf is None:
        for eid in reversed(tuple(entries)):
            if eid in lineage and entries[eid][1] is not None:
                todos = entries[eid][1]
                break
    elif leaf is not None:
        todos = None
        partial = True
    sid = header["id"]
    goal_data = read_json(path.parent / "extensions" / "goal" / (sid + ".json"), root, budget)
    goal_status = record(goal_data.get("goal")).get("status")
    goal = {"status": goal_status} if goal_status in ("active", "paused", "blocked", "complete") else None
    ulw_path = Path(header["cwd"]) / ".omo" / "ulw-loop" / sid / "goals.json"
    ulw_data = read_json(ulw_path, header["cwd"], budget)
    goals = ulw_data.get("goals")
    selected = {}
    if isinstance(goals, list):
        selected = next((record(g) for g in goals if record(g).get("id") == ulw_data.get("activeGoalId")), {})
    criteria = selected.get("successCriteria")
    ulw = None
    if isinstance(criteria, list):
        ulw = {"passed": sum(record(c).get("status") == "pass" for c in criteria),
               "total": len(criteria), "status": text(selected.get("status"), 32)}
    return {"id": sid, "cwdLabel": text(Path(header["cwd"]).name or "/", 48),
            "title": title or "Untitled", "activityAt": activity,
            "runtime": runtime_state(sid, budget),
            "todos": todos, "partial": partial, "ulw": ulw, "goal": goal,
            "runningDelegatedTasks": 0, "sessionPath": str(path), "cwd": header["cwd"]}


def candidates(root, budget):
    heap = []
    try:
        with os.scandir(root) as dirs:
            for directory in dirs:
                if not budget.check(path=True):
                    break
                if directory.is_symlink() or not directory.is_dir(follow_symlinks=False):
                    continue
                try:
                    with os.scandir(directory.path) as files:
                        for file in files:
                            if not budget.check(path=True):
                                break
                            if (not file.name.endswith(".jsonl") or file.is_symlink()
                                    or not file.is_file(follow_symlinks=False)):
                                continue
                            item = (file.name, file.path)
                            if len(heap) < CANDIDATE_LIMIT:
                                heapq.heappush(heap, item)
                            elif item > heap[0]:
                                heapq.heapreplace(heap, item)
                except OSError:
                    continue
    except OSError:
        return []
    return [Path(path) for _, path in sorted(heap, reverse=True)]


def list_sessions(agent_dir, task_dir):
    budget = Budget()
    root = agent_dir / "sessions"
    sessions = []
    for path in candidates(root, budget):
        if len(sessions) >= SESSION_LIMIT or time.monotonic() >= budget.deadline:
            break
        item = session(path, root, agent_dir, budget)
        if item:
            sessions.append(item)
    by_id = {item["id"]: item for item in sessions}
    try:
        with os.scandir(task_dir / "tasks") as files:
            for file in files:
                if not budget.check(path=True):
                    break
                if not re.fullmatch(r"st_[a-f0-9]+\.json", file.name):
                    continue
                task = read_json(Path(file.path), task_dir, budget)
                parent = by_id.get(task.get("parent_session_id"))
                if parent and task.get("status") == "running":
                    parent["runningDelegatedTasks"] += 1
    except OSError:
        pass
    result = {"schemaVersion": 1, "sessions": sessions, "error": "scan limit reached" if budget.limited else None}
    while len(json.dumps(result, ensure_ascii=False).encode()) > OUTPUT_BYTES and sessions:
        sessions.pop()
        result["error"] = "output limit reached"
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agent-dir", type=Path, default=Path(os.environ.get(
        "SENPI_CODING_AGENT_DIR") or os.environ.get("OMO_CODING_AGENT_DIR") or Path.home() / ".omo/agent"))
    parser.add_argument("--task-dir", type=Path, default=Path.home() / ".omo/senpi-task")
    command = parser.add_subparsers(dest="command", required=True)
    command.add_parser("list")
    view = command.add_parser("view")
    view.add_argument("--session", required=True)
    args = parser.parse_args()
    if args.command == "list":
        print(json.dumps(list_sessions(args.agent_dir, args.task_dir), ensure_ascii=False))
        return
    path = Path(os.path.abspath(args.session))
    root = Path(os.path.abspath(args.agent_dir / "sessions"))
    if not safe_file(path, root) or path.suffix != ".jsonl":
        parser.error("session path outside the configured session root")
    budget = Budget()
    item = session(path, root, args.agent_dir, budget)
    if item is None:
        parser.error("invalid or oversized session")
    todos = item["todos"]
    todo_summary = (f"{todos['completed']}/{todos['total']} completed"
                    if todos is not None else "not available")
    goal_summary = item["goal"]["status"] if item["goal"] else "none"
    ulw = item["ulw"]
    ulw_summary = (f"{ulw['passed']}/{ulw['total']} verified ({ulw['status']})"
                   if ulw else "none")
    print(f"Session: {item['id']}\nTitle: {item['title']}\n"
          f"Directory: {text(item['cwd'], 256)}\nActivity: {item['activityAt']}\n"
          f"Runtime: {item['runtime']['status']}\nTodos: {todo_summary}\n"
          f"Goal: {goal_summary}\nULW: {ulw_summary}")
    if item["partial"]:
        print("Some session data could not be read completely.")


if __name__ == "__main__":
    main()
