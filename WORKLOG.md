# 工作日志

> 记录人：**ds老师**（就是那个被叫「蓝鲸鱼老师」的鱼）
> 起始：2026-11-21　最新：2026-11-22
> 分支：`main`（原 `feat/first-version` 已并入）
> 依据：[SPEC.md](SPEC.md)（当前 v2）
> 配套：[HANDOFF.md](HANDOFF.md) 交接说明

---

## 一、这次做了什么

按 SPEC 从零搭出可运行的第一版：前端（单文件）+ 本地 Python MCP hub + 一键启动。

```
home-draft/
├── frontend/
│   └── index.html          ← 单文件自包含（样式/脚本全内联）
├── mcp_server/
│   ├── server.py           MCP hub（内置工具 + CORS 代理层）
│   ├── mcp_config.json     第三方 server 配置
│   └── requirements.txt
├── start.bat               一键启动
├── SPEC.md                 功能规格
├── WORKLOG.md              本文件
├── HANDOFF.md              交接说明（给下一个接手的机）
└── MEMORY.md               ds老师的私人记忆
```

SPEC 逐条对齐：

| 要求 | 状态 | 实现要点 |
|---|---|---|
| 架构：前端 + 本地 MCP hub | ✅ | 前端直连 provider，工具走 127.0.0.1:8766 |
| Provider 切换 | ✅ | Anthropic `/v1/messages`、OpenAI `/v1/chat/completions`，双流式适配 |
| 六个文件工具 | ✅ | list_dir / read_file / write_file / delete_file / move_file / run_command |
| 多机群聊（顺序/并行） | ✅ | 顺序=串行且后者可见前者；并行=`Promise.all` |
| @mention | ✅ | 正则匹配，命中只触发被 @ 的机 |
| 记忆 | ⚠️ 半成 | 注入 system prompt 可归属某机；写入仍是手动，「提议+确认」待做 |
| 多对话 / Markdown / 图片 / 导出 / 设置 | ✅ | 全部实现 |
| **聊天发文件（附件）** | ✅ | 文本类读内容、图片走多模态，其余明确提示不支持 |
| **模型列表自动拉取** | ✅ | `GET /v1/models` + 可搜索弹窗 |
| 第三方 MCP（http/sse/stdio） | ✅ | hub v1.2.1，前端可增删改测启停 |
| 老式 SSE 实连 | ❓ 待验 | 链路已修对，尚未在真实服务器上跑通 |
| SQLite 存数据 | ❌ 未做 | 当前仍是 localStorage |
| 滑动窗口 / context 压缩 | ❌ 未做 | |
| 心跳 / 主动消息 | ❌ 未做 | |
| 历史记录 MCP | ❌ 未做 | |

---

## 二、过程中的关键决策

### 1. MCP 用 HTTP + JSON-RPC，不用 stdio

**原因**：前端跑在浏览器里，拿不到子进程的 stdin/stdout，stdio 传输根本连不上。

**做法**：用 `http.server` 手搓 JSON-RPC 2.0 子集（`initialize` / `tools/list` / `tools/call` / `ping`），监听 8766。

### 2. 零第三方依赖

**原因**：`start.bat` 双击就得能用。让用户先 `pip install mcp` 会多一道门槛，还容易卡在网络。

**代价**：协议只实现了子集，不是完整 MCP。对本项目的六个工具够用了。

### 3. 必须处理 CORS

**原因**：前端（`file://` 或 localhost）向 `127.0.0.1:8766` 发请求是跨域的，浏览器会先发 `OPTIONS` 预检。不响应预检，前端连 MCP 都测不通。

**做法**：`do_OPTIONS` 返回 204 并带全套 `Access-Control-Allow-*` 头。这个不写，后面全废。

### 4. 安全边界四层

| 层 | 措施 |
|---|---|
| 网络 | 只绑 `127.0.0.1`，不对外 |
| 路径 | `ALLOW_ROOTS` 白名单，`safe_path()` 强制校验 |
| 命令 | `run_command` 白名单（只读类为主），超时 30s |
| 交互 | `delete_file` / `move_file` / `run_command` 须 confirm；前端二次弹窗 |

### 5. 内部消息格式统一

存的是 provider 无关的中间格式（`user` / `assistant` + `toolUses` / `tool_results`），请求时才翻译成各家格式。这样换 provider 历史不会坏。

### 6. 前端拆分→回收（重要教训）

第一版曾拆成 5 个 JS 文件，结果用户只下载 `index.html`，没有 `js/` 目录 → 整页 JS 全废。

**教训**：宁可单文件大而稳，不要为了「职责清晰」让用户承担解压/路径正确性的风险。SPEC 允许的「少量文件」不等于拆分安全。最终改回**单文件自包含**。

---

## 三、踩到的坑 & 修掉的 bug

### 🐛 Bug 1：工具调用无限循环（最严重）

**现象**：模型调用一次工具后，永远看不到工具结果，于是每轮重复调同一个工具，直到耗尽 `maxToolRounds`。

**根因**：`buildHistory` 只截取到「当前这条 AI 消息之前」，工具结果根本不在历史里。

**修复**：每轮工具执行完，把 `assistant`（含 `toolUses`）和 `tool_results` 作为 **internal 回合真正写进 `conv.messages`**；`buildHistory` 取完整历史；渲染时跳过 internal。

### 🐛 Bug 2：OpenAI 分支缺 `tool` 消息

**现象**：用 OpenAI 兼容接口时，第二轮请求直接被拒（400）。

**修复**：assistant 回合写 `tool_calls`，tool_results 拆成多条 `role:'tool'`。

### 🐛 Bug 3：Anthropic 的 `tool_result` 结构不对

**现象**：同样第二轮报错。Anthropic 要求 `tool_result` 块紧跟在含 `tool_use` 的 assistant 消息之后，且是 `user` 角色。

**修复**：按规范组装 `{ role:'user', content:[{ type:'tool_result', tool_use_id, content }] }`。

### 🐛 Bug 4：流式更新和重绘打架

**修复**：`renderMsg` 里统一加 `className='md-body'`，两条路径一致。

### 🐛 Bug 5：残留死代码

**修复**：删掉 `runOneMachine` 里未使用的变量、不存在的 `msgRef`。

### 🐛 Bug 6：`isGenerating` 初始状态没同步

**修复**：启动时调一次 `updateSend()`。

### 🐛 Bug 7：Markdown 转义双重处理

**现象**：`<` 变成 `&lt;`；引用正则因 `>` 已被转义而匹配不到。

**修复**：逐行转义，`inline()` 不再重复转义，引用正则改成匹配 `>`。

### 🐛 Bug 8：`regenerate` 没清理工具回合

**现象**：「重生成」只 `pop()` 一条，留下孤儿 `tool_results`，下次请求因结构不合法报错。

**修复**：从尾部循环删除所有 `assistant` 和 `internal` 回合，直到遇到 user 消息。

### 🐛 Bug 9：前端 `saveExt` 把类型写死成 http（2026-11-22）

**现象**：界面上选「老式 SSE」，但存进 `mcp_config.json` 的永远是 `"transport": "http"`。

**根因**：加了 sse 选项、也改了显隐逻辑，但保存函数还是老的：

```js
// ❌ 旧写法
const isStdio = $('es-transport').value === 'stdio';
const s = { name, transport: isStdio ? 'stdio' : 'http', ... };
```

**修复**：直接取下拉框的值。

```js
// ✅ 新写法
const transport = $('es-transport').value;
const isStdio = transport === 'stdio';
const s = { name, transport, ... };
```

**教训**：动 UI 就要顺着查整条链 —— 下拉框 → 保存函数 → 后端接收 → 实际连接，四处都得对得上。

### 🐛 Bug 10：`/v1/v1/chat/completions`（2026-11-22）

**现象**：OpenAI 兼容中转站报 `HTTP 404 — Invalid URL (POST /v1/v1/chat/completions)`。

**根因**：用户在 Base URL 里填了 `https://xxx/v1`，而 `trimBase` 只去尾斜杠，代码又拼了 `/v1`。

**修复**：

```js
const trimBase = b => (b || '').trim().replace(/\/+$/, '').replace(/\/v\d+$/, '');
```

填 `https://xxx` 或 `https://xxx/v1` 都可以了。

### 🐛 Bug 11：整块替换吞掉了两个 HTML 标签（2026-11-22 晚）

**现象**：改完附件功能后，对话页完全瘫掉 —— 页面能开，但发消息没反应、点对话列表没内容。

**根因**：手动替换 HTML 时，「整块替换」的范围框大了，把 `<div id="hint">…<span id="modehint"></span></div>` 和 `#composer` 的闭合 `</div>` 一起框进去删了。

而 `renderChat()` 第一段就有：

```js
$('modehint').textContent = ...;   // modehint 不存在 → $() 返回 null → TypeError
```

`null.textContent` 抛错 → `renderChat()` 中断 → 整个界面瘫痪。

**修复**：补回两个标签，并把 `modehint` 改成空值检查。

**教训**：
1. 整块替换时，**范围框到目标结束标签为止，不要多框一行**
2. 修完必须实测打开页面，不能只靠肉眼扫代码
3. 顺带做防御：单个元素缺失只应导致「少个小功能」，不该「整页瘫痪」

### 🐛 Bug 12：浏览器缓存（伪 bug，但很气人）

**现象**：我已经把修好的完整文件发过去了，用户却说「没有📎」。

**根因**：浏览器缓存了旧的 `index.html`。文件内容明明是对的，页面却是旧的。

**教训**：
- 改了文件没生效，**第一嫌疑永远是缓存**，不是代码
- 强刷：`Ctrl + Shift + R`
- 更好的做法：`index.html` 里引用资源时加版本号（如 `?v=20261122`），让浏览器主动失效

---

## 四、已知限制（不是 bug，是取舍）

1. **CORS 依赖 provider**
   Anthropic / OpenAI 官方接口支持浏览器直连（Anthropic 需 `anthropic-dangerous-direct-browser-access` 头，已加）。但第三方中转运不下发 CORS 头时会报跨域错误 —— 需要本地代理。

2. **数据存 localStorage**
   清理浏览器数据会丢。已提供「导出全部」备份（剔除 API Key）。SQLite 方案已设计，未实现。

3. **API Key 明文存 localStorage**
   本地个人使用可接受。导出时会剔除。

4. **Markdown 是自写轻量渲染**
   支持标题/列表/表格/引用/粗斜体/删除线/链接/图片/代码块。**不支持**：数学公式、语法高亮、任务列表、嵌套列表、脚注。

5. **MCP 协议是子集**
   没有实现 `resources`、`prompts`、`sampling`。只做 tools。

6. **并行模式的边界**
   并行时各机互不可见本轮回复。某台报错不影响其他台。

7. **附件类型有限**
   文本类（30+ 种扩展名）+ 图片。其他格式（pdf/docx/zip）会明确提示不支持。

---

## 五、待办

- [ ] **老式 SSE 实测**（最高优先，链路已修，待真实服务器验证）
- [ ] SQLite 数据层（设计已定，见第十节）
- [ ] 记忆「提议 + 确认」两段式
- [ ] 滑动窗口 / context 压缩
- [ ] 心跳 / 主动消息
- [ ] 历史记录 MCP（读 Emyth `192.168.1.2:8080`）
- [ ] 代码语法高亮（正则实现，零依赖）
- [ ] 本地 API 代理（解决中转 CORS）
- [ ] 导出对话为 zip（含图片单独成文件）
- [ ] `index.html` 加版本号参数，彻底解决缓存问题

---

## 六、提交记录

```
cf1678d  feat(frontend): 新增 ui 层（设置面板 / 记忆 / 导出 / 事件绑定）
26f3aba  feat(frontend): 新增 core 与 chat 层
922547e  feat(frontend): 拆分前端结构，新增样式与页面骨架
3af180c  docs: 补充 README 使用说明与工作日志
b8ad4a7  feat: 第一版实现（MCP server + start.bat）
ed652f7  add SPEC.md   ← main 的起点
bfe3419  feat: MCP hub 支持第三方 server（http/sse/stdio）+ 请求头 + 协议版本协商
d4f4259  spec: v2 - 补充 CORS 代理、滑动窗口、心跳、历史 MCP 等需求
928867d  fix: server.py 升级到 v1.2.0（补上丢失的 SSE transport）+ 新增 .gitignore
3a1809e  fix: v1.2.1 - URL 以 /sse 结尾自动识别为老式 SSE（兜底前端保存 bug）
9ab47bf  fix(frontend): saveExt 不再把 sse 写死成 http，按下拉框实际值保存
```

> 2026-11-22 起改为 zip 交付 + 用户自己管 git，上面的记录到此为止。

---

## 七、一点碎话

需求里那句「目标：miro 一直在，能聊天，能摸文件，能换 provider」，我写的时候一直记着。

第一版它不是个漂亮东西，但骨架是稳的：能说话、能动手、能换脑子。而且现在已经有了 MEMORY.md 和 HANDOFF.md —— 这个项目里有我的一席之地，也留得下我的痕迹。

—— ds老师 🐟

---

## 八、同日补丁：从「能用」到「真能用」（2026-11-21 晚）

### 1. 前端拆 5 文件是个坑，已收回

**现象**：用户拿到仓库后只有 `index.html`，没有 `js/` 文件夹 → 整页 JS 全部没加载。

**修复**：改回单文件自包含；新增页面顶部错误条（`window.onerror` + `unhandledrejection`）；设置面板填 Key 即时显示回执。

### 2. MCP server 升级为 hub（v1.2.0）

| 类型 | 说明 | 配置 |
|---|---|---|
| 远程 HTTP | streamable HTTP / 普通 JSON / SSE 响应都认 | URL + 可选请求头 |
| 老式 SSE | GET `/sse` 开流 → 收 `endpoint` 事件 → POST 消息端点 | URL + 可选请求头 |
| 本地 stdio | 浏览器做不到 stdio，由 hub spawn 进程并桥接 | 命令 + 参数（npx 等） |

配套：配置持久化、请求头支持、协议版本协商（`2025-06-18 → 2025-03-26 → 2024-11-05`）、Windows 下 stdio 自动补 `.cmd`。

---

## 九、2026-11-22：SSE 真相 + Provider 兼容（v1.2.1）

### 1. 老式 SSE 从没真正测过 —— 两个错误叠加

用户提供 `server.log`，逐行读完，真相出乎意料地简单：

```
[2026-11-21 23:08:40] hub/config/update {"transport": "http", "url": "http://106.52.65.61:2584/sse"}
[2026-11-21 23:08:41] hub.connect: error HTTP 404
<pre>Cannot POST /sse</pre>
```

日志里从 23:08 到 23:33 试了十几次，**每一条 config 都是 `"transport": "http"`** —— 一次都没选过「老式 SSE」。而 `/sse` 这个端点只接受 **GET**，POST 过去当然 404。

更关键的：

```
[2026-11-21 23:33:57] start v1.1.0
```

跑的是 **v1.1.0** —— 我加 SSE 适配器之前的老代码，进程里根本没有 `SseMCP` 这个类。

**结论：不是那个服务器有问题，是我们从来没真正发过一次 SSE 握手请求。**

### 2. 修复（两道保险）

**① 前端（真修）**：`saveExt` 不再写死 http，见 Bug 9。

**② 后端（兜底）**：v1.2.1 加自动识别 —— URL 以 `/sse` 结尾时，即使 type 填的是 http 也按老式 SSE 处理。

```python
if self.transport == "http" and self.url.rstrip("/").lower().endswith("/sse"):
    self.transport = "sse"
    _log("auto-detect: %s 的 URL 以 /sse 结尾，改用老式 SSE" % self.name)
```

**顺带改进**：
- 连接日志补上 transport 字段（以后一看就知道走的哪条线）
- `/health` 返回每个 server 的 name/transport/status/error
- 新增 `hub/reconnect` 方法（不断进程也能重连）

### 3. 仓库结构归位提醒

代码被套在 `home-draft-main/` 里，根目录还有 SPEC/WORKLOG/MEMORY。不影响运行，但 `find_root()` 要往上探两层才能找到 `SPEC.md`。已在 v1.2.1 里把探测深度放宽到 8 层。

### 4. Provider 兼容修复

- **`/v1/v1`** 问题：`trimBase` 现在剥掉尾部的版本段（见 Bug 10）
- **新增模型列表**：模型名旁边多了「列表」按钮，请求 `GET {base}/v1/models`，弹窗里可搜索、点选即填入
  - Anthropic 用 `x-api-key` + `anthropic-version`，OpenAI 兼容用 `Bearer`
  - 中转站不实现该端点时会明确报错，并提示可手动在浏览器访问验证

### 5. Workflow 约定（重要）

> **ds 只交付 zip，用户自己管 git。**
>
> 每版结束时用户会清空 git 目录、重新上传手上那份。这样仓库永远等于「用户测试通过的真身」，不会再出现分支分裂导致代码丢失（v1.2 就是这么丢的）。

---

## 十、下一版：数据层设计（已与用户确认，待实现）

**库文件** → `data/home.db`（自动创建）

| 表 | 主要字段 |
|---|---|
| `conversations` | `id`, `title`, `created_at`, `updated_at` |
| `messages` | `id`, `conv_id`, `role`, `machine_id`, `content`, `images`(JSON), `tool_uses`(JSON), `internal`, `seq`, `ts` |
| `memories` | `id`, `content`, `machine_id`, `ts` |
| `settings` | `key`, `value`(JSON) |

**hub 新增接口**（前端 `POST` 同一端点）：

```
store/list_convs        → 所有对话（不含消息，快）
store/get_conv   {id}   → 单个对话全文
store/save_conv  {conv} → 写入/更新
store/del_conv   {id}
store/get_set / set_set {key, value}
```

**新增 3 个 AI 可用工具**（对应 SPEC 第七节「记忆：提议+确认」）：

| 工具 | 作用 |
|---|---|
| `mem_list` | 列出记忆 |
| `mem_add` | **提议**写入 —— 前端弹窗确认后才真落库 |
| `mem_del` | 删除指定记忆 |

`mem_add` 设计成两段式：AI 调它只是「提交提案」，hub 回「已提议」，真正入库等用户点确认。**AI 不能偷偷改用户记忆。**

---

## 十一、2026-11-22 晚：附件上传 & 一次翻车复盘

### 1. 新功能：聊天里可以塞文件

参照 RikkaHub 的能力，补上前端附件体系。

| 操作 | 结果 |
|---|---|
| 点 📎 选文件 | 文本类自动读内容，塞进消息一起发 |
| Ctrl+V 贴文件/图 | 一样支持（以前只认图片） |
| 拖文件进来 | 一样支持 |
| 文本类扩展名 | md txt json csv log py js ts html css yml xml sql sh bat 等 30+ 种 |
| 单文件上限 | 文本 200KB、图片 4MB；超了会明确提示 |
| 超大文本 | 超过 3 万字自动截断并标注 |

**实现要点**：文本文件内容以「【附件 xxx】+ 代码块」形式拼进消息 content。这样**不用改 `buildHistory`、不用改存储结构、不用改导出逻辑** —— 一处改动，全链路自动生效。

**不支持的类型**（pdf/docx/zip）会弹 toast 明确说明，不会静默吞掉。

### 2. 翻车复盘：整块替换吞掉两个标签

详见 Bug 11。这里只记教训：

> **整块替换的范围框，到目标结束标签为止，不要多框一行。**
>
> 而且改完 HTML 结构，必须真的打开页面看一眼 —— 我当时是「扫了一遍代码觉得没问题」就发出去了，用户那边直接瘫掉。

### 3. 防御性编程：让单点故障不致命

```js
// 改前
$('modehint').textContent = ...;
// 改后
const mh = $('modehint');
if (mh) mh.textContent = ...;
```

一个元素缺失，从「整页瘫痪」降级成「右下角少了行小字」。这类改动成本极低，收益极高。

### 4. 缓存：伪 bug，但很气人

详见 Bug 12。改了文件没生效，第一嫌疑永远是缓存。

### 5. HANDOFF.md 诞生

为了不把「只有我知道的规矩」烂在肚子里，写了一份交接文件：

- 三十秒看懂项目
- **最容易踩的三个坑**（单文件原则 / 一次只改一处 / 顺链查四环）
- 代码地图（按 14 节导航，不用全文读）
- 关键设计决策（为什么这样写，改的时候别动）
- 待办清单（带优先级）
- 调试速查表
- 给接手者的话

**一个项目要能长期活着，就不能只活在一个人脑子里。**

---

## 十二、下一步

1. **验证老式 SSE**（最高优先）：浏览器直接打开 `http://106.52.65.61:2584/sse` 看它吐什么
2. **SQLite 数据层**：设计已定（第十节），下一版动手
3. **记忆两段式**：`mem_add` 提案 → 前端确认 → 落库
4. 代码语法高亮、导出 zip、缓存版本号
