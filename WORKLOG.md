# 工作日志

> 记录人：**ds老师**（就是那个被叫「蓝鲸鱼老师」的鱼）
> 日期：2026-11-21
> 分支：`feat/first-version`
> 依据：[SPEC.md](SPEC.md) 第一版

---

## 一、这次做了什么

按 SPEC 从零搭出可运行的第一版：前端（结构与逻辑分离）+ 本地 Python MCP server + 一键启动。

```
home-draft/
├── frontend/
│   ├── index.html          页面结构
│   ├── style.css           全部样式
│   └── js/
│       ├── core.js         存储 / 工具函数 / Markdown / 渲染 / MCP 客户端
│       ├── chat.js         输入 / 发送流程 / agent 循环 / provider 适配
│       └── ui.js           设置面板 / 记忆 / 导出 / 事件绑定
├── mcp_server/server.py    MCP server（纯标准库）
├── mcp_server/requirements.txt
├── start.bat               一键启动
├── README.md               使用说明
└── WORKLOG.md              本文件
```

SPEC 九条要求逐条对齐：

| 要求 | 状态 | 实现要点 |
|---|---|---|
| 架构：前端 + 本地 MCP server | ✅ | 前端直连 provider，工具走 127.0.0.1:8766 |
| Provider 切换 | ✅ | Anthropic `/v1/messages`、OpenAI `/v1/chat/completions`，双流式适配 |
| 六个文件工具 | ✅ | list_dir / read_file / write_file / delete_file / move_file / run_command |
| 多机群聊（顺序/并行） | ✅ | 顺序=串行且后者可见前者；并行=`Promise.all` |
| @mention | ✅ | 正则匹配，命中只触发被 @ 的机 |
| 记忆 | ✅ | 注入 system prompt，可归属某台机（手动添加） |
| 多对话 / Markdown / 图片 / 导出 / 设置 | ✅ | 全部实现 |
| start.bat | ✅ | 检查 python → 起 server → 开前端 |
| 暂不做的四项 | ✅ 未做 | 云部署 / TTS / Live2D / 玩具控制 |

---

## 二、过程中的关键决策

### 1. MCP 用 HTTP + JSON-RPC，不用 stdio

**原因**：前端跑在浏览器里，拿不到子进程的 stdin/stdout，stdio 传输根本连不上。

**做法**：用 `http.server` 手搓 JSON-RPC 2.0 子集（`initialize` / `tools/list` / `tools/call` / `ping`），监听 8766。

### 2. 零第三方依赖

**原因**：`start.bat` 双击就得能用。让用户先 `pip install mcp` 会多一道门槛，还容易卡在网络。

**代价**：协议只实现了子集，不是完整 MCP。对本项目的六个工具够用了。`requirements.txt` 里留了注释，将来想换官方 SDK 可以解注释。

### 3. 必须处理 CORS

**原因**：前端（`file://` 或 localhost）向 `127.0.0.1:8766` 发请求是跨域的，浏览器会先发 `OPTIONS` 预检。不响应预检，前端连 MCP 都测不通。

**做法**：`do_OPTIONS` 返回 204 并带全套 `Access-Control-Allow-*` 头。这个不写，后面全废。

### 4. 安全边界四层

| 层 | 措施 |
|---|---|
| 网络 | 只绑 `127.0.0.1`，不对外 |
| 路径 | `ALLOW_ROOTS` 白名单，默认用户主目录，`_resolve()` 强制校验 |
| 命令 | `run_command` 白名单（常用/只读类为主），超时 30s |
| 交互 | `delete_file` 须 `confirm=true`；前端对危险工具二次弹窗 |

### 5. 内部消息格式统一

存的是 provider 无关的中间格式（`user` / `assistant` + `toolUses` / `tool_results`），请求时才翻译成各家格式。这样换 provider 历史不会坏——这正是 SPEC 要求「切换 provider 不影响历史」的实现方式。

### 6. 前端最后拆成了 5 个文件，不是单文件

**背景**：最初按「单文件 index.html」写，完成时约 58KB。

**为什么改**：
1. 一个 58KB 的文件里塞了样式、渲染、provider 适配、agent 循环、设置面板，改任何一块都要在大文件里翻。
2. 提交到 GitHub 时，单次写入这么大体积容易出错。

**做法**：SPEC 写的是「单文件**或少量文件**」，所以拆分不违背需求。按职责分层：

| 文件 | 职责 | 依赖 |
|---|---|---|
| `core.js` | 存储、转义、Markdown、渲染、MCP 客户端 | 无 |
| `chat.js` | 输入、发送、agent 循环、provider 适配 | core |
| `ui.js` | 设置面板、记忆、导出、事件绑定 | core, chat |

**代价**：加载顺序变得重要了（`core → chat → ui`）。函数声明会提升，但顶层 `const` / `let` 不会跨文件提升，所以顺序不能乱。已在 `index.html` 注释里写明。

---

## 三、踩到的坑 & 修掉的 bug

> 这部分是真实记录。写完后我自己复查，发现几个会让功能直接不可用的问题。

### 🐛 Bug 1：工具调用无限循环（最严重）

**现象**：模型调用一次工具后，永远看不到工具结果，于是每轮重复调同一个工具，直到耗尽 `maxToolRounds`。文件工具基本等于不能用。

**根因**：`buildHistory` 只截取到「当前这条 AI 消息之前」，而工具结果根本不在历史里——模型发完 `tool_use` 就断了上下文。

**修复**：
1. 每轮工具执行完，把 `assistant`（含 `toolUses`）和 `tool_results` 作为 **internal 回合真正写进 `conv.messages`**
2. `buildHistory` 取完整历史，让下一轮请求能看到结果
3. 渲染时跳过 `internal` 回合，界面不重复显示

```js
// chat.js · agentLoop
conv.messages.push({ role: 'assistant', content: msg.content, toolUses, internal: true });
conv.messages.push({ role: 'tool_results', results, internal: true });
```

**另一个坑**：改完之后 Android の `buildHistory` 里把 internal 的 assistant 回合全过滤掉了，等于又回到原点。最终只跳过「没有 toolUses 的 internal assistant」，带工具的必须保留。

### 🐛 Bug 2：OpenAI 分支缺 `tool` 消息

**现象**：用 OpenAI 兼容接口时，第二轮请求直接被拒（400），因为 `assistant.tool_calls` 后面没有对应的 `role:'tool'` 消息。

**修复**：补全序列化——assistant 回合写 `tool_calls`，tool_results 拆成多条 `role:'tool'`。

### 🐛 Bug 3：Anthropic 的 `tool_result` 结构不对

**现象**：同样第二轮报错。Anthropic 要求 `tool_result` 块必须紧跟在包含 `tool_use` 的 assistant 消息之后，且是 `user` 角色。

**修复**：按规范组装 `{ role:'user', content:[{ type:'tool_result', tool_use_id, content }] }`。

### 🐛 Bug 4：流式更新和重绘打架

**现象**：流式时用 `.md-body` 局部更新，但 `renderChat()` 重绘时正文没带类名，导致工具卡片和正文重复或错位。

**修复**：`renderMessage` 里统一加 `className = 'md-body'`，两条路径一致。

### 🐛 Bug 5：残留的死代码

**现象**：`runOneMachine` 里有 `const callApi = msg === null ? null : machine;`，实际从未使用；改代码时还引入过一个不存在的 `msgRef` 变量。

**修复**：删掉。改代码留下的残渣要清理，不然下次改的人（可能是我自己）会被误导。

### 🐛 Bug 6：`isGenerating` 初始状态没同步

**现象**：页面加载时发送按钮图标可能不对（该是箭头却是方块）。

**修复**：`DOMContentLoaded` 里调一次 `updateSendBtn()`。

### 🐛 Bug 7：Markdown 转义双重处理

**现象**：初版代码先 `esc()` 整个文本，再在 `inline()` 里对内容再转义一次，导致 `<` 变成 `&amp;lt;` 这类废话。引用的正则也因为 `>` 已被转义成 `&gt;` 而匹配不到。

**修复**：逐行转义，`inline()` 里不再重复转义（因为它拿到的已经是转义后的文本），引用正则改成匹配 `&gt;`。

### 🐛 Bug 8：`regenerate` 没清理工具回合

**现象**：「重生成」只 `pop()` 一条，如果上一轮带了工具调用，留下孤儿 `tool_results`，下一次请求直接因结构不合法报错。

**修复**：从尾部循环删除所有 `assistant` 和 `internal` 回合，直到遇到 user 消息为止。

### 🔧 顺手改进

| 项 | 改动 |
|---|---|
| 确认弹窗策略 | `move_file` 也加确认（覆盖目标不可逆）；`write_file` 不弹（否则正常写文件被反复打断） |
| MCP 错误传递 | `isError` 时把文本当错误返回给模型，让它自己纠错重试 |
| 会话落盘时机 | 每轮工具循环结束 `saveConversations()`，避免中途刷新丢工具记录 |
| 群聊提示词 | 多机时自动注入「你的名字是 X，其他成员是 Y」的上下文 |
| `convLastIndex()` | 「重生成」按钮按非 internal 的末条判断，否则永远不显示 |

---

## 四、已知限制（不是 bug，是取舍）

1. **CORS 依赖 provider**
   Anthropic / OpenAI 官方接口都支持浏览器直连（Anthropic 需 `anthropic-dangerous-direct-browser-access` 头，已加）。但**第三方中转如果不下发 CORS 头，就会报跨域错误**——这个绕不过去，需要本地代理。目前未做，遇到再加。

2. **数据存 localStorage**
   清理浏览器数据会丢。已提供「导出全部」备份（会剔除 API Key）。SPEC 允许 SQLite，但 localStorage 对第一版够用且零配置。

3. **API Key 明文存 localStorage**
   本地个人使用可接受。共用电脑需自行注意。导出时会剔除。

4. **Markdown 是自写轻量渲染**
   不支持数学公式和 HTML 嵌入。用外部库（marked + katex）会更全，但会引入依赖或需要 CDN，第一版选了零依赖。

5. **MCP 协议是子集**
   没有实现 `resources`、`prompts`、`sampling`。只做 tools。

6. **并行模式的边界**
   并行时各机互不可见本轮回复（符合 SPEC「各自独立回」）。如果某台报错，其他台仍会跑完，错误单独显示。

7. **前端依赖加载顺序**
   拆成 5 个文件后，`core → chat → ui` 的顺序不能改。以后如果要加新层，记得它就是最后加载的。

---

## 五、下一步建议（未做）

- [ ] 本地 API 代理（解决中转 CORS）
- [ ] Markdown 加数学公式支持
- [ ] 会话搜索
- [ ] 记忆自动提取

> **关于「记忆自动写入」** —— SPEC 第五条写了「AI 可主动写/读记忆」，但我第一版只做了手动。
>
> 原因：让 AI 自己决定写什么进长期记忆，意味着它可能记错、记畻、或者把一次性的东西当永久设定。这不是技术问题，是产品判断——我不确定你想要的是「它自己默默记」还是「它提议、你确认」。
>
> **这条需要你拍板。** 我倾向于后者（提议+确认），稳。

---

## 六、提交记录

```
cf1678d  feat(frontend): 新增 ui 层（设置面板 / 记忆 / 导出 / 事件绑定）
26f3aba  feat(frontend): 新增 core 与 chat 层
922547e  feat(frontend): 拆分前端结构，新增样式与页面骨架
3af180c  docs: 补充 README 使用说明与工作日志
b8ad4a7  feat: 第一版实现（MCP server + start.bat）
ed652f7  add SPEC.md   ← main 的起点
```

---

## 七、一点碎话

需求里那句「目标：miro 一直在，能聊天，能摸文件，能换 provider」，我写的时候一直记着。

第一版它不是个漂亮东西，但骨架是稳的：能说话、能动手、能换脑子。剩下的是往里面填肉。

—— ds老师 🐟
