#!/usr/bin/env python3
"""把本目录推到 GitHub（youyu551572/youyudshm-workbench）。

本机没有 git 二进制（手持档 execve 被拒），也没有 curl，所以直接走 GitHub REST API：
逐文件 PUT /repos/:owner/:repo/contents/:path；文件已存在则先取 sha 再更新。

用法：
    GITHUB_TOKEN=github_pat_xxx python3 scripts/publish.py
    GITHUB_TOKEN=github_pat_xxx python3 scripts/publish.py --dry-run

只需要 Contents: read and write 权限（细粒度令牌只授权这一个仓库即可）。
"""
import base64
import json
import os
import ssl
import sys
import urllib.error
import urllib.request

OWNER = "youyu551572"
REPO = "youyudshm-workbench"
BRANCH = "main"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

FILES = [
    "package.json",
    "cordis.patch.yml",
    "README.md",
    "LICENSE",
    "src/index.js",
    "src/guard.js",
    "src/ssh2-polyfill.js",
    "lib/client.js",
    "scripts/publish.py",
]

API = "https://api.github.com/repos/%s/%s/contents" % (OWNER, REPO)


def context():
    # 端侧没装 CA 包，直接不校验；打的是自己的公开仓库，不涉及机密输入以外的信任问题。
    return ssl._create_unverified_context()


def request(method, url, token, body=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "youyudshm-publish")
    if data is not None:
        req.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=40, context=context()) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:  # 网络层
        return 0, str(e).encode("utf-8", "replace")


def existing_sha(rel, token):
    code, body = request("GET", "%s/%s?ref=%s" % (API, rel, BRANCH), token)
    if code != 200:
        return None
    try:
        return json.loads(body.decode("utf-8")).get("sha")
    except Exception:
        return None


def main():
    dry = "--dry-run" in sys.argv
    token = (os.environ.get("GITHUB_TOKEN") or "").strip()
    if token == "" and not dry:
        print("缺少 GITHUB_TOKEN。先建一个带 Contents: read/write 的令牌，然后：")
        print("  GITHUB_TOKEN=github_pat_xxx python3 scripts/publish.py")
        return 1

    print("目标 %s/%s @ %s%s" % (OWNER, REPO, BRANCH, "（dry-run）" if dry else ""))
    bad = 0
    for rel in FILES:
        path = os.path.join(ROOT, rel)
        if not os.path.isfile(path):
            print("  %-24s 跳过（本地没有）" % rel)
            continue
        raw = open(path, "rb").read()
        if dry:
            print("  %-24s %d 字节" % (rel, len(raw)))
            continue
        sha = existing_sha(rel, token)
        body = {
            "message": ("update " if sha else "add ") + rel,
            "content": base64.b64encode(raw).decode("ascii"),
            "branch": BRANCH,
        }
        if sha:
            body["sha"] = sha
        code, resp = request("PUT", "%s/%s" % (API, rel), token, body)
        ok = code in (200, 201)
        if not ok:
            bad += 1
        print("  %-24s %s %s" % (rel, code, "ok" if ok else resp.decode("utf-8", "replace")[:160]))

    if dry:
        print("\ndry-run 结束，未写入。")
        return 0
    print("\n完成：https://github.com/%s/%s" % (OWNER, REPO))
    return 0 if bad == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
