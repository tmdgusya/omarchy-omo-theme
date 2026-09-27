#!/usr/bin/env python3
"""Edit top-level JSON/JSONC properties without rewriting unrelated text."""

from __future__ import annotations

import argparse
import json
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import TypeAlias


Json: TypeAlias = None | bool | int | float | str | list["Json"] | dict[str, "Json"]


@dataclass(frozen=True, slots=True)
class Member:
    key: str
    key_start: int
    value_start: int
    value_end: int
    comma: int | None


class JsoncEditError(ValueError):
    """Raised when an input file is outside the supported JSONC contract."""


def skip_space_and_comments(text: str, start: int) -> int:
    index = start
    while index < len(text):
        if text[index].isspace():
            index += 1
        elif text.startswith("//", index):
            newline = text.find("\n", index + 2)
            index = len(text) if newline < 0 else newline + 1
        elif text.startswith("/*", index):
            end = text.find("*/", index + 2)
            if end < 0:
                raise JsoncEditError("unterminated JSONC block comment")
            index = end + 2
        else:
            break
    return index


def scan_string(text: str, start: int) -> int:
    index = start + 1
    escaped = False
    while index < len(text):
        char = text[index]
        if escaped:
            escaped = False
        elif char == "\\":
            escaped = True
        elif char == '"':
            return index + 1
        index += 1
    raise JsoncEditError("unterminated JSON string")


def scan_value(text: str, start: int) -> int:
    if text[start] == '"':
        return scan_string(text, start)
    if text[start] in "[{":
        opening = text[start]
        closing = "]" if opening == "[" else "}"
        depth = 1
        index = start + 1
        while index < len(text):
            if text[index] == '"':
                index = scan_string(text, index)
            elif text.startswith("//", index):
                index = skip_space_and_comments(text, index)
            elif text.startswith("/*", index):
                index = skip_space_and_comments(text, index)
            else:
                if text[index] == opening:
                    depth += 1
                elif text[index] == closing:
                    depth -= 1
                    if depth == 0:
                        return index + 1
                index += 1
        raise JsoncEditError("unterminated JSON container")
    index = start
    while index < len(text) and text[index] not in ",}\r\n\t ":
        index += 1
    return index


def members(text: str) -> tuple[list[Member], int]:
    start = skip_space_and_comments(text, 0)
    if start >= len(text) or text[start] != "{":
        raise JsoncEditError("settings must contain a top-level object")
    result: list[Member] = []
    index = start + 1
    while True:
        index = skip_space_and_comments(text, index)
        if index >= len(text):
            raise JsoncEditError("unterminated top-level object")
        if text[index] == "}":
            return result, index
        key_start = index
        if text[index] != '"':
            raise JsoncEditError("top-level property key must be a JSON string")
        key_end = scan_string(text, index)
        key = json.loads(text[index:key_end])
        if not isinstance(key, str):
            raise JsoncEditError("top-level property key must be a string")
        index = skip_space_and_comments(text, key_end)
        if index >= len(text) or text[index] != ":":
            raise JsoncEditError(f"missing colon after {key!r}")
        value_start = skip_space_and_comments(text, index + 1)
        value_end = scan_value(text, value_start)
        index = skip_space_and_comments(text, value_end)
        comma = index if index < len(text) and text[index] == "," else None
        result.append(Member(key, key_start, value_start, value_end, comma))
        if comma is not None:
            index += 1
            continue
        index = skip_space_and_comments(text, index)
        if index >= len(text) or text[index] != "}":
            raise JsoncEditError(f"missing comma after {key!r}")


def strip_jsonc(text: str) -> str:
    output: list[str] = []
    index = 0
    in_string = False
    escaped = False
    while index < len(text):
        char = text[index]
        if in_string:
            output.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            index += 1
        elif char == '"':
            in_string = True
            output.append(char)
            index += 1
        elif text.startswith("//", index):
            newline = text.find("\n", index + 2)
            if newline < 0:
                break
            output.append("\n")
            index = newline + 1
        elif text.startswith("/*", index):
            end = text.find("*/", index + 2)
            if end < 0:
                raise JsoncEditError("unterminated JSONC block comment")
            output.extend("\n" for char in text[index : end + 2] if char == "\n")
            index = end + 2
        else:
            output.append(char)
            index += 1
    return re.sub(r",(\s*[}\]])", r"\1", "".join(output))


def parse_object(text: str) -> dict[str, Json]:
    value = json.loads(strip_jsonc(text))
    if not isinstance(value, dict):
        raise JsoncEditError("settings must contain a top-level object")
    return value


def update(text: str, changes: dict[str, Json], removals: set[str]) -> str:
    found, closing = members(text)
    duplicate_keys = {item.key for item in found if sum(m.key == item.key for m in found) > 1}
    if duplicate_keys:
        raise JsoncEditError(f"duplicate top-level keys: {', '.join(sorted(duplicate_keys))}")
    by_key = {item.key: item for item in found}
    edits: list[tuple[int, int, str]] = []
    missing: list[tuple[str, Json]] = []
    for key, value in changes.items():
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        if key in by_key:
            item = by_key[key]
            edits.append((item.value_start, item.value_end, encoded))
        else:
            missing.append((key, value))
    if missing:
        prefix = text[:closing].rstrip()
        separator = "" if prefix.endswith(("{", ",")) else ","
        entries = ",\n".join(
            f'  {json.dumps(key, ensure_ascii=False)}: '
            f'{json.dumps(value, ensure_ascii=False, separators=(",", ":"))}'
            for key, value in missing
        )
        edits.append((closing, closing, f"{separator}\n{entries}\n"))
    for key in removals:
        item = by_key.get(key)
        if item is None:
            continue
        if item.comma is not None:
            edits.append((item.key_start, item.comma + 1, ""))
        else:
            prior = item.key_start - 1
            while prior >= 0 and text[prior].isspace():
                prior -= 1
            start = prior if prior >= 0 and text[prior] == "," else item.key_start
            edits.append((start, item.value_end, ""))
    for start, end, replacement in sorted(edits, reverse=True):
        text = text[:start] + replacement + text[end:]
    parse_object(text)
    return text


def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o600
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(text)
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("dump", "state", "merge", "remove"))
    parser.add_argument("path", type=Path)
    parser.add_argument("payload", nargs="?")
    args = parser.parse_args()
    text = args.path.read_text(encoding="utf-8") if args.path.exists() else "{}\n"
    current = parse_object(text)
    if args.operation == "dump":
        print(json.dumps(current, ensure_ascii=False, separators=(",", ":")))
        return 0
    if args.payload is None:
        parser.error(f"{args.operation} requires a JSON payload")
    payload = json.loads(args.payload)
    if args.operation == "state":
        if not isinstance(payload, list) or not all(isinstance(key, str) for key in payload):
            parser.error("state payload must be an array of keys")
        state = {key: {"exists": key in current, "value": current.get(key)} for key in payload}
        print(json.dumps(state, ensure_ascii=False, separators=(",", ":")))
        return 0
    if args.operation == "merge":
        if not isinstance(payload, dict):
            parser.error("merge payload must be an object")
        next_text = update(text, payload, set())
    else:
        if not isinstance(payload, list) or not all(isinstance(key, str) for key in payload):
            parser.error("remove payload must be an array of keys")
        next_text = update(text, {}, set(payload))
    atomic_write(args.path, next_text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
