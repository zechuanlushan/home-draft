/* ============================================================
 * chat.js · 对话层
 * 输入 / 发送流程 / agent 工具循环 / provider 适配 / SSE 解析
 * 依赖：core.js
 * ============================================================ */

/* ---------------- 输入 & 图片 ---------------- */
const inputEl = () => document.getElementById('input');

function autoGrow() {
  const t = inputEl();
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 180) + 'px';
}

function renderAttachments() {
  const el = document.getElementById('attachments');
  el.innerHTML = pendingImages.map((p, i) =>
    `<div class="att"><img src="${p.dataUrl}"><div class="x" onclick="removeImage(${i})">×</div></div>`
  ).join('');
}

function removeImage(i) {
  pendingImages.splice(i, 1);
  renderAttachments();
}

function addImageFile(file) {
  if (!file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = () => {
    pendingImages.push({ name: file.name || 'pasted.png', dataUrl: reader.result });
    renderAttachments();
  };
  reader.readAsDataURL(file);
}

function onSendClick() {
  if (isGenerating) { stopGeneration(); return; }
  sendMessage();
}

function stopGeneration() {
  if (abortCtl) { try { abortCtl.abort(); } catch (e) { /* ignore */ } }
  isGenerating = false;
  updateSendBtn();
  toast('已停止');
}

function updateSendBtn() {
  const btn = document.getElementById('send-btn');
  if (!btn) return;
  btn.classList.toggle('stop', isGenerating);
  btn.title = isGenerating ? '停止' : '发送';
  btn.innerHTML = isGenerating
    ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>'
    : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>';
}

/* ---------------- 选机（@mention） ---------------- */
function pickMachines(userText) {
  const enabled = settings.machines.filter(m => m.enabled);
  if (!enabled.length) return [];

  const mentioned = enabled.filter(m => {
    const safe = m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('@' + safe + '(?![\\w\\u4e00-\\u9fa5])').test(userText);
  });

  return mentioned.length ? mentioned : enabled;
}

/* ---------------- 发送 ---------------- */
async function sendMessage() {
  if (isGenerating) return;

  if (!currentConv()) newConversation(true);
  const conv = currentConv();
  const text = inputEl().value.trim();
  if (!text && !pendingImages.length) return;

  const enabled = settings.machines.filter(m => m.enabled);
  if (!enabled.length) { toast('没有启用的机，先去设置里开一台', 'err'); return; }
  if (!enabled.some(m => m.apiKey)) {
    toast('还没填 API Key，去设置里填一下', 'err');
    openSettings();
    return;
  }

  conv.messages.push({
    role: 'user',
    content: text,
    images: pendingImages.map(p => p.dataUrl),
    ts: Date.now(),
  });
  if (conv.title === '新对话' && text) conv.title = text.slice(0, 24);
  conv.updatedAt = Date.now();

  inputEl().value = '';
  autoGrow();
  pendingImages = [];
  renderAttachments();
  saveConversations();
  renderSidebar();
  renderChat();

  await runMachines(conv, pickMachines(text));
}

async function runMachines(conv, targets) {
  isGenerating = true;
  updateSendBtn();
  abortCtl = new AbortController();

  try {
    if (settings.mode === 'parallel' && targets.length > 1) {
      // 并行：同时发，各自独立，互不可见本轮回复
      await Promise.all(targets.map(m => runOneMachine(conv, m)));
    } else {
      // 顺序：串行，后一台能看到前一台的回复
      for (const m of targets) {
        await runOneMachine(conv, m);
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') toast('出错：' + e.message, 'err');
  } finally {
    isGenerating = false;
    abortCtl = null;
    updateSendBtn();
    saveConversations();
    renderChat();
  }
}

/* ---------------- 单机一次完整回合 ---------------- */
async function runOneMachine(conv, machine) {
  const msg = {
    role: 'assistant',
    machineId: machine.id,
    name: machine.name,
    color: machine.color,
    content: '',
    toolCalls: [],
    ts: Date.now(),
  };
  conv.messages.push(msg);
  renderChat();

  try {
    await agentLoop(conv, machine, msg);
  } catch (e) {
    if (e.name === 'AbortError') {
      msg.content = msg.content || '（已停止）';
    } else {
      msg.content = (msg.content ? msg.content + '\n\n' : '') + '⚠️ 请求失败：' + e.message;
    }
  }

  renderChat();
  saveConversations();
}

/* ---------------- Agent 工具循环 ---------------- */
/*
 * 关键点：每轮工具跑完，都要把「模型发起的 tool_use」和「工具执行结果」
 * 作为真实回合写进 conv.messages，下一轮请求才能让模型看到结果继续推理。
 *
 * 早期版本只取「当前消息之前」的历史，模型永远看不到工具结果，
 * 于是重复调用同一个工具直到耗尽轮数 —— 详见 WORKLOG Bug 1。
 */
async function agentLoop(conv, machine, msg) {
  let tools = [];
  if (settings.mcpEnabled) {
    tools = await mcpListTools().catch(() => []);
  }

  for (let round = 0; round < settings.maxToolRounds; round++) {
    const { toolUses } = await callModel(conv, machine, tools);

    // 流式文本已写入 msg.content；没有工具调用就是讲完了
    if (!toolUses.length) { saveConversations(); return; }

    // 模型这一轮的 assistant 回合（含 tool_use）入库
    conv.messages.push({
      role: 'assistant',
      machineId: machine.id,
      name: machine.name,
      color: machine.color,
      content: msg.content,
      toolUses,
      ts: Date.now(),
      internal: true,
    });

    const results = [];
    for (const tu of toolUses) {
      const card = { name: tu.name, args: tu.input, status: 'running', result: '' };
      msg.toolCalls.push(card);
      renderChat();

      try {
        const out = await execTool(machine, tu.name, tu.input);
        card.status = out.error ? 'error' : 'ok';
        card.result = out.error ? out.error : out.text;
      } catch (e) {
        card.status = 'error';
        card.result = String(e.message || e);
      }

      results.push({ id: tu.id, name: tu.name, content: String(card.result ?? '') });
      renderChat();
    }

    // 工具结果作为内部 user 回合入库，供下一轮请求回放
    conv.messages.push({
      role: 'tool_results',
      machineId: machine.id,
      results,
      ts: Date.now(),
      internal: true,
    });
  }

  if (msg.content) msg.content += '\n\n_(已达到工具调用轮数上限)_';
}

/* ---------------- 构建历史（provider 无关） ---------------- */
/**
 * 返回统一中间格式：
 *   { role:'user', parts:[{type:'text'|'image_url', ...}] }
 *   { role:'assistant', text, toolUses:[{id,name,input}] }
 *   { role:'tool_results', results:[{id,name,content}] }
 */
function buildHistory(conv) {
  const msgs = [];

  for (const m of conv.messages) {
    if (m.role === 'user') {
      const parts = [];
      if (m.content) parts.push({ type: 'text', text: m.content });
      (m.images || []).forEach(d => parts.push({ type: 'image_url', dataUrl: d }));
      msgs.push({ role: 'user', parts });
    } else if (m.role === 'assistant') {
      // internal 的中间回合也要带上，否则工具上下文断裂
      if (m.internal && !(m.toolUses && m.toolUses.length)) continue;
      msgs.push({
        role: 'assistant',
        text: m.content || '',
        toolUses: m.toolUses || [],
      });
    } else if (m.role === 'tool_results') {
      msgs.push({ role: 'tool_results', results: m.results || [] });
    }
  }
  return msgs;
}

function dataUrlToBase64(dataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl || '');
  return m ? { mediaType: m[1], data: m[2] } : null;
}

function normalizeBase(base) {
  return (base || '').replace(/\/+$/, '');
}

/* ---------------- 统一调用入口 ---------------- */
async function callModel(conv, machine, tools) {
  const history = buildHistory(conv);
  const sysParts = [machine.systemPrompt].filter(Boolean);

  const memText = memoryForPrompt(machine);
  if (memText) sysParts.push(memText);

  const others = settings.machines.filter(m => m.enabled && m.id !== machine.id);
  if (others.length) {
    sysParts.push(
      '当前是多机群聊。你的名字是「' + machine.name + '」。其他成员：' +
      others.map(m => '「' + m.name + '」').join('、') +
      '。你可以自然地提及他们。'
    );
  }

  const system = sysParts.join('\n\n');

  if (machine.provider === 'anthropic') {
    return streamAnthropic(machine, system, history, tools);
  }
  return streamOpenAI(machine, system, history, tools);
}

/* ---------------- Anthropic 适配 ---------------- */
async function streamAnthropic(machine, system, history, tools) {
  const url = normalizeBase(machine.baseUrl) + '/v1/messages';

  /* Anthropic 要求：assistant 的 tool_use 块后面必须紧跟 user 的 tool_result 块 */
  const messages = [];
  for (const m of history) {
    if (m.role === 'user') {
      const content = m.parts.map(p => {
        if (p.type === 'text') return { type: 'text', text: p.text };
        const b = dataUrlToBase64(p.dataUrl);
        return b
          ? { type: 'image', source: { type: 'base64', media_type: b.mediaType, data: b.data } }
          : null;
      }).filter(Boolean);
      messages.push({ role: 'user', content: content.length ? content : [{ type: 'text', text: '...' }] });
    } else if (m.role === 'assistant') {
      const blocks = [];
      if (m.text) blocks.push({ type: 'text', text: m.text });
      (m.toolUses || []).forEach(tu => blocks.push({
        type: 'tool_use', id: tu.id, name: tu.name, input: tu.input || {},
      }));
      if (blocks.length) messages.push({ role: 'assistant', content: blocks });
    } else if (m.role === 'tool_results') {
      messages.push({
        role: 'user',
        content: m.results.map(r => ({
          type: 'tool_result', tool_use_id: r.id, content: r.content,
        })),
      });
    }
  }

  const body = {
    model: machine.model,
    max_tokens: machine.maxTokens || 4096,
    temperature: machine.temperature ?? 0.7,
    messages,
    stream: true,
  };
  if (system) body.system = system;
  if (tools.length) {
    body.tools = tools.map(t => ({
      name: t.name, description: t.description, input_schema: t.inputSchema,
    }));
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': machine.apiKey,
      'anthropic-version': '2023-06-01',
      // 浏览器直连必需，否则会被 CORS 拦掉
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
    signal: abortCtl.signal,
  });

  if (!res.ok) throw new Error(await readErr(res));

  let text = '';
  const toolUses = [];
  const toolBuf = {};
  const currentMsg = () => currentConv().messages[currentConv().messages.length - 1];

  await readSSE(res, ev => {
    if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
      toolBuf[ev.index] = { id: ev.content_block.id, name: ev.content_block.name, inputJson: '' };
    } else if (ev.type === 'content_block_delta') {
      if (ev.delta?.type === 'text_delta') {
        text += ev.delta.text;
        const cm = currentMsg();
        if (cm) { cm.content = text; patchLastMessage(cm); }
      } else if (ev.delta?.type === 'input_json_delta') {
        if (toolBuf[ev.index]) toolBuf[ev.index].inputJson += ev.delta.partial_json;
      }
    } else if (ev.type === 'content_block_stop') {
      const tb = toolBuf[ev.index];
      if (tb) {
        try { tb.input = JSON.parse(tb.inputJson || '{}'); } catch (e) { tb.input = {}; }
        toolUses.push({ id: tb.id, name: tb.name, input: tb.input });
      }
    } else if (ev.type === 'error') {
      throw new Error(ev.error?.message || 'API error');
    }
  });

  return { text, toolUses };
}

/* ---------------- OpenAI 兼容适配 ---------------- */
async function streamOpenAI(machine, system, history, tools) {
  const url = normalizeBase(machine.baseUrl) + '/v1/chat/completions';

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });

  for (const m of history) {
    if (m.role === 'user') {
      const hasImg = m.parts.some(p => p.type === 'image_url');
      if (hasImg) {
        messages.push({
          role: 'user',
          content: m.parts.map(p => p.type === 'text'
            ? { type: 'text', text: p.text }
            : { type: 'image_url', image_url: { url: p.dataUrl } }),
        });
      } else {
        messages.push({ role: 'user', content: m.parts.map(p => p.text).join('\n') });
      }
    } else if (m.role === 'assistant') {
      const obj = { role: 'assistant', content: m.text || '' };
      if (m.toolUses && m.toolUses.length) {
        obj.tool_calls = m.toolUses.map(tu => ({
          id: tu.id,
          type: 'function',
          function: { name: tu.name, arguments: JSON.stringify(tu.input || {}) },
        }));
        if (!obj.content) delete obj.content;
      }
      messages.push(obj);
    } else if (m.role === 'tool_results') {
      // OpenAI 要求每个工具结果单独一条 role:'tool' 消息
      m.results.forEach(r => messages.push({
        role: 'tool', tool_call_id: r.id, content: r.content,
      }));
    }
  }

  const body = {
    model: machine.model,
    messages,
    stream: true,
    temperature: machine.temperature ?? 0.7,
  };
  if (machine.maxTokens) body.max_tokens = machine.maxTokens;
  if (tools.length) {
    body.tools = tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + machine.apiKey,
    },
    body: JSON.stringify(body),
    signal: abortCtl.signal,
  });

  if (!res.ok) throw new Error(await readErr(res));

  let text = '';
  const toolBuf = {};
  const currentMsg = () => currentConv().messages[currentConv().messages.length - 1];

  await readSSE(res, ev => {
    const d = ev.choices?.[0]?.delta;
    if (!d) return;

    if (d.content) {
      text += d.content;
      const cm = currentMsg();
      if (cm) { cm.content = text; patchLastMessage(cm); }
    }

    if (d.tool_calls) {
      for (const tc of d.tool_calls) {
        const i = tc.index ?? 0;
        if (!toolBuf[i]) toolBuf[i] = { id: tc.id || ('call_' + i), name: '', args: '' };
        if (tc.id) toolBuf[i].id = tc.id;
        if (tc.function?.name) toolBuf[i].name += tc.function.name;
        if (tc.function?.arguments) toolBuf[i].args += tc.function.arguments;
      }
    }
  });

  const toolUses = Object.values(toolBuf).map(t => {
    let input = {};
    try { input = JSON.parse(t.args || '{}'); } catch (e) { /* 参数流可能不完整 */ }
    return { id: t.id, name: t.name, input };
  });

  return { text, toolUses };
}

/* ---------------- 错误信息 ---------------- */
async function readErr(res) {
  let detail = '';
  try {
    const t = await res.text();
    try {
      const j = JSON.parse(t);
      detail = j.error?.message || j.message || t;
    } catch (e) { detail = t; }
  } catch (e) { /* ignore */ }
  return `HTTP ${res.status} ${res.statusText}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`;
}

/* ---------------- SSE 解析 ---------------- */
async function readSSE(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);

      for (const line of chunk.split('\n')) {
        const l = line.trim();
        if (!l.startsWith('data:')) continue;
        const payload = l.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try { onEvent(JSON.parse(payload)); } catch (e) { /* 跳过解析失败的行 */ }
      }
    }
  }
}

/* ---------------- 重生成 ---------------- */
async function regenerate() {
  const conv = currentConv();
  if (!conv || isGenerating) return;

  // 从尾部删掉最后一条 AI 回复及其 trailing 工具回合
  while (conv.messages.length) {
    const last = conv.messages[conv.messages.length - 1];
    if (last.role === 'assistant' || last.internal) conv.messages.pop();
    else break;
  }

  saveConversations();
  renderChat();

  const userText = [...conv.messages].reverse().find(m => m.role === 'user')?.content || '';
  await runMachines(conv, pickMachines(userText));
}
