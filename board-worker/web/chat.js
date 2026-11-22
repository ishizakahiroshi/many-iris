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
  const NO_PROJECT = 'chat';
  const narrow = window.matchMedia('(max-width: 760px)');
  const touch = window.matchMedia('(pointer: coarse)');

  let board = null;       // the board's page data
  let current = null;     // the open conversation's item id (null = new chat)
  let shown = null;       // the open conversation's data
  let chatTimer = null;
  let busy = false;
  let pending = [];       // attachments uploaded for the next message: {id, name, bytes, chars}
  let uploading = 0;
  // The new chat has no conversation yet, so its attachments wait here (not uploaded)
  // until the work is made and handed over: {key, name, text, bytes, chars}.
  let startPending = [];
  let startKey = 0;
  let freshId = null;     // the card just added (it pops in once)
  let startNote = '';     // what the first send could not do, shown on the conversation it opens

  // Attachments (see the design: docs/local/design_chat-attachments_2026-11-22.md).
  // A paste longer than this becomes an attachment card instead of text.
  const PASTE_ATTACH_CHARS = 2000;
  const FILE_RE = /\.(txt|md|log)$/i;
  const IMAGE_FILE_RE = /\.(png|jpe?g|webp|gif)$/i;
  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  // Images are scaled to this long side before they are sent; a PNG larger than
  // IMAGE_PNG_MAX after that is sent as JPEG.
  const IMAGE_EDGE = 1568;
  const IMAGE_PNG_MAX = 1536 * 1024;
  const attachErrors = {
    TOO_LARGE: '1 ファイルは 1 MB までです。',
    CONTENT_TYPE: 'テキストとして送れませんでした。',
    BOARD_EVENT_LIMIT: 'この会話の添付が上限に達しています。',
    FORBIDDEN: 'この会話には添付できません。',
  };
  const limits = () => (shown && shown.attachment_limits) || { max_bytes: 1048576, image_max_bytes: 5242880, per_message: 5 };
  const kb = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB');

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
      const sub = el('span', 'chat-list-sub', (item.project === NO_PROJECT ? '' : item.project + '　') + when(activity(item)));
      const m = mark(item);
      if (m) { const badge = el('span', 'chat-dot ' + m[0], m[1]); sub.append(badge); }
      a.append(top, sub);
      li.append(a);
      list.append(li);
    }
  }
  // A new chat belongs to no project unless one is chosen: it goes under
  // NO_PROJECT, which the server's workers run in a plain folder (no repository).
  function renderProjects() {
    const select = $('chat-start-project');
    if (!board) return;
    const keep = select.value || NO_PROJECT;
    const names = [...new Set(board.items.map((i) => i.project))].filter((n) => n !== NO_PROJECT).sort((a, b) => a.localeCompare(b, 'ja'));
    select.replaceChildren(option(NO_PROJECT, '案件なし'), ...names.map((n) => option(n, n)));
    select.value = names.includes(keep) ? keep : NO_PROJECT;
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
  function bubble(role, who, at, text, ref, attachments) {
    const row = el('div', 'chat-row ' + (role === 'owner' ? 'me' : 'ai'));
    const node = el('div', 'chat-msg');
    if (role !== 'owner') node.append(el('span', 'chat-who', who));
    if (text) node.append(el('div', 'chat-text', text));
    for (const a of attachments || []) {
      const image = IMAGE_TYPES.includes(a.mime);
      const label = image ? a.name : a.name + '（' + a.chars + ' 字）';
      if (a.expired) { node.append(el('span', 'chat-card gone', label + '　期限切れ')); continue; }
      const href = '/api/board/attachment?id=' + encodeURIComponent(a.id);
      if (image) {
        // A sent image is shown small; it opens full size in a new tab.
        const card = el('a', 'chat-shot');
        card.href = href;
        card.target = '_blank';
        card.rel = 'noopener noreferrer';
        const img = el('img');
        img.src = href;
        img.alt = a.name;
        img.loading = 'lazy';
        card.append(img);
        node.append(card);
        continue;
      }
      const card = el('a', 'chat-card', label);
      card.href = href;
      card.target = '_blank';
      card.rel = 'noopener noreferrer';
      node.append(card);
    }
    if (typeof ref === 'string' && ref.startsWith('https://')) node.append(link(ref));
    const t = el('span', 'chat-time', (role === 'owner' && who ? who + '　' : '') + when(at));
    row.append(node, t);
    return row;
  }
  function showConversation(data) {
    shown = data;
    $('chat-title').textContent = data.item.title;
    $('chat-meta').textContent = (data.item.project === NO_PROJECT ? '案件なし' : data.item.project) + '　/　' + (states[data.item.state] || data.item.state);
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
      entries.push({ at: m.at, role: m.role, who: m.role === 'owner' ? '→ ' + partnerLabel(m.to) : partnerLabel(m.actor), text: m.text, ref: m.ref, attachments: m.attachments });
    }
    entries.sort((a, b) => a.at - b.at);
    for (const e of entries) log.append(bubble(e.role, e.who, e.at, e.text, e.ref, e.attachments));
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
    discardPending();
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
    $('chat-status').textContent = startNote;
    startNote = '';
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

  // --- attachments
  // A file to attach, before it is stored: {name, body (text or image Blob), type, bytes, chars, thumb}.
  const TEXT_TYPE = 'text/plain; charset=utf-8';
  const isImage = (type) => IMAGE_TYPES.includes(type);
  function textFile(name, text) {
    return { name, body: text, type: TEXT_TYPE, bytes: new Blob([text]).size, chars: [...text].length, thumb: null };
  }
  // The card's words: "name（N 字・12 KB）" for text, "name（12 KB）" for an image.
  const cardLabel = (a) => a.name + '（' + (isImage(a.type || a.mime) ? '' : a.chars + ' 字・') + kb(a.bytes) + '）';
  function cardFor(a, fresh, onDrop) {
    const li = el('li', fresh ? 'chat-card fresh' : 'chat-card');
    if (a.thumb) { const img = el('img', 'chat-thumb'); img.src = a.thumb; img.alt = ''; li.append(img); }
    li.append(el('span', null, cardLabel(a)));
    const x = el('button', 'quiet chat-card-x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', a.name + ' をやめる');
    x.addEventListener('click', onDrop);
    li.append(x);
    return li;
  }
  const forget = (a) => { if (a.thumb) URL.revokeObjectURL(a.thumb); };
  // Checks a file against the limits; '' when it may be attached.
  function tooBig(file) {
    if (isImage(file.type)) return file.bytes > limits().image_max_bytes ? '1 枚の画像は 5 MB までです。' : '';
    return file.bytes > limits().max_bytes ? '1 ファイルは 1 MB までです。' : '';
  }

  function renderPending() {
    const list = $('chat-attach');
    list.replaceChildren();
    for (const a of pending) list.append(cardFor(a, a.id === freshId, () => dropPending(a.id)));
    list.hidden = !pending.length;
    freshId = null;
  }
  const takeBack = (id) => fetch('/api/board/attachment?item_id=' + encodeURIComponent(current) + '&id=' + encodeURIComponent(id), { method: 'DELETE' }).catch(() => {});
  function dropPending(id) {
    for (const a of pending) if (a.id === id) forget(a);
    pending = pending.filter((a) => a.id !== id);
    renderPending();
    if (current) takeBack(id);
  }
  // Unsent attachments of the conversation being left are taken back (best effort).
  function discardPending() {
    const left = pending;
    pending = [];
    for (const a of left) { forget(a); if (current) takeBack(a.id); }
    renderPending();
  }
  // Stores one attachment on a conversation. {ok, attachment} or {ok:false, text}.
  async function upload(itemId, file) {
    try {
      const response = await fetch('/api/board/attachment?item_id=' + encodeURIComponent(itemId) + '&name=' + encodeURIComponent(file.name), {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': file.type },
        body: file.body,
      });
      let answer = null;
      try { answer = await response.json(); } catch { answer = null; }
      if (response.ok && answer && answer.ok === true) return { ok: true, attachment: answer.attachment };
      return { ok: false, text: attachErrors[answer && answer.code] || errors[answer && answer.code] || '添付できませんでした。' };
    } catch {
      return { ok: false, text: '接続できません。通信を確かめてください。' };
    }
  }
  async function attach(file) {
    const status = $('chat-status');
    if (!current || $('chat-text').disabled) { status.textContent = '返事が来てから添付してください。'; forget(file); return false; }
    if (pending.length >= limits().per_message) { status.textContent = '1 回に添付できるのは ' + limits().per_message + ' 件までです。'; forget(file); return false; }
    const big = tooBig(file);
    if (big) { status.textContent = big; forget(file); return false; }
    uploading += 1;
    $('chat-send').disabled = true;
    status.textContent = '添付を保管しています…';
    try {
      const stored = await upload(current, file);
      if (!stored.ok) { status.textContent = stored.text; forget(file); return false; }
      const a = stored.attachment;
      pending.push({ id: a.id, name: a.name, bytes: a.bytes, chars: a.chars, type: file.type, thumb: file.thumb });
      freshId = a.id;
      renderPending();
      status.textContent = '';
      return true;
    } finally {
      uploading -= 1;
      if (!uploading) $('chat-send').disabled = Boolean(shown && shown.open);
    }
  }

  // An image as it will be sent: a screenshot larger than IMAGE_EDGE on its long side is
  // scaled down (the AI sees no more detail than that, and it costs fewer of its tokens).
  // Returns a file to attach, or null when the browser cannot read the image.
  async function imageFile(blob, name) {
    let bitmap;
    try { bitmap = await createImageBitmap(blob); } catch { return null; }
    const scale = Math.min(1, IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    let out = blob;
    if (scale < 1 || !isImage(blob.type)) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const encode = (type, quality) => new Promise((done) => canvas.toBlob(done, type, quality));
      out = await encode('image/png');
      // A photo is far smaller as JPEG; a screenshot usually stays PNG.
      if (!out || out.size > IMAGE_PNG_MAX) out = await encode('image/jpeg', 0.9);
      if (!out) { bitmap.close(); return null; }
    }
    bitmap.close();
    const type = out.type;
    const base = name.replace(/\.[^.]*$/, '');
    const fixed = base + (type === 'image/jpeg' ? '.jpg' : type === 'image/webp' ? '.webp' : type === 'image/gif' ? '.gif' : '.png');
    return { name: fixed, body: out, type, bytes: out.size, chars: 0, thumb: URL.createObjectURL(out) };
  }
  // Reads the chosen, dropped or pasted files and hands each to `add(file)` (stops when it returns false).
  async function readFiles(files, status, add) {
    for (const file of files) {
      if (IMAGE_FILE_RE.test(file.name) || isImage(file.type)) {
        const image = await imageFile(file, file.name || 'スクリーンショット.png');
        if (!image) { status.textContent = '画像を読めませんでした。'; continue; }
        if (!await add(image)) break;
        continue;
      }
      if (!FILE_RE.test(file.name)) { status.textContent = '添付できるのは .txt .md .log と画像（PNG・JPEG・WebP・GIF）です。'; continue; }
      if (file.size > limits().max_bytes) { status.textContent = '1 ファイルは 1 MB までです。'; continue; }
      let text;
      try { text = await file.text(); } catch { status.textContent = 'ファイルを読めませんでした。'; continue; }
      if (!await add(textFile(file.name, text))) break;
    }
  }
  const attachFiles = (files) => readFiles(files, $('chat-status'), attach);
  // A paste: images on the clipboard (a screenshot) are attached; a long text becomes
  // a card; a short text goes into the box as usual.
  function onPaste(event, status, add) {
    const data = event.clipboardData;
    if (!data) return;
    const images = [...data.files].filter((f) => isImage(f.type));
    if (images.length) {
      event.preventDefault();
      readFiles(images.map((f) => (f.name ? f : new File([f], 'スクリーンショット.png', { type: f.type }))), status, add);
      return;
    }
    const pasted = data.getData('text/plain');
    if ([...pasted].length <= PASTE_ATTACH_CHARS) return;
    event.preventDefault();
    add(textFile('貼り付け.txt', pasted));
  }

  // Dragging files over an area lights up its box ("ここに置くと添付"); dropping attaches them.
  // enter/leave fire for every child, so a counter tells when the drag really left.
  function dropZone(area, box, onFiles) {
    let depth = 0;
    const hasFiles = (event) => event.dataTransfer && [...event.dataTransfer.types].includes('Files');
    const off = () => { depth = 0; box.classList.remove('drop-over'); };
    area.addEventListener('dragenter', (event) => { if (!hasFiles(event)) return; depth += 1; box.classList.add('drop-over'); });
    area.addEventListener('dragover', (event) => { if (hasFiles(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
    area.addEventListener('dragleave', (event) => { if (!hasFiles(event)) return; depth -= 1; if (depth <= 0) off(); });
    area.addEventListener('drop', (event) => {
      off();
      if (!event.dataTransfer || !event.dataTransfer.files.length) return;
      event.preventDefault();
      onFiles([...event.dataTransfer.files]);
    });
  }

  // --- attachments of the new chat (kept in the page until the first send)
  function renderStartPending() {
    const list = $('chat-start-attach');
    list.replaceChildren();
    for (const a of startPending) {
      list.append(cardFor(a, a.key === freshId, () => { forget(a); startPending = startPending.filter((b) => b.key !== a.key); renderStartPending(); }));
    }
    list.hidden = !startPending.length;
    freshId = null;
  }
  function addStart(file) {
    const status = $('chat-start-status');
    if (startPending.length >= limits().per_message) { status.textContent = '1 回に添付できるのは ' + limits().per_message + ' 件までです。'; forget(file); return false; }
    const big = tooBig(file);
    if (big) { status.textContent = big; forget(file); return false; }
    startPending.push({ ...file, key: ++startKey });
    freshId = startKey;
    renderStartPending();
    status.textContent = '';
    return true;
  }
  function startTitle() {
    const first = startPending[0];
    if (!first) return '';
    const line = isImage(first.type) ? '' : first.body.split(/\r?\n/).map((l) => l.trim().replace(/\s+/g, ' ')).find(Boolean) || '';
    return [...(line || first.name)].slice(0, 80).join('');
  }
  // After the work is made and handed over, its attachments go as the first message.
  // Returns '' or why they could not be sent.
  async function sendStartAttachments(itemId, to) {
    const ids = [];
    for (const a of startPending) {
      const stored = await upload(itemId, a);
      if (!stored.ok) return a.name + ' を添付できませんでした（' + stored.text + '）';
      ids.push(stored.attachment.id);
    }
    const sent = await write({ op: 'chat_send', item_id: itemId, text: '', to, attachments: ids });
    return sent.ok ? '' : '添付を送れませんでした（' + sent.text + '）';
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
    // The same attachments as in a conversation: a long paste, a chosen or dropped file.
    startText.addEventListener('paste', (event) => onPaste(event, $('chat-start-status'), addStart));
    const addStartFiles = (files) => readFiles(files, $('chat-start-status'), addStart);
    $('chat-start-file').addEventListener('change', (event) => { addStartFiles([...event.target.files]); event.target.value = ''; });
    dropZone($('chat-start'), $('chat-start-form'), addStartFiles);
    $('chat-start-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const status = $('chat-start-status');
      const text = startText.value.trim().replace(/\s+/g, ' ');
      const project = $('chat-start-project').value;
      // With only attachments, the first line of the first one (or its name) is the title.
      const title = text || startTitle();
      if (!title) { status.textContent = '書くか、添付してから送ってください。'; return; }
      if (!project) { status.textContent = '案件を選んでください。'; return; }
      const send = $('chat-start-send');
      send.disabled = true;
      status.textContent = '送っています…';
      try {
        const day = today();
        const added = await write({ op: 'add', project, title: [...title].slice(0, 200).join(''), day });
        if (!added.ok) { status.textContent = added.text; return; }
        const itemId = added.answer.item.item_id;
        const to = $('chat-start-partner').value;
        const handed = await write({ op: 'hand', item_id: itemId, day, to });
        if (!handed.ok) { status.textContent = '仕事は作りましたが、任せられませんでした（' + handed.text + '）。看板の「任せる」からやり直せます。'; return; }
        const missed = startPending.length ? await sendStartAttachments(itemId, to) : '';
        startText.value = '';
        for (const a of startPending) forget(a);
        startPending = [];
        renderStartPending();
        $('chat-start-project').value = NO_PROJECT;
        count();
        await loadBoard();
        // The conversation page shows its own status line; route() says there what did not go.
        startNote = '';
        status.textContent = '';
        if (missed) startNote = '仕事は任せました。' + missed + '。続けて添付し直せます。';
        location.hash = encodeURIComponent(itemId);
      } finally { send.disabled = false; }
    });

    const text = $('chat-text');
    text.addEventListener('input', () => grow(text, 240));
    sendOnEnter(text, $('chat-form'));
    // A screenshot or a long paste becomes an attachment card; the page never puts it in the box.
    text.addEventListener('paste', (event) => onPaste(event, $('chat-status'), attach));
    $('chat-file').addEventListener('change', (event) => { attachFiles([...event.target.files]); event.target.value = ''; });
    dropZone($('chat-talk'), $('chat-form'), attachFiles);
    $('chat-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const status = $('chat-status');
      const body = text.value.trim();
      if (uploading) { status.textContent = '添付を保管しています。少し待ってください。'; return; }
      if (!current || (!body && !pending.length)) { status.textContent = '書いてから送ってください。'; return; }
      $('chat-send').disabled = true;
      status.textContent = '送っています…';
      const message = { op: 'chat_send', item_id: current, text: body, to: $('chat-partner').value };
      if (pending.length) message.attachments = pending.map((a) => a.id);
      const done = await write(message);
      $('chat-send').disabled = false;
      if (!done.ok) { status.textContent = done.text; return; }
      text.value = '';
      for (const a of pending) forget(a);
      pending = [];
      renderPending();
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
