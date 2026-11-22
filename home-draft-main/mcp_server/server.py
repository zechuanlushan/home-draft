#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
home-draft MCP hub v1.2.1
- 内置：文件工具 + 白名单命令工具
- 第三方 MCP：远程 HTTP（streamable HTTP / JSON）、老式 SSE（GET /sse 开流）、本地 stdio（npx 等）
配置在 mcp_config.json，也可在浏览器设置页里管理。

v1.2.1 变更：
- 新增自动探测：URL 以 /sse 结尾时，即使 type 填 http 也自动按老式 SSE 处理
  （修前端下拉框保存为 http 的问题，用户无需改设置）
"""
import json, os, re, sys, time, threading, subprocess, urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, urljoin

HOST = "127.0.0.1"
PORT = 8766
HUB_NAME = "home-draft MCP hub"
HUB_VERSION = "1.2.1"

BASE = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(BASE, "mcp_config.json")
LOG_FILE = os.path.join(BASE, "server.log")
# 依次尝试协商 MCP 协议版本（部分远程 server 要求 2025+，如 GitHub MCP）
PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"]


def _log(msg):
    try:
        ts = time.strftime("%Y-%m-%d %H:%M:%S")
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write("[%s] %s\n" % (ts, msg))
    except Exception:
        pass


# ---------------- 工作根目录 ----------------
def find_root():
    cur = BASE
    for _ in range(8):
        if os.path.exists(os.path.join(cur, ".home-draft-root")) or os.path.exists(os.path.join(cur, "SPEC.md")):
            return os.path.abspath(cur)
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent
    # 没找到标记：往上两级（兼容 mcp_server 在项目根的直接子目录）
    return os.path.abspath(os.path.dirname(BASE))


ROOT = find_root()
ALLOW_ROOTS = [ROOT] + [os.path.abspath(p) for p in os.environ.get("HOME_DRAFT_ROOTS", "").split(os.pathsep) if p]

CMD_WHITELIST = {"dir", "ls", "type", "cat", "echo", "date", "time", "ver", "hostname",
                 "whoami", "where", "findstr", "tasklist", "netstat", "ipconfig",
                 "ping", "systeminfo", "tree"}


def ok_(result):
    return {"result": result}


def err_(code, message):
    return {"error": {"code": code, "message": message}}


# ---------------- 内置工具 ----------------
TOOLS = [
    {"name": "list_dir", "confirm": False,
     "description": "列出目录内容。path 相对于工作根目录，省略表示根目录。",
     "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}}}},
    {"name": "read_file", "confirm": False,
     "description": "读取文本文件内容。path 相对工作根目录。",
     "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}},
    {"name": "write_file", "confirm": False,
     "description": "写入或覆盖文件。content 为文本，目录会自动创建。",
     "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]}},
    {"name": "delete_file", "confirm": True,
     "description": "删除文件（不可恢复）。只删文件不删目录。",
     "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}},
    {"name": "move_file", "confirm": True,
     "description": "移动 / 重命名文件。",
     "inputSchema": {"type": "object", "properties": {"src": {"type": "string"}, "dst": {"type": "string"}}, "required": ["src", "dst"]}},
    {"name": "run_command", "confirm": True,
     "description": "在项目根目录执行白名单命令并返回输出。允许: " + ", ".join(sorted(CMD_WHITELIST)),
     "inputSchema": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}},
]


def safe_path(p):
    if not p:
        return ROOT
    raw = os.path.abspath(os.path.join(ROOT, str(p)))
    for r in ALLOW_ROOTS:
        if raw == r or raw.startswith(r + os.sep) or raw.startswith(r + "/"):
            return raw
    raise PermissionError("路径超出允许范围: " + str(p))


def t_list_dir(args):
    p = safe_path(args.get("path", ""))
    if not os.path.isdir(p):
        raise FileNotFoundError("不是目录: " + (args.get("path") or "."))
    lines = []
    for name in sorted(os.listdir(p)):
        full = os.path.join(p, name)
        lines.append("[%s] %s" % ("d" if os.path.isdir(full) else "f", name))
    return "\n".join(lines) or "(空目录)"


def t_read_file(args):
    p = safe_path(args.get("path", ""))
    if not os.path.isfile(p):
        raise FileNotFoundError("找不到文件: " + args.get("path"))
    with open(p, "r", encoding="utf-8", errors="replace") as f:
        return f.read()[:200000]


def t_write_file(args):
    p = safe_path(args.get("path", ""))
    d = os.path.dirname(p) or ROOT
    os.makedirs(d, exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(str(args.get("content", "")))
    return "已写入 " + p


def t_delete_file(args):
    p = safe_path(args.get("path", ""))
    if not os.path.exists(p):
        raise FileNotFoundError("找不到: " + args.get("path"))
    if os.path.isdir(p):
        raise PermissionError("delete_file 只删文件，不删目录")
    os.remove(p)
    return "已删除 " + p


def t_move_file(args):
    src = safe_path(args.get("src", ""))
    dst_raw = str(args.get("dst", ""))
    if not dst_raw:
        raise ValueError("dst 不能为空")
    dst = os.path.abspath(os.path.join(ROOT, dst_raw))
    if not any(dst == r or dst.startswith(r + os.sep) or dst.startswith(r + "/") for r in ALLOW_ROOTS):
        raise PermissionError("目标超出允许范围")
    if not os.path.exists(src):
        raise FileNotFoundError("找不到: " + args.get("src"))
    os.makedirs(os.path.dirname(dst) or ROOT, exist_ok=True)
    os.rename(src, dst)
    return "已移动 %s -> %s" % (args.get("src"), dst_raw)


def t_run_command(args):
    cmd = (args.get("command") or "").strip()
    if not cmd:
        raise ValueError("command 不能为空")
    first = re.split(r"\s+", cmd, maxsplit=1)[0].lower().strip()
    if first not in CMD_WHITELIST:
        raise PermissionError("命令不在白名单: " + first)
    try:
        r = subprocess.run(cmd, shell=True, cwd=ROOT, timeout=30,
                           capture_output=True, text=True, errors="replace")
        out = (r.stdout or "") + (("\n[stderr]\n" + r.stderr) if r.stderr else "")
        return out.strip()[:100000] or "(完成，退出码 %s)" % r.returncode
    except subprocess.TimeoutExpired:
        return "(命令超过 30 秒，已终止)"


BUILTIN = {"list_dir": t_list_dir, "read_file": t_read_file, "write_file": t_write_file,
           "delete_file": t_delete_file, "move_file": t_move_file, "run_command": t_run_command}


# ============================================================
# 第三方 MCP client
# ============================================================
def parse_sse(body):
    parts = []
    for block in body.split("\n\n"):
        data = [line[5:].strip() for line in block.splitlines() if line.startswith("data:")]
        if data:
            parts.append("\n".join(data))
    return "\n".join(parts)


class StdioMCP:
    """本地 stdio 型 MCP：NDJSON 行协议"""

    def __init__(self, name, command, args, env, cwd):
        self.name = name
        self.command = command
        self.args = args or []
        self.env = env or {}
        self.cwd = cwd
        self.proc = None
        self._id = 0
        self._lock = threading.Lock()
        self._pending = {}
        self._log = []

    def start(self):
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        env = dict(os.environ)
        env.update({k: str(v) for k, v in self.env.items()})
        candidates = [self.command]
        bn = os.path.basename(self.command)
        if os.name == "nt" and "." not in bn:
            candidates += [self.command + ".cmd", self.command + ".exe",
                           self.command + ".bat", self.command + ".ps1"]
        last = None
        for cand in candidates:
            try:
                self.proc = subprocess.Popen(
                    [cand] + self.args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE, cwd=self.cwd, env=env, creationflags=flags,
                    text=True, encoding="utf-8", errors="replace", bufsize=1)
                last = None
                break
            except FileNotFoundError as e:
                last = e
        if not self.proc:
            raise FileNotFoundError(str(last))
        threading.Thread(target=self._read_loop, daemon=True).start()
        threading.Thread(target=self._err_loop, daemon=True).start()

    def _read_loop(self):
        try:
            for line in self.proc.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except Exception:
                    continue
                rid = msg.get("id")
                if rid is not None and rid in self._pending:
                    item = self._pending.pop(rid)
                    with item["cond"]:
                        item["result"] = msg
                        item["cond"].notify_all()
        except Exception:
            pass

    def _err_loop(self):
        try:
            for line in self.proc.stderr:
                line = line.strip()
                if line:
                    self._log.append(line)
                    self._log = self._log[-200:]
        except Exception:
            pass

    def notify(self, method, params=None):
        msg = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            msg["params"] = params
        try:
            self.proc.stdin.write(json.dumps(msg) + "\n")
            self.proc.stdin.flush()
        except Exception:
            pass

    def request(self, method, params=None, timeout=60):
        with self._lock:
            self._id += 1
            rid = self._id
        msg = {"jsonrpc": "2.0", "id": rid, "method": method}
        if params is not None:
            msg["params"] = params
        item = {"cond": threading.Condition(), "result": None}
        self._pending[rid] = item
        try:
            self.proc.stdin.write(json.dumps(msg) + "\n")
            self.proc.stdin.flush()
        except Exception as e:
            self._pending.pop(rid, None)
            raise Exception("[%s] 写入失败: %s" % (self.name, e))
        with item["cond"]:
            item["cond"].wait(timeout)
        self._pending.pop(rid, None)
        if item["result"] is None:
            raise Exception("[%s] 超时未响应（检查命令 / 参数 / 网络）" % self.name)
        res = item["result"]
        if res.get("error"):
            raise Exception(res["error"].get("message") or "[%s] MCP error" % self.name)
        return res.get("result")

    def kill(self):
        try:
            self.notify("shutdown")
        except Exception:
            pass
        try:
            self.proc.kill()
        except Exception:
            pass


class HttpMCP:
    """远程 HTTP 型 MCP：streamable HTTP / JSON"""

    def __init__(self, name, url, headers):
        self.name = name
        self.url = url
        self.headers = dict(headers or {})
        self.session = None
        self._id = 0

    def _post(self, msg, timeout):
        hdrs = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
        hdrs.update({k: str(v) for k, v in self.headers.items()})
        if self.session:
            hdrs["Mcp-Session-Id"] = self.session
        req = urllib.request.Request(self.url, data=json.dumps(msg).encode("utf-8"),
                                     headers=hdrs, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                if not self.session and r.headers.get("Mcp-Session-Id"):
                    self.session = r.headers["Mcp-Session-Id"]
                ctype = r.headers.get("Content-Type", "")
                body = r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8", "replace")[:300]
            except Exception:
                pass
            raise Exception("[%s] HTTP %s %s" % (self.name, e.code, detail))
        except Exception as e:
            raise Exception("[%s] %s" % (self.name, e))
        data = body
        if "text/event-stream" in ctype or body.lstrip().startswith("event:"):
            data = parse_sse(body)
        try:
            return json.loads(data)
        except Exception:
            raise Exception("[%s] 响应不是合法 JSON: %s" % (self.name, data[:200]))

    def notify(self, method, params=None):
        msg = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            msg["params"] = params
        try:
            self._post(msg, timeout=10)
        except Exception:
            pass

    def request(self, method, params=None, timeout=120):
        self._id += 1
        msg = {"jsonrpc": "2.0", "id": self._id, "method": method}
        if params is not None:
            msg["params"] = params
        j = self._post(msg, timeout)
        if j.get("error"):
            raise Exception(j["error"].get("message") or "[%s] MCP error" % self.name)
        if "result" not in j:
            raise Exception("[%s] 响应缺少 result" % self.name)
        return j["result"]


class SseMCP:
    """老式 SSE transport：GET 开流拿消息端点，POST 发请求，响应走流里回"""

    def __init__(self, name, url, headers):
        self.name = name
        self.base_url = url
        self.headers = dict(headers or {})
        self.message_url = None
        self.session = None
        self._id = 0
        self._lock = threading.Lock()
        self._cond = threading.Condition()
        self._pending = {}
        self._resp = None

    def start(self):
        hdrs = {"Accept": "text/event-stream"}
        hdrs.update({k: str(v) for k, v in self.headers.items()})
        req = urllib.request.Request(self.base_url, headers=hdrs, method="GET")
        self._resp = urllib.request.urlopen(req, timeout=30)
        if self._resp.headers.get("Mcp-Session-Id"):
            self.session = self._resp.headers["Mcp-Session-Id"]
        threading.Thread(target=self._read_loop, daemon=True).start()

    def _read_loop(self):
        event = "message"
        data_lines = []
        try:
            for raw in self._resp:
                line = raw.decode("utf-8", "replace").rstrip("\r\n")
                if line == "":
                    self._dispatch(event, "\n".join(data_lines))
                    event = "message"
                    data_lines = []
                    continue
                if line.startswith(":"):
                    continue
                if line.startswith("event:"):
                    event = line[6:].strip()
                elif line.startswith("data:"):
                    data_lines.append(line[5:].lstrip(" "))
        except Exception:
            pass

    def _dispatch(self, event, data):
        if not data.strip():
            return
        if event == "endpoint":
            t = data.strip()
            try:
                j = json.loads(t)
                if isinstance(j, dict) and j.get("uri"):
                    self.message_url = j["uri"]
                    with self._cond:
                        self._cond.notify_all()
                    return
            except Exception:
                pass
            self.message_url = t if t.startswith("http") else urljoin(self.base_url, t)
            with self._cond:
                self._cond.notify_all()
            return
        try:
            msg = json.loads(data)
        except Exception:
            return
        rid = msg.get("id")
        if rid is not None and rid in self._pending:
            item = self._pending.pop(rid)
            with item["cond"]:
                item["result"] = msg
                item["cond"].notify_all()

    def _ready(self, timeout):
        with self._cond:
            if not self.message_url and not self._cond.wait(timeout):
                raise Exception("[%s] 等待 SSE endpoint 超时（服务器没发 endpoint 事件）" % self.name)

    def request(self, method, params=None, timeout=120):
        if not self.message_url:
            self._ready(30)
        with self._lock:
            self._id += 1
            rid = self._id
        msg = {"jsonrpc": "2.0", "id": rid, "method": method}
        if params is not None:
            msg["params"] = params
        item = {"cond": threading.Condition(), "result": None}
        self._pending[rid] = item
        hdrs = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
        hdrs.update({k: str(v) for k, v in self.headers.items()})
        if self.session:
            hdrs["Mcp-Session-Id"] = self.session
        body = ""
        try:
            req = urllib.request.Request(self.message_url, data=json.dumps(msg).encode("utf-8"), headers=hdrs, method="POST")
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = r.read().decode("utf-8", "replace")
        except Exception:
            pass
        if body.strip():
            try:
                j = json.loads(body)
                if j.get("id") == rid:
                    self._pending.pop(rid, None)
                    return self._result(j)
            except Exception:
                pass
        with item["cond"]:
            item["cond"].wait(timeout)
        self._pending.pop(rid, None)
        if item["result"] is None:
            raise Exception("[%s] 超时未响应" % self.name)
        return self._result(item["result"])

    def _result(self, j):
        if j.get("error"):
            raise Exception(j["error"].get("message") or "[%s] MCP error" % self.name)
        if "result" not in j:
            raise Exception("[%s] 响应缺少 result" % self.name)
        return j["result"]

    def notify(self, method, params=None):
        try:
            self.request(method, params, timeout=10)
        except Exception:
            pass

    def kill(self):
        try:
            if self._resp:
                self._resp.close()
        except Exception:
            pass


class Endpoint:
    def __init__(self, cfg):
        self.name = str(cfg.get("name") or "server")
        self.transport = str(cfg.get("transport") or "http")
        self.url = str(cfg.get("url") or "")
        # ★ 自动探测：URL 以 /sse 结尾 → 一律按老式 SSE 处理
        #   （前端保存 bug 会把 sse 存成 http，这里在后端兜底）
        if self.transport == "http" and self.url.rstrip("/").lower().endswith("/sse"):
            self.transport = "sse"
            _log("auto-detect: %s 的 URL 以 /sse 结尾，改用老式 SSE" % self.name)
        self.command = str(cfg.get("command") or "")
        self.args = cfg.get("args") or []
        if isinstance(self.args, str):
            self.args = [a.strip() for a in self.args.split(",") if a.strip()]
        self.env = cfg.get("env") or {}
        self.headers = dict(cfg.get("headers") or {})
        if self.transport in ("http", "sse"):
            for k, v in (self.env or {}).items():
                self.headers.setdefault(k, v)
        self.cwd = cfg.get("cwd") or None
        self.enabled = bool(cfg.get("enabled", True))
        self.confirm = bool(cfg.get("confirm", True))
        self.prefix = re.sub(r"[^0-9a-zA-Z_]", "_", self.name.lower()) + "__"
        self.client = None
        self.status = "stopped"
        self.error = ""
        self.tools = []
        self._lock = threading.Lock()

    def connect(self):
        with self._lock:
            if self.transport == "stdio":
                if not self.command:
                    self.status, self.error = "error", "command 为空"
                    return False, "command 为空"
                self.client = StdioMCP(self.name, self.command, self.args, self.env, self.cwd)
                try:
                    self.client.start()
                except Exception as e:
                    self.status, self.error = "error", "启动失败: %s" % e
                    return False, "启动失败: %s" % e
            elif self.transport == "sse":
                if not self.url:
                    self.status, self.error = "error", "URL 为空"
                    return False, "URL 为空"
                self.client = SseMCP(self.name, self.url, self.headers)
                try:
                    self.client.start()
                except Exception as e:
                    self.status, self.error = "error", "SSE 连接失败: %s" % e
                    return False, "SSE 连接失败: %s" % e
            else:
                self.client = HttpMCP(self.name, self.url, self.headers)
            self.status, self.error = "connecting", ""
        try:
            self._negotiate()
            r = self.client.request("tools/list", {}, timeout=15)
            self.tools = r.get("tools") or []
            self.status = "ok"
            self.error = ""
            return True, "%d 个工具" % len(self.tools)
        except Exception as e:
            self.status = "error"
            self.error = str(e)
            self.tools = []
            return False, str(e)

    def _negotiate(self):
        last = None
        for pv in PROTOCOL_VERSIONS:
            try:
                self.client.request("initialize", {
                    "protocolVersion": pv,
                    "capabilities": {"tools": {}},
                    "clientInfo": {"name": "home-draft-hub", "version": HUB_VERSION},
                }, timeout=15)
                self.client.notify("notifications/initialized")
                self.pv = pv
                return pv
            except Exception as e:
                low = str(e).lower()
                if "protocol" in low or "version" in low:
                    last = e
                    continue
                raise e
        raise last if last else Exception("协议版本协商失败")

    def stop(self):
        try:
            if self.client:
                self.client.kill()
        except Exception:
            pass
        self.client = None
        self.status = "stopped"
        self.error = ""

    def call(self, tool_name, args, timeout=120):
        if not self.client:
            raise Exception("[%s] 未连接" % self.name)
        r = self.client.request("tools/call", {"name": tool_name, "arguments": args}, timeout=timeout)
        text = ""
        for c in (r or {}).get("content") or []:
            if isinstance(c, dict) and "text" in c:
                text += str(c["text"]) + "\n"
            elif isinstance(c, dict) and c.get("type") == "image":
                text += "[图片输出已忽略]\n"
        text = text.strip()
        if r and r.get("isError"):
            raise Exception(text or "[%s] 工具执行失败" % self.name)
        return text or "(无输出)"


class Hub:
    def __init__(self):
        self.endpoints = []
        self.lock = threading.Lock()

    def load(self):
        self.endpoints = [Endpoint(s) for s in self._read_cfg().get("servers", [])]
        threading.Thread(target=self.connect_all, daemon=True).start()

    def _read_cfg(self):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            if isinstance(cfg, dict) and isinstance(cfg.get("servers"), list):
                return cfg
        except Exception:
            pass
        return {"servers": []}

    def _write_cfg(self, servers):
        try:
            with open(CONFIG_FILE, "w", encoding="utf-8") as f:
                json.dump({"servers": servers}, f, ensure_ascii=False, indent=2)
            return True, "ok"
        except Exception as e:
            return False, str(e)

    def connect_all(self):
        for ep in self.endpoints:
            if ep.enabled:
                try:
                    ep.connect()
                    _log("hub.connect %s (%s): %s %s" % (ep.name, ep.transport, ep.status, ep.error))
                except Exception as e:
                    ep.status, ep.error = "error", str(e)

    def merged_tools(self):
        out = [dict(t) for t in TOOLS]
        for ep in self.endpoints:
            if ep.status == "ok":
                for t in ep.tools:
                    out.append({
                        "name": ep.prefix + str(t.get("name", "tool")),
                        "description": "[%s] %s" % (ep.name, t.get("description") or ""),
                        "inputSchema": t.get("inputSchema") or t.get("input_schema") or {"type": "object", "properties": {}},
                        "confirm": ep.confirm,
                    })
        return out

    def call_tool(self, name, args):
        if name in BUILTIN:
            return BUILTIN[name](args)
        for ep in self.endpoints:
            if name.startswith(ep.prefix) and len(name) > len(ep.prefix):
                if ep.status != "ok":
                    raise Exception("[%s] 未连接: %s" % (ep.name, ep.error))
                return ep.call(name[len(ep.prefix):], args)
        raise Exception("未知工具: %s" % name)

    def status_list(self):
        return [{"name": e.name, "transport": e.transport, "enabled": e.enabled,
                 "status": e.status, "error": e.error, "toolCount": len(e.tools),
                 "url": e.url, "command": e.command, "args": e.args, "confirm": e.confirm,
                 "headers": e.headers}
                for e in self.endpoints]

    def test(self, cfg):
        ep = Endpoint(cfg)
        try:
            ok_, msg = ep.connect()
            return {"ok": ok_, "message": msg}
        finally:
            ep.stop()

    def update(self, servers):
        names = [s.get("name") for s in servers if isinstance(s, dict)]
        if len(names) != len(set(names)):
            return {"ok": False, "message": "server 名字重复，请改名"}
        ok_, msg = self._write_cfg(servers)
        if not ok_:
            return {"ok": False, "message": msg}
        for ep in self.endpoints:
            try:
                ep.stop()
            except Exception:
                pass
        self.endpoints = [Endpoint(s) for s in servers]
        threading.Thread(target=self.connect_all, daemon=True).start()
        return {"ok": True, "message": "已保存并重连"}


hub = Hub()


# ============================================================
# HTTP 处理
# ============================================================
def dispatch(method, params):
    if method == "initialize":
        return ok_({"protocolVersion": "2024-11-05",
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": {"name": HUB_NAME, "version": HUB_VERSION}})
    if method == "ping":
        return ok_({})
    if method == "tools/list":
        return ok_({"tools": hub.merged_tools()})
    if method == "tools/call":
        params = params or {}
        name = params.get("name")
        args = params.get("arguments") or {}
        if not name:
            return err_(-32602, "name 必填")
        try:
            return ok_({"content": [{"type": "text", "text": hub.call_tool(name, args)}],
                        "isError": False})
        except Exception as e:
            return ok_({"content": [{"type": "text", "text": str(e)}], "isError": True})
    if method == "hub/config/get":
        return ok_({"servers": hub.status_list()})
    if method == "hub/config/update":
        return ok_(hub.update((params or {}).get("servers") or []))
    if method == "hub/test":
        return ok_(hub.test((params or {}).get("server") or {}))
    if method == "hub/reconnect":
        for ep in hub.endpoints:
            try:
                ep.stop()
            except Exception:
                pass
        threading.Thread(target=hub.connect_all, daemon=True).start()
        return ok_({"ok": True, "message": "已重新连接"})
    return err_(-32601, "未知方法: " + str(method))


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, Mcp-Session-Id, Accept")
        self.send_header("Access-Control-Expose-Headers", "Mcp-Session-Id")

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if urlparse(self.path).path == "/health":
            self._send(200, {"status": "ok", "name": HUB_NAME, "version": HUB_VERSION,
                             "tools": len(hub.merged_tools()),
                             "servers": [{"name": e.name, "transport": e.transport,
                                           "status": e.status, "error": e.error}
                                          for e in hub.endpoints]})
            return
        self._send(404, err_(-32601, "not found"))

    def do_POST(self):
        try:
            ln = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(ln) if ln else b"{}"
            payload = json.loads(raw.decode("utf-8") or "{}")
        except Exception as e:
            self._send(400, err_(-32700, "解析失败: " + str(e)))
            return
        method = payload.get("method")
        params = payload.get("params") or {}
        if not method:
            self._send(400, err_(-32600, "缺 method"))
            return
        _log("%s %s" % (method, json.dumps(params, ensure_ascii=False)[:200]))
        self._send(200, dispatch(method, params))

    def log_message(self, *a):
        pass


def main():
    print("=" * 58)
    print("  %s v%s" % (HUB_NAME, HUB_VERSION))
    print("  监听: http://%s:%d" % (HOST, PORT))
    print("  根目录: %s" % ROOT)
    print("  内置工具: %s" % ", ".join(t["name"] for t in TOOLS))
    print("  第三方 MCP: mcp_config.json（支持 http / sse / stdio，URL 以 /sse 结尾会自动识别）")
    print("  Ctrl+C 退出")
    print("=" * 58)
    _log("start v%s root=%s" % (HUB_VERSION, ROOT))
    try:
        httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError as e:
        msg = "端口 %d 被占用，可能已有实例在跑。%s" % (PORT, e)
        print(msg)
        _log("[FATAL] " + msg)
        return 1
    hub.load()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n停止。")
        _log("stopped")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main() or 0)
    except Exception:
        import traceback
        tb = traceback.format_exc()
        print(tb)
        _log("[FATAL] " + tb.replace("\n", " | "))
        sys.exit(1)
