#!/usr/bin/env python3
"""分段并发下载：GitHub release 单连接被限速到 ~20KB/s，切成 2MB 段并发抓。

每段写成独立文件，最后按序拼接并校验总长度。失败段重试 3 次。
用法：fetch_seg.py <url> <out> [threads]
"""
import concurrent.futures
import os
import sys
import time
import urllib.request

CHUNK = 2 * 1024 * 1024


def head_size(url):
    req = urllib.request.Request(url, method="GET", headers={"Range": "bytes=0-0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        cr = r.headers.get("Content-Range")
        if cr and "/" in cr:
            return int(cr.split("/")[1])
        cl = r.headers.get("Content-Length")
        if cl:
            return int(cl)
    raise RuntimeError("cannot determine size")


def fetch_range(url, start, end, path, tries=4):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"Range": f"bytes={start}-{end}"})
            with urllib.request.urlopen(req, timeout=120) as r:
                data = r.read()
            want = end - start + 1
            if len(data) != want:
                raise IOError(f"short read {len(data)}/{want}")
            with open(path, "wb") as f:
                f.write(data)
            return len(data)
        except Exception as e:  # noqa: BLE001
            if attempt == tries - 1:
                raise
            time.sleep(1.5 * (attempt + 1))
    return 0


def main():
    url, out = sys.argv[1], sys.argv[2]
    threads = int(sys.argv[3]) if len(sys.argv) > 3 else 16
    total = head_size(url)
    print(f"size {total} bytes, {threads} threads", flush=True)

    parts_dir = out + ".parts"
    os.makedirs(parts_dir, exist_ok=True)
    ranges = [(i, min(i + CHUNK - 1, total - 1)) for i in range(0, total, CHUNK)]
    done = [0] * len(ranges)

    def work(idx):
        s, e = ranges[idx]
        p = os.path.join(parts_dir, f"{idx:06d}")
        if os.path.exists(p) and os.path.getsize(p) == e - s + 1:
            done[idx] = e - s + 1
            return
        done[idx] = fetch_range(url, s, e, p)

    t0 = time.time()
    pending = list(range(len(ranges)))
    for attempt in range(3):
        failed = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=threads) as ex:
            futs = {ex.submit(work, i): i for i in pending}
            finished = 0
            for f in concurrent.futures.as_completed(futs):
                idx = futs[f]
                try:
                    f.result()
                except Exception as e:  # noqa: BLE001
                    failed.append(idx)
                    print(f"  part {idx} failed: {e}", flush=True)
                finished += 1
                if finished % 5 == 0 or finished == len(futs):
                    got = sum(done)
                    print(
                        f"  round {attempt+1} {finished}/{len(futs)} parts  {got/1048576:.1f}MB"
                        f"  {got/1048576/max(time.time()-t0,1e-6):.2f}MB/s",
                        flush=True,
                    )
        if not failed:
            break
        print(f"  retrying {len(failed)} parts", flush=True)
        pending = failed
        time.sleep(2)

    with open(out, "wb") as w:
        for i in range(len(ranges)):
            with open(os.path.join(parts_dir, f"{i:06d}"), "rb") as f:
                w.write(f.read())

    got = os.path.getsize(out)
    print(f"wrote {out}: {got} bytes ({'OK' if got == total else 'MISMATCH'})")
    if got != total:
        sys.exit(1)


if __name__ == "__main__":
    main()
