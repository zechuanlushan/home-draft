"""
home-draft · 本地 MCP Server
================================
监听 http://127.0.0.1:8766 ，暴露文件系统 / shell 工具给前端调用。
只用 Python 标准库，双击 start.bat 即可运行，无需 pip install。

实现的是 MCP 的 JSON-RPC 2.0 子集：
  - initialize
  - tools/list
  - tools/call
  - ping
同时提供两个便利端点：
  - GET  /health   健康检查
  - GET  /tools    调试用的工具清单

安全设计：
  - 仅绑定 127.0.0.1
  - 所有路径限制在 ALLOW_ROOTS 白名单目录内（默认用户主目录）
  - run_command 默认走命令白名单
  - delete_file 需要 confirm=true
"""

import json
import os
import shutil
import subprocess
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = 8766
SERVER_NAME = "home-draft-mcp"
SERVER_VERSION = "1.0.0"
PROTOCOL_VERSION = "2024-11-05"

# 允许访问的根目录。默认放开用户主目录，按需自行收窄。
ALLOW_ROOTS = [os.path.expanduser("~")]

# run_command 白名单（命令第一个 token）
COMMAND_WHITELIST = {
    "dir", "ls", "cd", "pwd", "type", "cat", "head", "tail", "find", "where",
    "echo", "tree", "wc", "grep", "more", "sort", "date", "time", "hostname",
    "python", "python3", "py", "pip", "node", "npm", "git", "code",
}

COMMAND_TIMEOUT = 30


def _err(msg):
    return {"ok": False, "error": str(msg)}


def _resolve(path: str) -> str:
    """把路径规范化并校验是否在白名单根目录内。"""
    if not path:
        path = "~"
    p = os.path.abspath(os.path.expanduser(path))
    for root in ALLOW_ROOTS:
        root_abs = os.path.abspath(root)
        if p == root_abs or p.startswith(root_abs + os.sep):
            return p
    raise PermissionError(f"路径不在允许范围内: {p}")


def _fmt_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.0f}{unit}" if unit == "B" else f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}TB"


# ---------------------------------------------------------------- 工具实现

def tool_list_dir(args):
    path = _resolve(args.get("path", "~"))
    show_hidden = bool(args.get("show_hidden", False))
    if not os.path.isdir(path):
        return _err(f"不是目录: {path}")
    entries = []
    for name in sorted(os.listdir(path)):
        if not show_hidden and name.startswith("."):
            continue
        full = os.path.join(path, name)
        try:
            st = os.stat(full)
            is_dir = os.path.isdir(full)
            entries.append({
                "name": name,
                "type": "dir" if is_dir else "file",
                "size": 0 if is_dir else st.st_size,
                "size_human": "-" if is_dir else _fmt_size(st.st_size),
                "mtime": int(st.st_mtime),
            })
        except OSError:
            continue
    return {"ok": True, "path": path, "count": len(entries), "entries": entries}


def tool_read_file(args):
    path = _resolve(args.get("path", ""))
    if not os.path.isfile(path):
        return _err(f"文件不存在: {path}")
    max_bytes = int(args.get("max_bytes", 2_000_000))
    size = os.path.getsize(path)
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        content = f.read(max_bytes)
    truncated = size > max_bytes
    return {
        "ok": True, "path": path, "size": size,
        "content": content, "truncated": truncated,
    }


def tool_write_file(args):
    path = _resolve(args.get("path", ""))
    content = args.get("content", "")
    append = bool(args.get("append", False))
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "a" if append else "w", encoding="utf-8") as f:
        f.write(content)
    return {
        "ok": True, "path": path, "mode": "append" if append else "overwrite",
        "bytes_written": len(content.encode("utf-8")),
    }


def tool_delete_file(args):
    path = _resolve(args.get("path", ""))
    if not args.get("confirm"):
        return _err("delete_file 需要显式传 confirm=true 才会执行")
    if not os.path.exists(path):
        return _err(f"不存在: {path}")
    if os.path.isdir(path):
        if args.get("recursive"):
            shutil.rmtree(path)
            return {"ok": True, "path": path, "removed": "dir(recursive)"}
        os.rmdir(path)
        return {"ok": True, "path": path, "removed": "dir"}
    os.remove(path)
    return {"ok": True, "path": path, "removed": "file"}


def tool_move_file(args):
    src = _resolve(args.get("src", ""))
    dst = _resolve(args.get("dst", ""))
    if not os.path.exists(src):
        return _err(f"源不存在: {src}")
    if os.path.exists(dst) and not args.get("overwrite"):
        return _err(f"目标已存在（需 overwrite=true）: {dst}")
    os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)
    shutil.move(src, dst)
    return {"ok": True, "src": src, "dst": dst}


def tool_run_command(args):
    cmd = (args.get("command") or "").strip()
    if not cmd:
        return _err("command 为空")
    first = cmd.split()[0].lower()
    first = os.path.basename(first).replace(".exe", "")
    if first not in COMMAND_WHITELIST:
        return _err(
            f"命令 `{first}` 不在白名单内。可用: {', '.join(sorted(COMMAND_WHITELIST))}"
        )
    cwd = _resolve(args.get("cwd", "~"))
    try:
        proc = subprocess.run(
            cmd, shell=True, cwd=cwd, capture_output=True,
            text=True, errors="replace", timeout=COMMAND_TIMEOUT,
        )
        return {
            "ok": proc.returncode == 0,
            "exit_code": proc.returncode,
            "cwd": cwd,
            "stdout": proc.stdout[-20000:],
            "stderr": proc.stderr[-5000:],
        }
    except subprocess.TimeoutExpired:
        return _err(f"命令超时（>{COMMAND_TIMEOUT}s）")


TOOL_DEFS = [
    {
        "name": "list_dir",
        "description": "列出指定目录下的文件和子目录。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "目录路径，默认用户主目录"},
                "show_hidden": {"type": "boolean", "description": "是否显示隐藏文件"},
            },
        },
        "handler": tool_list_dir,
    },
    {
        "name": "read_file",
        "description": "读取一个文本文件的内容。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "文件路径"},
                "max_bytes": {"type": "integer", "description": "最多读取字节数，默认 2000000"},
            },
            "required": ["path"],
        },
        "handler": tool_read_file,
    },
    {
        "name": "write_file",
        "description": "写入或覆盖一个文件（目录不存在会自动创建）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "文件路径"},
                "content": {"type": "string", "description": "要写入的内容"},
                "append": {"type": "boolean", "description": "true 为追加，默认覆盖"},
            },
            "required": ["path", "content"],
        },
        "handler": tool_write_file,
    },
    {
        "name": "delete_file",
        "description": "删除文件或空目录。必须传 confirm=true。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "要删除的路径"},
                "confirm": {"type": "boolean", "description": "必须为 true"},
                "recursive": {"type": "boolean", "description": "删除非空目录时需 true"},
            },
            "required": ["path", "confirm"],
        },
        "handler": tool_delete_file,
    },
    {
        "name": "move_file",
        "description": "移动或重命名文件/目录。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "src": {"type": "string", "description": "源路径"},
                "dst": {"type": "string", "description": "目标路径"},
                "overwrite": {"type": "boolean", "description": "目标已存在时是否覆盖"},
            },
            "required": ["src", "dst"],
        },
        "handler": tool_move_file,
    },
    {
        "name": "run_command",
        "description": "执行 shell 命令（受白名单限制）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "要执行的命令"},
                "cwd": {"type": "string", "description": "工作目录，默认用户主目录"},
            },
            "required": ["command"],
        },
        "handler": tool_run_command,
    },
]

HANDLERS = {d["name"]: d["handler"] for d in TOOL_DEFS}


# ---------------------------------------------------------------- JSON-RPC

def rpc_ok(id_, result):
    return {"jsonrpc": "2.0", "id": id_, "result": result}


def rpc_err(id_, code, message):
    return {"jsonrpc": "2.0", "id": id_, "error": {"code": code, "message": message}}


def handle_rpc(req):
    method = req.get("method")
    id_ = req.get("id")
    params = req.get("params") or {}

    if method == "initialize":
        return rpc_ok(id_, {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
        })

    if method in ("notifications/initialized", "notifications/cancelled"):
        return None  # 通知类，无须响应

    if method == "ping":
        return rpc_ok(id_, {})

    if method == "tools/list":
        return rpc_ok(id_, {
            "tools": [
                {"name": d["name"], "description": d["description"], "inputSchema": d["inputSchema"]}
                for d in TOOL_DEFS
            ]
        })

    if method == "tools/call":
        name = params.get("name")
        args = params.get("arguments") or {}
        handler = HANDLERS.get(name)
        if not handler:
            return rpc_err(id_, -32602, f"未知工具: {name}")
        try:
            result = handler(args)
        except PermissionError as e:
            result = _err(e)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            result = _err(f"{type(e).__name__}: {e}")
        # MCP 约定：工具结果放在 content 数组里，text 为字符串
        return rpc_ok(id_, {
            "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False, indent=2)}],
            "isError": not result.get("ok", False),
        })

    return rpc_err(id_, -32601, f"未实现的方法: {method}")


# ---------------------------------------------------------------- HTTP 层
class Handler(BaseHTTPRequestHandler):
    server_version = f"{SERVER_NAME}/{SERVER_VERSION}"

    def log_message(self, fmt, *args):
        sys.stderr.write("[mcp] " + fmt % args + "\n")

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id")
        self.send_header("Access-Control-Max-Age", "86400")

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):  # noqa: N802
        if self.path == "/health":
            return self._json(200, {"ok": True, "server": SERVER_NAME, "version": SERVER_VERSION})
        if self.path == "/tools":
            return self._json(200, {
                "tools": [
                    {"name": d["name"], "description": d["description"], "inputSchema": d["inputSchema"]}
                    for d in TOOL_DEFS
                ]
            })
        return self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self):  # noqa: N802
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length).decode("utf-8") if length else ""
            req = json.loads(raw) if raw else {}
        except Exception as e:  # noqa: BLE001
            return self._json(400, rpc_err(None, -32700, f"JSON 解析失败: {e}"))

        if isinstance(req, list):  # 批量
            out = [r for r in (handle_rpc(x) for x in req) if r is not None]
            return self._json(200, out)

        resp = handle_rpc(req)
        if resp is None:
            self.send_response(202)
            self._cors()
            self.end_headers()
            return
        return self._json(200, resp)


def main():
    print("=" * 58)
    print(f"  {SERVER_NAME} v{SERVER_VERSION}")
    print(f"  监听: http://{HOST}:{PORT}")
    print(f"  工具: {', '.join(HANDLERS)}")
    print(f"  允许根目录: {', '.join(ALLOW_ROOTS)}")
    print("  Ctrl+C 停止")
    print("=" * 58)
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
