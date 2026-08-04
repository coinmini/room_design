"""批 2 (A1) 端到端真实验证：真实 provider 跑一次 3 变体色调方案。

验证点：
1. 并发：3 张图总耗时接近单张（60-120s），而非串行 3-5 分钟；
2. 增量发布：RUNNING 期间轮询任务，outputs 数量应逐步增长；
3. 终态 SUCCEEDED 且 outputs 为 3 张。

需要 API 已在 127.0.0.1:8000 运行。
"""

from __future__ import annotations

import json
import sys
import time
import urllib.request

import psycopg

API = "http://127.0.0.1:8000/v1"
BOUNDARY = "----smoke-boundary"


def build_multipart(fields: dict[str, str], file_field: str, file_path: str) -> tuple[bytes, str]:
    body = bytearray()
    for name, value in fields.items():
        body += f'--{BOUNDARY}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
    with open(file_path, "rb") as fh:
        data = fh.read()
    body += (
        f'--{BOUNDARY}\r\nContent-Disposition: form-data; name="{file_field}"; '
        f'filename="source.png"\r\nContent-Type: image/png\r\n\r\n'
    ).encode()
    body += data + f"\r\n--{BOUNDARY}--\r\n".encode()
    return bytes(body), f"multipart/form-data; boundary={BOUNDARY}"


def request(method: str, url: str, body: bytes | None = None, content_type: str | None = None) -> dict:
    req = urllib.request.Request(url, data=body, method=method)
    if content_type:
        req.add_header("Content-Type", content_type)
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def main() -> None:
    conn = psycopg.connect("postgresql://bolin@localhost/room_design")
    cur = conn.cursor()
    cur.execute(
        "SELECT payload FROM jobs WHERE type='AI_TONE_SCHEME' AND status='SUCCEEDED' "
        "ORDER BY created_at DESC LIMIT 1"
    )
    tpl = cur.fetchone()[0]
    fields = {
        "semantic_layout": json.dumps(tpl["semantic_layout"], ensure_ascii=False),
        "space_id": tpl["space_id"],
        "variants": "warm_gold_day,neutral_dusk,cool_blue_night",
        "source_approved": "true",
        "source_space_version_id": tpl["source_space_version_id"],
        "asset_parent_id": tpl["asset_parent_id"],
        "design_prompt": "",
    }
    body, ctype = build_multipart(fields, "source_space_image", tpl["source_space_path"])

    start = time.monotonic()
    job = request("POST", f"{API}/ai-workflow/tone-schemes", body, ctype)
    job_id = job["id"]
    print(f"任务已创建: {job_id}")

    last_count = 0
    saw_incremental = False
    while True:
        time.sleep(6)
        job = request("GET", f"{API}/jobs/{job_id}")
        result = job.get("result") or {}
        outputs = result.get("outputs") or []
        count = len(outputs)
        elapsed = round(time.monotonic() - start, 1)
        if count != last_count:
            print(f"[{elapsed:>6}s] status={job['status']} outputs={count} batchStatus={result.get('batchStatus')}")
            last_count = count
        if job["status"] == "RUNNING" and 0 < count < 3:
            saw_incremental = True
        if job["status"] in ("SUCCEEDED", "FAILED", "CANCELED"):
            break
        if time.monotonic() - start > 480:
            print("超时退出")
            sys.exit(1)

    total = round(time.monotonic() - start, 1)
    outputs = (job.get("result") or {}).get("outputs") or []
    statuses = [(o.get("variantId"), o.get("status")) for o in outputs]
    print(f"\n终态: {job['status']} 总耗时: {total}s")
    print(f"输出: {statuses}")
    print(f"增量发布观测: {'是 ✅' if saw_incremental else '否 ❌（RUNNING 期间未见部分 outputs）'}")
    if total < 200:
        print(f"并发生效 ✅（{total}s 远小于串行预期 180-270s+）")
    else:
        print(f"耗时 {total}s，疑似未并发 ❌")


if __name__ == "__main__":
    main()
