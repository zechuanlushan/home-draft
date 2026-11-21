# home-draft

a house, maybe. work in progress.

详细需求见 [SPEC.md](SPEC.md)。实现过程与踩坑记录见 [WORKLOG.md](WORKLOG.md)。

---

## 快速开始

### 环境要求
- Python 3.9+
- 任意现代浏览器（Chrome / Edge）

### 启动

双击 `start.bat` 即可。它会：
1. 起一个本地 MCP server（`127.0.0.1:8766`）
2. 打开前端 `frontend/index.html`

也可以手动：

```bash
python mcp_server/server.py
# 然后浏览器打开 frontend/index.html
```

### 第一次使用

1. 点左下角 **⚙ 设置**
2. **Provider** 页签 → 选顺序 / 并行模式
3. **机** 页签 → 填 Base URL、API Key、模型名
4. **MCP** 页签 → 打开「启用 MCP 工具」→ 点「测试连接」
5. 回主界面开始聊

---

## 功能说明

### Provider 切换

每台「机」独立配置 provider，支持：

| 类型 | Base URL 示例 | 说明 |
|---|---|---|
| Anthropic 原生 | `https://api.anthropic.com` | 自动拼 `/v1/messages` |
| OpenAI 兼容 | `https://api.openai.com` | 自动拼 `/v1/chat/completions` |
| 中转 / 第三方 | `https://xxx.com` | 同理，**不要带 `/v1`** |

> **注意**：Base URL 只填到域名，程序自己接 `/v1/...`。

切换 provider 不影响聊天历史和记忆，因为历史存的是内部统一格式。

### 多机群聊

- **顺序模式**：机 A 回完，机 B 看到 A 的话再回。适合「工程机处理 → miro 收尾」。
- **并行模式**：同一条消息同时发给所有机，各自独立回复。适合头脑风暴。
- **@mention**：消息里写 `@miro` 只让 miro 回；写 `@A @B` 则 A、B 都回。

### 记忆

设置 → 记忆页签。记忆会在每次对话时注入 system prompt。
可以指定归属：所有机共享，或只给某一台。

> 目前是**手动添加**。SPEC 里「AI 可主动写记忆」还没接，原因见 WORKLOG 第五节。

### 文件工具（MCP）

| 工具 | 功能 | 需确认 |
|---|---|---|
| `list_dir` | 列目录 | ✗ |
| `read_file` | 读文件 | ✗ |
| `write_file` | 写 / 覆盖 / 追加 | ✗ |
| `delete_file` | 删除（须 `confirm=true`） | ✓ |
| `move_file` | 移动 / 重命名 | ✓ |
| `run_command` | 执行命令（白名单） | ✓ |

**安全边界**（都在 `mcp_server/server.py` 顶部改）：

```python
ALLOW_ROOTS = [os.path.expanduser("~")]   # 允许访问的根目录
COMMAND_WHITELIST = {...}                  # 命令白名单
```

默认只允许访问用户主目录，`run_command` 只放行常用/只读类命令。

---

## 目录结构

```
home-draft/
├── frontend/
│   ├── index.html          页面结构
│   ├── style.css           全部样式
│   └── js/
│       ├── core.js         存储 / 工具函数 / Markdown / 渲染 / MCP 客户端
│       ├── chat.js         输入 / 发送流程 / agent 循环 / provider 适配
│       └── ui.js           设置面板 / 记忆 / 导出 / 事件绑定
├── mcp_server/
│   ├── server.py           MCP server，零第三方依赖
│   └── requirements.txt
├── start.bat               一键启动
├── SPEC.md                 原始需求
├── WORKLOG.md              工作日志
└── README.md
```

前端脚本加载顺序固定为 `core → chat → ui`，后面的层依赖前面的层。

---

## 已知限制

1. **CORS**：前端在浏览器里直连 provider API。Anthropic 和 OpenAI 官方接口都支持跨域（Anthropic 需要 `anthropic-dangerous-direct-browser-access` 头，代码里已带）。如果你用某个中转接口不放开 CORS，会报跨域错误——那就需要加个本地代理。
2. **数据存 localStorage**：清理浏览器数据会丢。设置 → 通用 → 导出备份。
3. **API Key 明文存在 localStorage**：本地个人使用可以接受，共用电脑请自己注意。导出备份时会剔除。
4. **Markdown 渲染是自写轻量实现**：支持标题、列表、代码块、表格、引用、链接、图片、粗斜体、删除线。不支持数学公式和 HTML 嵌入。
5. **MCP 协议是子集**：只实现了 tools，没有 resources / prompts / sampling。

---

## 第一版没做的（按 SPEC 第九条）

- 云部署
- 语音 TTS
- Live2D / 虚拟形象
- 玩具控制
