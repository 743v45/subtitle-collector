#!/usr/bin/env python3
"""把 B 站 AI 字幕响应体（body.json）转换成文本字幕。

支持输出 SRT / VTT / TXT 三种格式，仅依赖标准库。

用法:
    python scripts/body2subtitle.py info/body.json                 # 默认 SRT
    python scripts/body2subtitle.py info/body.json -f vtt          # 输出 VTT
    python scripts/body2subtitle.py info/body.json -f txt          # 输出纯文本
    python scripts/body2subtitle.py info/body.json -o out.srt      # 指定输出路径
"""

import argparse
import json
import sys
from pathlib import Path

# 支持的输出格式
FORMATS = ("srt", "vtt", "txt")


def secs_to_stamp(seconds: float, sep: str) -> str:
    """秒（浮点）转成 'HH:MM:SS<sep>mmm' 时间戳。

    sep 为 ',' 时输出 SRT 时间戳（HH:MM:SS,mmm）；
    sep 为 '.' 时输出 VTT 时间戳（HH:MM:SS.mmm）。
    """
    if seconds < 0:
        seconds = 0.0
    total_ms = round(seconds * 1000)
    hours, rem = divmod(total_ms, 3600_000)
    minutes, rem = divmod(rem, 60_000)
    secs, ms = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}{sep}{ms:03d}"


def to_srt(body: list) -> str:
    blocks = []
    for idx, item in enumerate(body, start=1):
        start = secs_to_stamp(item["from"], ",")
        end = secs_to_stamp(item["to"], ",")
        content = item["content"].strip()
        blocks.append(f"{idx}\n{start} --> {end}\n{content}")
    return "\n\n".join(blocks) + "\n"


def to_vtt(body: list) -> str:
    blocks = ["WEBVTT", ""]
    for item in body:
        start = secs_to_stamp(item["from"], ".")
        end = secs_to_stamp(item["to"], ".")
        content = item["content"].strip()
        blocks.append(f"{start} --> {end}\n{content}")
    return "\n\n".join(blocks) + "\n"


def to_txt(body: list) -> str:
    lines = [item["content"].strip() for item in body if item["content"].strip()]
    return "\n".join(lines) + "\n"


def load_body(path: Path) -> list:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        sys.exit(f"错误：{path} 不是合法 JSON：{e}")
    body = data.get("body") if isinstance(data, dict) else None
    if not isinstance(body, list) or not body:
        sys.exit(f"错误：{path} 中未找到非空的 'body' 数组")
    # 校验每条记录的必要字段
    for i, item in enumerate(body):
        for key in ("from", "to", "content"):
            if key not in item:
                sys.exit(f"错误：body[{i}] 缺少字段 '{key}'")
    return body


def default_output(input_path: Path, fmt: str) -> Path:
    return input_path.with_suffix(f".{fmt}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="把 B 站 AI 字幕 body.json 转成 SRT/VTT/TXT"
    )
    parser.add_argument("input", type=Path, help="输入的 body.json 路径")
    parser.add_argument(
        "-f",
        "--format",
        choices=FORMATS,
        default="srt",
        help="输出格式（默认 srt）",
    )
    parser.add_argument(
        "-o", "--output", type=Path, default=None, help="输出路径（默认按格式换后缀）"
    )
    args = parser.parse_args()

    if not args.input.is_file():
        sys.exit(f"错误：找不到输入文件 {args.input}")

    body = load_body(args.input)
    output_path = args.output or default_output(args.input, args.format)

    if args.format == "srt":
        text = to_srt(body)
    elif args.format == "vtt":
        text = to_vtt(body)
    else:
        text = to_txt(body)

    output_path.write_text(text, encoding="utf-8")
    print(f"已写入 {output_path}（{args.format.upper()}，{len(body)} 条）")


if __name__ == "__main__":
    main()
