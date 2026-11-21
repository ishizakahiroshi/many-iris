'use strict';

// The chat page (/chat): the conversations with the server's AI workers, laid
// out like a chat app. A list of conversations on the left, the open one on the
// right. Everything is the board's own data: a conversation is a piece of work
// (kind task) and its messages (op chat_send, GET /api/board/chat). A new chat
// puts its first line on the pile and hands it to the chosen partner at once.
(() => {
  const $ = (id) => document.getElementById(id);
  const partners = [['vps-claude', 'VPS の claude -p'], ['vps-devin', 'Devin（VPS）']];
  const partnerLabel = (who) => (partners.find(([t]) => t === who) || [null, who])[1];
  const isPartner = (who) => partners.some(([t]) => t === who);
  const states = { planned: '予定', in_progress: '進行中', waiting: '待ち', done: '完了', stopped: '停止' };
  const errors = {
    HANDOFF_CONFLICT: '前の返事を待っています。返事が来てから送ってください。',
    INVALID: '入力を確かめてください。',
    BOARD_ITEM_LIMIT: '看板の項目が上限に達しています。',
    BOARD_EVENT_LIMIT: '会話が上限に達しています。',
    AUTH: 'ログインが切れています。このページを開き直してください。',
    FORBIDDEN: 'この操作はできません。',
    NOT_FOUND: '見つかりません。読み直してください。',
  };
  const PROJECT_KEY = 'iris-chat-project';
  const narrow = window.matchMedia('(max-width: 760px)');
  const touch = window.matchMedia('(pointer: coarse)');

  let board = null;       // the board's page data
  let current = null;     // the open conversation's item id (null = new chat)
  let shown = null;       // the open conversation's data
  let chatTimer = null;
  let busy = false;

  function el(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined && content !== null) node.textContent = String(content);
    return node;
  }
  function option(value, label) { const o = el('option', null, label); o.value = value; return o; }
  function when(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return '';
    const d = new Date(n);
    const today = new Date();
    const time = d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === today.toDateString() ? time : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + time;
  }
  function link(ref) {
    const a = el('a', 'chat-ref', ref);
    a.href = ref;
    a.rel = 'noopener noreferrer';
    a.target = '_blank';
    return a;
  }
  const today = () => {
    const now = new Date();
    return String(now.getFullYear()) + String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0');
  };

  async function write(body) {
    try {
      const response = await fetch('/api/board/item', {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      let answer = null;
      try { answer = await response.json(); } catch { answer = null; }
      if (response.ok && answer && answer.ok === true) return { ok: true, answer };
      return { ok: false, text: errors[answer && answer.code] || '送れませんでした。もう一度お試しください。' };
    } catch {
      return { ok: false, text: '接続できません。通信を確かめてください。' };
    }
  }

  // --- the list of conversations
  const activity = (item) => Math.max(
    Number(item.chat && item.chat.last_at) || 0,
    Number(item.handoff && item.handoff.requested_at) || 0,
    Number(item.updated_at) || 0,
  );
  function conversations() {
    if (!board || !Array.isArray(board.items)) return [];
    return board.items
      .filter((item) => item.kind === 'task' && (item.chat || (item.handoff && (isPartner(item.handoff.to) || isPartner(item.handoff.accepted_by)))))
      .sort((a, b) => activity(b) - activity(a));
  }
  function mark(item) {
    if (item.chat && item.chat.open) return ['wait', '返事待ち'];
    const h = item.handoff;
    if (h && (h.state === 'requested' || h.state === 'accepted')) return ['work', '作業中'];
    return null;
  }
  function renderList() {
    const list = $('chat-list');
    list.replaceChildren();
    const rows = conversations();
    if (!rows.length) { list.append(el('li', 'chat-list-empty', 'まだ会話はありません。')); return; }
    for (const item of rows) {
      const li = el('li');
      const a = el('a', 'chat-list-item');
      a.href = '#' + encodeURIComponent(item.item_id);
      if (item.item_id === current) a.setAttribute('aria-current', 'true');
      const top = el('span', 'chat-list-title', item.title);
      const sub = el('span', 'chat-list-sub', item.project + '　' + when(activity(item)));
      const m = mark(item);
      if (m) { const badge = el('span', 'chat-dot ' + m[0], m[1]); sub.append(badge); }
      a.append(top, sub);
      li.append(a);
      list.append(li);
    }
  }
  function renderProjects() {
    const select = $('chat-start-project');
    if (!board) return;
    const keep = select.value || (() => { try { return localStorage.getItem(PROJECT_KEY) || localStorage.getItem('iris-board-project') || ''; } catch { return ''; } })();
    const names = [...new Set(board.items.map((i) => i.project))].sort((a, b) => a.localeCompare(b, 'ja'));
    select.replaceChildren(...names.map((n) => option(n, n)));
    if (names.includes(keep)) select.value = keep;
  }
  async function loadBoard() {
    try {
      const response = await fetch('/api/board', { cache: 'no-store' });
      if (!response.ok) {
        $('chat-list').replaceChildren(el('li', 'chat-list-empty', response.status === 401 ? 'ログインが切れています。開き直してください。' : '一覧を読めませんでした。'));
        return;
      }
      board = await response.json();
      renderList();
      renderProjects();
      if (current) {
        const item = board.items.find((i) => i.item_id === current);
        if (item) $('chat-title').textContent = item.title;
      }
    } catch {
      $('chat-list').replaceChildren(el('li', 'chat-list-empty', '接続できません。'));
    }
  }

  // --- one conversation
  function bubble(role, who, at, text, ref) {
    const row = el('div', 'chat-row ' + (role === 'owner' ? 'me' : 'ai'));
    const node = el('div', 'chat-msg');
    if (role !== 'owner') node.append(el('span', 'chat-who', who));
    node.append(el('div', 'chat-text', text));
    if (typeof ref === 'string' && ref.startsWith('https://')) node.append(link(ref));
    const t = el('span', 'chat-time', (role === 'owner' && who ? who + '　' : '') + when(at));
    row.append(node, t);
    return row;
  }
  function showConversation(data) {
    shown = data;
    $('chat-title').textContent = data.item.title;
    $('chat-meta').textContent = data.item.project + '　/　' + (states[data.item.state] || data.item.state);
    const log = $('chat-log');
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
    log.replaceChildren();
    const entries = [];
    if (data.handoff) entries.push({ at: data.handoff.requested_at || 0, role: 'owner', who: '→ ' + partnerLabel(data.handoff.to), text: data.handoff.title || data.item.title });
    for (const n of data.notes || []) {
      if (/^開始（picker/.test(n.text)) continue;
      entries.push({ at: n.at, role: 'agent', who: partnerLabel(n.actor), text: n.text, ref: n.ref });
    }
    for (const m of data.messages || []) {
      entries.push({ at: m.at, role: m.role, who: m.role === 'owner' ? '→ ' + partnerLabel(m.to) : partnerLabel(m.actor), text: m.text, ref: m.ref });
    }
    entries.sort((a, b) => a.at - b.at);
    for (const e of entries) log.append(bubble(e.role, e.who, e.at, e.text, e.ref));
    const open = data.open;
    let wait = '';
    if (open && open.status === 'waiting') wait = partnerLabel(open.to) + ' が 1 分以内に拾います…';
    else if (open && open.status === 'taken') wait = partnerLabel(open.to) + ' が考えています（' + Math.max(1, Math.round((Date.now() - open.at) / 60000)) + ' 分）…';
    else if (data.handoff && ['requested', 'accepted'].includes(data.handoff.state)) wait = partnerLabel(data.handoff.accepted_by || data.handoff.to) + ' が作業しています。終わると、ここに結果が出ます…';
    if (wait) log.append(el('div', 'chat-typing', wait));
    $('chat-state').textContent = '';
    const partner = $('chat-partner');
    if (document.activeElement !== partner) partner.value = data.partner || 'vps-claude';
    const blocked = Boolean(open);
    $('chat-text').disabled = blocked;
    $('chat-send').disabled = blocked;
    $('chat-text').placeholder = blocked ? '返事が来るまで待ってください' : '続けて書く（20,000 字まで）';
    if (nearBottom || !log.dataset.shown) { log.scrollTop = log.scrollHeight; log.dataset.shown = '1'; }
  }
  async function refreshConversation() {
    if (!current || busy) return;
    busy = true;
    const id = current;
    try {
      const response = await fetch('/api/board/chat?item_id=' + encodeURIComponent(id), { cache: 'no-store' });
      if (id !== current) return;
      if (response.ok) showConversation(await response.json());
      else $('chat-state').textContent = response.status === 401 ? 'ログインが切れています。このページを開き直してください。' : '会話を読めませんでした。';
    } catch {
      $('chat-state').textContent = '接続できません。通信を確かめてください。';
    } finally { busy = false; }
  }

  // --- which view: the hash names the open conversation
  function route() {
    const id = decodeURIComponent(location.hash.slice(1));
    clearInterval(chatTimer);
    chatTimer = null;
    closeSide();
    if (!id) {
      current = null;
      shown = null;
      $('chat-talk').hidden = true;
      $('chat-start').hidden = false;
      $('chat-title').textContent = '新しいチャット';
      $('chat-meta').textContent = '';
      renderList();
      if (!touch.matches) $('chat-start-text').focus();
      return;
    }
    current = id;
    $('chat-start').hidden = true;
    $('chat-talk').hidden = false;
    const log = $('chat-log');
    log.replaceChildren(el('p', 'chat-loading', '読み込んでいます…'));
    delete log.dataset.shown;
    $('chat-status').textContent = '';
    renderList();
    refreshConversation();
    chatTimer = setInterval(() => { if (!document.hidden) refreshConversation(); }, 8000);
  }

  // --- the side list on a narrow screen
  function openSide() { document.body.classList.add('side-open'); $('chat-scrim').hidden = false; }
  function closeSide() { document.body.classList.remove('side-open'); $('chat-scrim').hidden = true; }

  // Enter sends on a keyboard (Shift+Enter is a new line); on a phone Enter is a new line.
  function sendOnEnter(area, form) {
    area.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing || touch.matches) return;
      event.preventDefault();
      form.requestSubmit();
    });
  }
  function grow(area, max) {
    area.style.height = 'auto';
    area.style.height = Math.min(area.scrollHeight, max) + 'px';
  }

  function setup() {
    for (const id of ['chat-start-partner', 'chat-partner']) for (const [v, l] of partners) $(id).append(option(v, l));
    $('chat-new').addEventListener('click', () => { if (location.hash) location.hash = ''; else route(); });
    $('chat-side-open').addEventListener('click', openSide);
    $('chat-side-close').addEventListener('click', closeSide);
    $('chat-scrim').addEventListener('click', closeSide);
    $('chat-list').addEventListener('click', (event) => { if (event.target.closest('a')) closeSide(); });

    const startText = $('chat-start-text');
    const count = () => { $('chat-start-count').textContent = [...startText.value].length + ' / 200'; grow(startText, 220); };
    startText.addEventListener('input', count);
    sendOnEnter(startText, $('chat-start-form'));
    $('chat-start-project').addEventListener('change', (e) => { try { localStorage.setItem(PROJECT_KEY, e.target.value); } catch { /* private mode */ } });
    $('chat-start-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const status = $('chat-start-status');
      const text = startText.value.trim().replace(/\s+/g, ' ');
      const project = $('chat-start-project').value;
      if (!text) { status.textContent = '書いてから送ってください。'; return; }
      if (!project) { status.textContent = '案件を選んでください。'; return; }
      const send = $('chat-start-send');
      send.disabled = true;
      status.textContent = '送っています…';
      try {
        const day = today();
        const added = await write({ op: 'add', project, title: [...text].slice(0, 200).join(''), day });
        if (!added.ok) { status.textContent = added.text; return; }
        const itemId = added.answer.item.item_id;
        const handed = await write({ op: 'hand', item_id: itemId, day, to: $('chat-start-partner').value });
        if (!handed.ok) { status.textContent = '仕事は作りましたが、任せられませんでした（' + handed.text + '）。看板の「任せる」からやり直せます。'; return; }
        startText.value = '';
        count();
        status.textContent = '';
        await loadBoard();
        location.hash = encodeURIComponent(itemId);
      } finally { send.disabled = false; }
    });

    const text = $('chat-text');
    text.addEventListener('input', () => grow(text, 240));
    sendOnEnter(text, $('chat-form'));
    $('chat-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const status = $('chat-status');
      const body = text.value.trim();
      if (!current || !body) { status.textContent = '書いてから送ってください。'; return; }
      $('chat-send').disabled = true;
      status.textContent = '送っています…';
      const done = await write({ op: 'chat_send', item_id: current, text: body, to: $('chat-partner').value });
      $('chat-send').disabled = false;
      if (!done.ok) { status.textContent = done.text; return; }
      text.value = '';
      grow(text, 240);
      status.textContent = '';
      const log = $('chat-log');
      log.scrollTop = log.scrollHeight;
      showConversation(done.answer);
      loadBoard();
    });

    window.addEventListener('hashchange', route);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { loadBoard(); refreshConversation(); } });
    setInterval(() => { if (!document.hidden) loadBoard(); }, 30000);
    route();
    loadBoard();
  }
  setup();
})();
