'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const token = document.querySelector('meta[name="iris-ui-token"]')?.content || '';
  const states = { planned: '予定', in_progress: '進行中', waiting: '待ち', done: '完了', stopped: '停止' };
  const kinds = { project: '案件', plan: '計画', context: '文脈', issue: 'Issue', pr: 'PR', task: '作業' };
  const eventKinds = { session_start: '作業開始', session_end: '作業終了', note: 'メモ', state_change: '状態の変更' };
  // Work (kind task) carries one more mark: on the pile and not started, or a
  // record of work that was done. Work handed out by Iris will get a third mark
  // when Iris keeps such requests; the board holds none yet.
  const workMark = (item) => {
    if (item.handoff && item.handoff.state === 'requested' && item.handoff.to === 'hold') return '任せた・保留中';
    if (item.handoff && item.handoff.state === 'requested') return '任せた・まだ受けていない';
    if (item.handoff && item.handoff.state === 'accepted') return '任せた・受けた';
    if (item.handoff && item.handoff.state === 'unknown') return '任せた・状態不明';
    if (item.handoff && item.handoff.state === 'completed') return '任せた・終わった';
    return item.state === 'planned' ? '積んである' : '記録だけ';
  };
  const writeErrors = {
    REVISION_CONFLICT: 'ほかの書き込みで変わっていました。読み直してから、もう一度お試しください。',
    HANDOFF_CONFLICT: '任せた状態が変わっていました。読み直してから、もう一度お試しください。',
    STALE_GENERATION: '古い実行からの書き込みでした。新しい実行が進んでいます。',
    CYCLE: 'その仕事の下にある仕事の下へは入れられません。',
    DEPTH: '段が深くなりすぎます（6 段まで）。',
    PARENT_NOT_FOUND: '入れる先が見つかりません。読み直してください。',
    NOT_FOUND: '相手が見つかりません。読み直してください。',
    PROJECT_MISMATCH: '別の案件の下へは入れられません。',
    INVALID: '入力を確かめてください（題名は 1〜200 字）。',
    BOARD_ITEM_LIMIT: '看板の項目が上限に達しています。',
    AUTH: 'ログインが切れています。このページを開き直してください。',
    FORBIDDEN: 'この操作はできません。',
  };
  let loading = false;
  // The project the page shows ('' = every project), kept on this device, and
  // the item the last search found (outlined until the next search).
  const PROJECT_KEY = 'iris-board-project';
  let shownProject = '';
  try { shownProject = localStorage.getItem(PROJECT_KEY) || ''; } catch { shownProject = ''; }
  let foundId = null;
  let lastData = null;
  // True when the board says it takes the owner's writes from this page.
  let canWrite = false;

  function el(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined && content !== null) node.textContent = String(content);
    return node;
  }
  function when(ms) {
    return Number.isFinite(Number(ms)) ? new Date(Number(ms)).toLocaleString('ja-JP') : '未確認';
  }
  function stateBadge(state) {
    const node = el('span', 'badge', states[state] || '未対応の状態');
    if (state === 'done') node.classList.add('good');
    else if (state === 'waiting') node.classList.add('attention');
    else if (state === 'stopped') node.classList.add('danger');
    else if (state === 'in_progress') node.classList.add('active');
    return node;
  }
  function sourceNode(ref) {
    // Only an https URL becomes a link; a repository path is shown as text.
    if (typeof ref === 'string' && ref.startsWith('https://')) {
      const link = el('a', null, ref);
      link.href = ref;
      link.rel = 'noopener noreferrer';
      link.target = '_blank';
      return link;
    }
    return el('span', null, ref);
  }
  function eventLine(event, withProject) {
    const node = el('div');
    node.append(el('span', 'who', (eventKinds[event.kind] || event.kind) + ' / ' + event.actor));
    node.append(el('span', 'board-text', ' ' + event.text));
    if (withProject) node.append(el('span', 'who', '  [' + event.project + ' / ' + event.item_id + ']'));
    if (typeof event.ref === 'string' && event.ref.startsWith('https://')) {
      node.append(document.createTextNode(' '));
      node.append(sourceNode(event.ref));
    }
    node.append(el('time', null, when(event.at)));
    return node;
  }
  async function write(body, status, button) {
    button.disabled = true;
    status.textContent = '書き込んでいます…';
    try {
      const response = await fetch('/api/board/item', {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(body),
      });
      let answer = null;
      try { answer = await response.json(); } catch { answer = null; }
      // The board's answer (truthy) on success, so a caller can go on with it.
      if (response.ok && answer && answer.ok === true) return answer;
      status.textContent = writeErrors[answer && answer.code] || '書き込めませんでした。読み直してから、もう一度お試しください。';
      return null;
    } catch {
      status.textContent = '接続できません。通信を確かめてから、もう一度お試しください。';
      return null;
    } finally { button.disabled = false; }
  }
  function option(value, label) {
    const node = el('option', null, label);
    node.value = value;
    return node;
  }
  const short = (text) => { const chars = [...String(text)]; return chars.length > 48 ? chars.slice(0, 47).join('') + '…' : String(text); };
  // The items a piece of work may go under: every item of its project, except
  // itself and whatever is already under it.
  function parentChoices(select, peers, self) {
    const below = new Set();
    if (self) {
      below.add(self.item_id);
      for (let grew = true; grew;) {
        grew = false;
        for (const p of peers) if (p.parent_id && below.has(p.parent_id) && !below.has(p.item_id)) { below.add(p.item_id); grew = true; }
      }
    }
    select.append(option('', '（どこにも入れない）'));
    for (const p of peers) if (!below.has(p.item_id)) select.append(option(p.item_id, (kinds[p.kind] || p.kind) + '：' + short(p.title)));
  }
  function moveControl(item, peers) {
    const box = el('details', 'board-write');
    box.append(el('summary', null, '入れる先を変える'));
    const row = el('div', 'board-write-row');
    const select = el('select');
    select.setAttribute('aria-label', 'この作業を入れる先');
    parentChoices(select, peers, item);
    select.value = item.parent_id && [...select.options].some((o) => o.value === item.parent_id) ? item.parent_id : '';
    const button = el('button', 'quiet', '付け替える');
    button.type = 'button';
    const status = el('span', 'board-write-status');
    status.setAttribute('role', 'status');
    button.addEventListener('click', async () => {
      const done = await write({ op: 'attach', item_id: item.item_id, parent_id: select.value || null, expected_revision: item.revision }, status, button);
      if (done) load(true);
    });
    row.append(select, button, status);
    box.append(row);
    return box;
  }
  // Up and down within the pile: the planned work next to this one.
  function orderControl(item) {
    const row = el('div', 'board-order');
    const status = el('span', 'board-write-status');
    status.setAttribute('role', 'status');
    for (const [direction, label] of [['up', '上へ'], ['down', '下へ']]) {
      const button = el('button', 'quiet', label);
      button.type = 'button';
      button.setAttribute('aria-label', '「' + short(item.title) + '」を' + label);
      button.addEventListener('click', async () => {
        const done = await write({ op: 'move', item_id: item.item_id, direction }, status, button);
        if (done) load(true);
      });
      row.append(button);
    }
    row.append(status);
    return row;
  }
  // Where handed-over work goes (handoff.to): a tool and the place it runs.
  // '' = おまかせ (the board goes down the owner's order).
  const targets = [
    ['', 'おまかせ'], ['vps-claude', 'VPS の claude -p'], ['local-claude', '手元 PC の claude -p'],
    ['devin', 'Devin（クラウド）'], ['vps-devin', 'Devin（VPS）'], ['local-devin', 'Devin（手元 PC）'],
    ['muse', 'Muse'], ['grokbot', 'GrokBot'], ['owner', '自分'], ['hold', '保留'],
  ];
  const targetLabel = (to) => (targets.find(([value]) => value === (to || '')) || [null, to])[1];
  // Where おまかせ sent a request, read off the dispatcher's event on it.
  function routedNote(item) {
    const event = item.last_event;
    if (!event || event.actor !== 'dispatcher' || typeof event.text !== 'string') return null;
    const placed = /^routed to ([a-z-]+): number (\d+) in the owner's order/.exec(event.text);
    if (placed && placed[1] === item.handoff.to) return 'おまかせ → ' + targetLabel(placed[1]) + '（順番の ' + placed[2] + ' 番目）';
    if (item.handoff.to === 'hold' && /^routed to hold: /.test(event.text)) return 'おまかせ → 保留（順番の相手が、だれも拾っていませんでした）';
    return null;
  }
  function targetSelect(item, current) {
    const select = el('select');
    select.setAttribute('aria-label', '「' + short(item.title) + '」の行き先');
    for (const [value, label] of targets) select.append(option(value, label));
    select.value = current || '';
    return select;
  }
  // Handing a piece of work on the pile to an AI, choosing or changing where it
  // goes while nobody has taken it, and taking it back.
  function handControl(item) {
    const row = el('div', 'board-order');
    const status = el('span', 'board-write-status');
    status.setAttribute('role', 'status');
    const asked = item.handoff && item.handoff.state === 'requested';
    const select = targetSelect(item, asked ? item.handoff.to : '');
    const button = el('button', 'quiet', asked ? '取り下げる' : '任せる');
    button.type = 'button';
    button.setAttribute('aria-label', '「' + short(item.title) + '」を' + (asked ? '任せるのを取り下げる' : '選んだ行き先へ任せる'));
    button.addEventListener('click', async () => {
      const day = new Date();
      const local = String(day.getFullYear()) + String(day.getMonth() + 1).padStart(2, '0') + String(day.getDate()).padStart(2, '0');
      const body = asked ? { op: 'take_back', item_id: item.item_id } : { op: 'hand', item_id: item.item_id, day: local };
      if (!asked && select.value) body.to = select.value;
      const done = await write(body, status, button);
      if (done) load(true);
    });
    if (asked) {
      row.append(el('span', 'board-write-note', '行き先：' + (routedNote(item) || targetLabel(item.handoff.to)) + '　依頼の番号：' + item.handoff.request_id + '（' + when(item.handoff.requested_at) + '）'));
      // Changing the destination; a request on hold or on the owner waits for this.
      const reroute = el('button', 'quiet', '行き先を変える');
      reroute.type = 'button';
      reroute.setAttribute('aria-label', '「' + short(item.title) + '」の行き先を変える');
      reroute.addEventListener('click', async () => {
        const done = await write({ op: 'route', item_id: item.item_id, to: select.value || null }, status, reroute);
        if (done) load(true);
      });
      row.append(select, reroute, button);
    } else {
      row.append(select, button);
    }
    row.append(status);
    return row;
  }
  // A session on the PC that stopped: hand its continuation to an AI in one
  // press. The board puts "<session> の続き" under the session and hands it
  // over; the taker reads the session's progress record and goes on from it.
  // One open continuation per session, so the button gives way to its state.
  const sessionItem = /^session\/\d+(?:\/\d+)?$/;
  function continueControl(item, peers) {
    const row = el('div', 'board-order');
    const status = el('span', 'board-write-status');
    status.setAttribute('role', 'status');
    const open = peers.find((p) => p.parent_id === item.item_id && p.handoff && ['requested', 'accepted', 'unknown'].includes(p.handoff.state));
    if (open) {
      row.append(el('span', 'board-write-note', '続きを任せています：' + targetLabel(open.handoff.to) + '　依頼の番号：' + open.handoff.request_id));
      return row;
    }
    const select = targetSelect(item, 'vps-claude');
    select.setAttribute('aria-label', '「' + short(item.title) + '」の続きの行き先');
    const button = el('button', 'quiet', '続きを任せる');
    button.type = 'button';
    button.setAttribute('aria-label', '「' + short(item.title) + '」の続きを、選んだ行き先へ任せる');
    button.addEventListener('click', async () => {
      const day = new Date();
      const local = String(day.getFullYear()) + String(day.getMonth() + 1).padStart(2, '0') + String(day.getDate()).padStart(2, '0');
      const body = { op: 'continue', item_id: item.item_id, day: local };
      if (select.value) body.to = select.value;
      const done = await write(body, status, button);
      if (done) load(true);
    });
    row.append(select, button, status);
    return row;
  }
  // Recovery for a run whose outcome is unknown. Nothing here restarts work
  // on its own: marking unknown only quarantines it, and the work goes back
  // to the pile only when the owner presses the button that says the old run
  // was confirmed stopped.
  function recoveryControl(item) {
    const row = el('div', 'board-order');
    const status = el('span', 'board-write-status');
    status.setAttribute('role', 'status');
    const add = (label, op, aria) => {
      const button = el('button', 'quiet', label);
      button.type = 'button';
      button.setAttribute('aria-label', aria);
      button.addEventListener('click', async () => {
        const done = await write({ op, item_id: item.item_id, request_id: item.handoff.request_id }, status, button);
        if (done) load(true);
      });
      row.append(button);
    };
    if (item.handoff.state === 'accepted' && item.handoff.lease_expired)
      add('状態不明にする', 'mark_unknown', '「' + short(item.title) + '」の実行を状態不明にする');
    if (item.handoff.state === 'unknown') {
      add('停止を確認したので戻す', 'release', '「' + short(item.title) + '」を、担当の停止を確認したうえで積み直す');
      add('まだ作業中なので続ける', 'resume', '「' + short(item.title) + '」の実行を、まだ作業中と確認して続ける');
    }
    row.append(status);
    return row;
  }
  function addControl(project, peers) {
    const box = el('div', 'board-add');
    box.append(el('h3', null, '仕事を積む'));
    const row = el('div', 'board-write-row');
    const title = el('input');
    title.type = 'text';
    title.maxLength = 200;
    title.placeholder = 'やること（1〜200 字）';
    title.setAttribute('aria-label', '積む仕事の題名');
    const select = el('select');
    select.setAttribute('aria-label', '入れる先');
    parentChoices(select, peers, null);
    // Where the work goes when it is asked for at once (頼む): '' = おまかせ.
    const to = targetSelect({ title: '新しい仕事' }, '');
    to.setAttribute('aria-label', '頼むときの行き先');
    const button = el('button', 'quiet', '積む');
    button.type = 'button';
    const ask = el('button', 'board-ask', '頼む');
    ask.type = 'button';
    ask.setAttribute('aria-label', '積んで、選んだ行き先へそのまま任せる');
    const talk = el('button', 'quiet', '話して頼む');
    talk.type = 'button';
    talk.setAttribute('aria-label', '積んで任せ、そのまま会話を開く');
    const status = el('span', 'board-write-status');
    status.setAttribute('role', 'status');
    const send = async (andHand, andTalk) => {
      const text = title.value.trim();
      if (!text) { status.textContent = '題名を入れてください。'; return; }
      const now = new Date();
      // This device's calendar day, for the new item's id.
      const day = String(now.getFullYear()) + String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0');
      const body = { op: 'add', project, title: text, day };
      if (select.value) body.parent_id = select.value;
      const added = await write(body, status, andTalk ? talk : andHand ? ask : button);
      if (!added) return;
      title.value = '';
      if (andHand) {
        // The work is on the pile now; hand it over as the card's 任せる would.
        const hand = { op: 'hand', item_id: added.item.item_id, day };
        if (to.value) hand.to = to.value;
        const handed = await write(hand, status, andTalk ? talk : ask);
        if (!handed) status.textContent = '積みましたが、任せられませんでした。カードの「任せる」から、もう一度お試しください。';
        else if (andTalk) openChat(added.item.item_id);
      }
      load(true);
    };
    button.addEventListener('click', () => send(false));
    ask.addEventListener('click', () => send(true));
    talk.addEventListener('click', () => send(true, true));
    title.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.isComposing) send(false); });
    const how = el('div', 'board-write-row');
    how.append(el('span', 'board-write-note', '行き先'), to, ask, talk, button);
    row.append(title, select);
    box.append(row, how, status);
    return box;
  }
  // The owner's order for おまかせ (the board's own data: the Rust board has
  // none, and then nothing is shown). One line on top; 変える opens the list,
  // where each change is saved at once.
  let routeOpen = false;
  function routeSection(route) {
    const host = $('board-route');
    host.replaceChildren();
    if (!route || !Array.isArray(route.order) || !Array.isArray(route.targets)) { host.hidden = true; return; }
    host.hidden = false;
    const alive = new Map(route.targets.map((t) => [t.target, t.alive === true]));
    const order = route.order.filter((t) => alive.has(t));
    const line = el('p', 'board-route-line');
    line.append(el('strong', null, 'おまかせの順番：'));
    if (!order.length) line.append(el('span', null, '保留だけ'));
    order.forEach((t) => {
      line.append(el('span', null, targetLabel(t)));
      if (!alive.get(t)) line.append(el('span', 'board-route-off', '（拾い手なし）'));
      line.append(el('span', null, '→'));
    });
    if (order.length) line.append(el('span', null, '保留'));
    host.append(line);
    if (!canWrite) return;
    const box = el('details', 'board-write board-route-edit');
    box.open = routeOpen;
    box.addEventListener('toggle', () => { routeOpen = box.open; });
    box.append(el('summary', null, '変える'));
    const status = el('span', 'board-write-status');
    status.setAttribute('role', 'status');
    const save = async (next, button) => {
      const done = await write({ op: 'order', order: next }, status, button);
      if (done) load(true);
    };
    const list = el('ol', 'board-route-list');
    const rows = [...order, ...route.targets.map((t) => t.target).filter((t) => !order.includes(t))];
    rows.forEach((t) => {
      const used = order.includes(t);
      const at = order.indexOf(t);
      const li = el('li', 'board-route-row');
      li.append(el('span', 'board-route-rank', used ? String(at + 1) : '—'));
      li.append(el('span', 'board-route-name', targetLabel(t)));
      li.append(el('span', alive.get(t) ? 'badge good' : 'badge off', alive.get(t) ? '拾っています' : '拾い手なし'));
      const label = el('label');
      const box2 = el('input');
      box2.type = 'checkbox';
      box2.checked = used;
      box2.setAttribute('aria-label', targetLabel(t) + 'をおまかせで使う');
      box2.addEventListener('change', () => save(used ? order.filter((x) => x !== t) : [...order, t], box2));
      label.append(box2, el('span', null, 'おまかせで使う'));
      li.append(label);
      if (used) {
        for (const [shift, text] of [[-1, '上へ'], [1, '下へ']]) {
          const button = el('button', 'quiet', text);
          button.type = 'button';
          button.setAttribute('aria-label', targetLabel(t) + 'を' + text);
          button.disabled = at + shift < 0 || at + shift >= order.length;
          button.addEventListener('click', () => {
            const next = [...order];
            [next[at], next[at + shift]] = [next[at + shift], next[at]];
            save(next, button);
          });
          li.append(button);
        }
      }
      list.append(li);
    });
    const last = el('li', 'board-route-row');
    last.append(el('span', 'board-route-rank', '末'), el('span', 'board-route-name', '保留（だれも拾っていないとき）'), el('span', 'board-route-off', 'いつも最後です。動かせません'));
    list.append(last);
    box.append(el('p', 'board-hint', '上から順に、いま拾っている最初の相手へ渡します。押した時点で保存されます。拾い手なしの相手は、印が付いていても飛ばします。'));
    box.append(list, status);
    host.append(box);
  }
  // --- 話す: a conversation with the server's AI workers about one piece of
  // work. Messages go to the board (op chat_send); the worker on the server
  // takes the turn within a minute, continues from the whole conversation and
  // answers. The page asks the board again every few seconds while open.
  const chatTargets = [['vps-claude', 'VPS の claude -p'], ['vps-devin', 'Devin（VPS）']];
  const isTalker = (who) => chatTargets.some(([t]) => t === who);
  function canTalk(item) {
    if (item.kind !== 'task') return false;
    if (item.chat) return true;
    const h = item.handoff;
    return Boolean(h && (isTalker(h.to) || isTalker(h.accepted_by)));
  }
  function talkControl(item) {
    const row = el('div', 'board-order');
    const button = el('button', 'quiet board-talk', '話す');
    button.type = 'button';
    button.setAttribute('aria-label', '「' + short(item.title) + '」について VPS の AI と話す');
    button.addEventListener('click', () => openChat(item.item_id));
    row.append(button);
    if (item.chat) row.append(el('span', 'board-write-note', item.chat.open ? '返事を待っています' : '会話 ' + item.chat.messages + ' 件'));
    return row;
  }
  let chatItem = null;
  let chatTimer = null;
  let chatBusy = false;
  function chatShell() {
    let host = $('board-chat');
    if (host) return host;
    host = el('section', 'board-chat');
    host.id = 'board-chat';
    host.setAttribute('aria-label', '会話');
    host.hidden = true;
    const head = el('div', 'board-chat-head');
    const back = el('button', 'quiet', '← 看板へ');
    back.type = 'button';
    back.addEventListener('click', closeChat);
    const title = el('p', 'board-chat-title');
    title.id = 'board-chat-title';
    const meta = el('div', 'board-chat-meta');
    meta.id = 'board-chat-meta';
    head.append(back, title, meta);
    const list = el('div', 'board-chat-list');
    list.id = 'board-chat-list';
    const state = el('p', 'board-chat-state');
    state.id = 'board-chat-state';
    state.setAttribute('role', 'status');
    const form = el('form', 'board-chat-form');
    const partner = el('select');
    partner.id = 'board-chat-partner';
    partner.setAttribute('aria-label', '話す相手');
    for (const [value, label] of chatTargets) partner.append(option(value, label));
    const text = el('textarea');
    text.id = 'board-chat-text';
    text.rows = 3;
    text.maxLength = 20000;
    text.placeholder = '書いて「送る」（20,000 字まで）';
    text.setAttribute('aria-label', '送る文');
    const sendButton = el('button', 'board-ask', '送る');
    sendButton.type = 'submit';
    const status = el('span', 'board-write-status');
    status.setAttribute('role', 'status');
    form.append(partner, text, sendButton, status);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const body = text.value.trim();
      if (!body) { status.textContent = '書いてから送ってください。'; return; }
      const done = await write({ op: 'chat_send', item_id: chatItem, text: body, to: partner.value }, status, sendButton);
      if (done) { text.value = ''; status.textContent = ''; showChat(done); }
    });
    host.append(head, list, state, form);
    document.body.append(host);
    return host;
  }
  function bubble(role, who, at, text, ref) {
    const node = el('div', 'board-msg ' + (role === 'owner' ? 'me' : 'ai'));
    node.append(el('span', 'who', who + '　' + when(at)));
    node.append(el('div', 'board-text', text));
    if (typeof ref === 'string' && ref.startsWith('https://')) node.append(sourceNode(ref));
    return node;
  }
  const talkerLabel = (who) => (chatTargets.find(([t]) => t === who) || [null, who])[1];
  function showChat(data) {
    const host = chatShell();
    $('board-chat-title').textContent = data.item.title;
    const meta = $('board-chat-meta');
    meta.replaceChildren(el('span', null, data.item.project + '　/　' + (states[data.item.state] || data.item.state)));
    const list = $('board-chat-list');
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    list.replaceChildren();
    const entries = [];
    if (data.handoff) entries.push({ at: data.handoff.requested_at || 0, role: 'owner', who: 'あなた（任せた仕事）', text: data.handoff.title || data.item.title });
    for (const n of data.notes || []) {
      // The picker's own "started" line is bookkeeping, not an answer.
      if (/^開始（picker/.test(n.text)) continue;
      entries.push({ at: n.at, role: 'agent', who: talkerLabel(n.actor), text: n.text, ref: n.ref });
    }
    for (const m of data.messages || []) entries.push({ at: m.at, role: m.role, who: m.role === 'owner' ? 'あなた → ' + talkerLabel(m.to) : talkerLabel(m.actor), text: m.text, ref: m.ref });
    entries.sort((a, b) => a.at - b.at);
    for (const e of entries) list.append(bubble(e.role, e.who, e.at, e.text, e.ref));
    if (!entries.length) list.append(el('p', 'empty', 'まだやり取りがありません。'));
    const state = $('board-chat-state');
    const open = data.open;
    if (open && open.status === 'waiting') state.textContent = '送りました。' + talkerLabel(open.to) + ' が 1 分以内に拾います。';
    else if (open && open.status === 'taken') state.textContent = talkerLabel(open.to) + ' が受けました。考えています（' + Math.max(1, Math.round((Date.now() - open.at) / 60000)) + ' 分）。';
    else if (data.handoff && ['requested', 'accepted'].includes(data.handoff.state)) state.textContent = '任せた仕事を進めています。終わると、ここに結果が出ます。';
    else state.textContent = '';
    const partner = $('board-chat-partner');
    if (document.activeElement !== partner) partner.value = data.partner || 'vps-claude';
    const busy = Boolean(open);
    $('board-chat-text').disabled = busy;
    host.querySelector('.board-chat-form button').disabled = busy;
    if (busy) $('board-chat-text').placeholder = '返事が来るまで待ってください';
    else $('board-chat-text').placeholder = '書いて「送る」（20,000 字まで）';
    host.hidden = false;
    document.body.classList.add('chat-open');
    if (nearBottom || !list.dataset.shown) { list.scrollTop = list.scrollHeight; list.dataset.shown = '1'; }
  }
  async function refreshChat() {
    if (!chatItem || chatBusy) return;
    chatBusy = true;
    try {
      const response = await fetch('/api/board/chat?item_id=' + encodeURIComponent(chatItem), { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store' });
      if (response.ok) showChat(await response.json());
      else $('board-chat-state').textContent = response.status === 401 ? 'ログインが切れています。このページを開き直してください。' : '会話を読めませんでした。';
    } catch {
      $('board-chat-state').textContent = '接続できません。通信を確かめてください。';
    } finally { chatBusy = false; }
  }
  function openChat(itemId) {
    chatItem = itemId;
    const host = chatShell();
    $('board-chat-list').replaceChildren(el('p', 'empty', '読み込んでいます…'));
    delete $('board-chat-list').dataset.shown;
    host.hidden = false;
    document.body.classList.add('chat-open');
    refreshChat();
    clearInterval(chatTimer);
    chatTimer = setInterval(() => { if (!document.hidden) refreshChat(); }, 8000);
  }
  function closeChat() {
    chatItem = null;
    clearInterval(chatTimer);
    chatTimer = null;
    const host = $('board-chat');
    if (host) host.hidden = true;
    document.body.classList.remove('chat-open');
    load(true);
  }
  // Someone is in the middle of typing or choosing: a timed reload would wipe it.
  function editing() {
    if ($('board-route').querySelector('details[open]')) return true;
    const host = $('board-projects');
    if (host.contains(document.activeElement) && ['INPUT', 'SELECT'].includes(document.activeElement.tagName)) return true;
    if (host.querySelector('details.board-write[open]')) return true;
    return [...host.querySelectorAll('.board-add input')].some((input) => input.value !== '');
  }
  function card(item, peers) {
    const box = el('div', 'board-card');
    box.dataset.itemId = item.item_id;
    if (item.item_id === foundId) box.classList.add('found');
    const head = el('div', 'board-card-head');
    head.append(el('p', 'board-title', item.title));
    const badges = el('div', 'board-badges');
    badges.append(el('span', 'badge', kinds[item.kind] || item.kind), stateBadge(item.state));
    if (item.kind === 'task') badges.append(el('span', 'badge mark', workMark(item)));
    head.append(badges);
    box.append(head);
    if (item.state === 'waiting' && item.waiting_reason) box.append(el('p', 'board-wait', '待っていること：' + item.waiting_reason));
    const meta = el('div', 'board-meta');
    if (item.planned_start || item.planned_end) meta.append(el('span', null, '予定：' + (item.planned_start || '未定') + ' 〜 ' + (item.planned_end || '未定')));
    meta.append(el('span', null, '更新：' + when(item.updated_at) + ' / ' + item.updated_by));
    if (item.source_ref) { const s = el('span', null, '原本：'); s.append(sourceNode(item.source_ref)); meta.append(s); }
    box.append(meta);
    if (item.last_event) {
      const last = el('div', 'board-last');
      // The result a run wrote comes just before it closed the item: show it,
      // with the state change under it (the Cloudflare board sends last_note).
      if (item.last_event.kind === 'state_change' && item.last_note) {
        last.append(eventLine(item.last_note, false));
        const change = eventLine(item.last_event, false);
        change.classList.add('board-last-change');
        last.append(change);
      } else {
        last.append(eventLine(item.last_event, false));
      }
      box.append(last);
    }
    if (canWrite && item.kind === 'task' && item.state === 'planned') box.append(orderControl(item));
    if (item.handoff && item.handoff.state === 'accepted') {
      box.append(el('p', 'board-wait', '受けた担当：' + item.handoff.accepted_by + '（' + when(item.handoff.accepted_at) + '、依頼の番号 ' + item.handoff.request_id + '）'));
      if (item.handoff.generation) box.append(el('p', 'board-wait', '実行の世代：' + item.handoff.generation + '　最後の連絡：' + when(item.handoff.heartbeat_at) + '　連絡の期限：' + when(item.handoff.lease_until)));
      if (item.handoff.lease_expired) box.append(el('p', 'board-wait', '連絡の期限を過ぎています。自動では再実行されません。担当の状態を確かめてから「状態不明にする」を押してください。'));
    }
    if (item.handoff && item.handoff.state === 'unknown')
      box.append(el('p', 'board-wait', '状態不明：担当（' + item.handoff.accepted_by + '）の結果が確認できていません。勝手には再実行されません。停止を確認できたら「停止を確認したので戻す」、まだ作業中と確認できたら「まだ作業中なので続ける」を押してください。'));
    if (canWrite && item.kind === 'task' && item.handoff && (item.handoff.state === 'unknown' || (item.handoff.state === 'accepted' && item.handoff.lease_expired))) box.append(recoveryControl(item));
    if (canWrite && item.kind === 'task' && (item.handoff ? item.handoff.state === 'requested' : item.state === 'planned')) box.append(handControl(item));
    if (canWrite && item.kind === 'task' && sessionItem.test(item.item_id)) box.append(continueControl(item, peers));
    if (canWrite && canTalk(item)) box.append(talkControl(item));
    if (canWrite && item.kind === 'task') box.append(moveControl(item, peers));
    return box;
  }
  // One project's items as two lists: the tree, and the work (kind task) that
  // nobody has put under a plan yet, so it is not lost among the roots.
  function forest(items) {
    const ids = new Set(items.map((i) => i.item_id));
    const children = new Map();
    const roots = [];
    const unlinked = [];
    for (const item of items) {
      if (item.parent_id && ids.has(item.parent_id)) {
        if (!children.has(item.parent_id)) children.set(item.parent_id, []);
        children.get(item.parent_id).push(item);
      } else if (item.kind === 'task') unlinked.push(item);
      else roots.push(item);
    }
    const seen = new Set();
    const list = (nodes, depth) => {
      const ul = el('ul', depth === 0 ? 'board-tree' : null);
      for (const item of nodes) {
        if (seen.has(item.item_id) || depth > 8) continue;
        seen.add(item.item_id);
        const li = el('li', 'board-node');
        li.append(card(item, items));
        const kids = children.get(item.item_id);
        if (kids) li.append(list(kids, depth + 1));
        ul.append(li);
      }
      return ul;
    };
    return { tree: list(roots, 0), unlinked: list(unlinked, 0), unlinkedCount: unlinked.length };
  }
  function render(data) {
    const items = Array.isArray(data.items) ? data.items : [];
    const events = Array.isArray(data.events) ? data.events : [];
    canWrite = data.can_write === true;
    $('board-mode').textContent = canWrite ? '積む・付け替えができます' : '読み取り専用';
    $('board-mode-note').textContent = canWrite ? '題名や状態は、書いた担当だけが直せます' : 'この画面から書き込むことはできません';
    $('board-foot').textContent = canWrite ? 'Many Iris / 看板' : 'Many Iris / 看板（読み取り専用）';
    routeSection(data.route);
    const host = $('board-projects');
    host.replaceChildren();
    if (!items.length) host.append(el('p', 'empty', 'まだ項目がありません。'));
    const byProject = new Map();
    for (const item of items) {
      if (!byProject.has(item.project)) byProject.set(item.project, []);
      byProject.get(item.project).push(item);
    }
    projectChoices([...byProject.keys()]);
    for (const [project, list] of byProject) {
      if (shownProject && project !== shownProject) continue;
      const section = el('section', 'board-project');
      const { tree, unlinked, unlinkedCount } = forest(list);
      section.append(el('h2', null, project));
      if (canWrite) section.append(addControl(project, list));
      section.append(tree);
      const loose = el('div', 'board-unlinked');
      const heading = el('h3', null, 'まだ結ばれていない作業');
      heading.append(el('span', 'count', unlinkedCount + ' 件'));
      loose.append(heading);
      if (unlinkedCount) {
        loose.append(el('p', 'board-hint', canWrite
          ? 'どの計画の分か、まだ分かっていない作業です。各作業の「入れる先を変える」から、計画の下へ付け替えられます。'
          : 'どの計画の分か、まだ分かっていない作業です。鍵を持つ AI に頼むと、計画の下へ付け替えられます。'));
        loose.append(unlinked);
      }
      section.append(loose);
      host.append(section);
    }
    const eventList = $('board-events');
    eventList.replaceChildren();
    for (const event of events) {
      const li = el('li', 'board-event');
      li.append(eventLine(event, true));
      eventList.append(li);
    }
    if (!events.length) eventList.append(el('li', 'empty', 'まだ出来事がありません。'));
    $('board-event-count').textContent = String(events.length);
    $('board-status').textContent = '項目 ' + items.length + ' 件 / 出来事の合計 ' + (data.counts?.events ?? '未確認') + ' 件';
    $('board-observed').textContent = '確認時点：' + when(data.generated_at);
  }
  // The project list on top: choosing one shows only that project, so its
  // "仕事を積む" is the first one on the page. A project that is gone falls
  // back to every project.
  function projectChoices(projects) {
    const select = $('board-project');
    $('board-find').hidden = false;
    if (shownProject && !projects.includes(shownProject)) shownProject = '';
    select.replaceChildren(option('', 'すべての案件（' + projects.length + '）'));
    for (const p of projects) select.append(option(p, p));
    select.value = shownProject;
  }
  function showProject(project) {
    shownProject = project;
    try { localStorage.setItem(PROJECT_KEY, project); } catch { /* private mode: not kept */ }
    if (lastData) render(lastData);
  }
  // A request number (REQ-…) or an item's name; an exact match first, then the
  // first item whose name or title contains the words.
  function search(query) {
    const status = $('board-search-status');
    const q = query.trim();
    if (!q || !lastData) { status.textContent = ''; return; }
    const items = Array.isArray(lastData.items) ? lastData.items : [];
    const lower = q.toLowerCase();
    const hit = items.find((i) => i.item_id === q || (i.handoff && i.handoff.request_id === q))
      || items.find((i) => i.item_id.toLowerCase().includes(lower) || String(i.title).toLowerCase().includes(lower));
    if (!hit) { foundId = null; status.textContent = '「' + short(q) + '」は見つかりませんでした。'; render(lastData); return; }
    foundId = hit.item_id;
    status.textContent = '見つかりました：' + hit.project + ' ／ ' + short(hit.title);
    showProject(hit.project);
    const target = [...document.querySelectorAll('.board-card')].find((n) => n.dataset.itemId === hit.item_id);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  $('board-project').addEventListener('change', (event) => { foundId = null; $('board-search-status').textContent = ''; showProject(event.target.value); });
  $('board-search').addEventListener('submit', (event) => { event.preventDefault(); search($('board-search-input').value); });
  // `force` is a reload the person asked for, or one that follows their own write.
  async function load(force) {
    if (loading) return;
    if (force !== true && editing()) return;
    loading = true;
    try {
      const response = await fetch('/api/board', { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store' });
      if (response.status === 401) { $('board-status').textContent = '本人用キーでの接続が切れています。このページを開き直してください。'; return; }
      if (!response.ok) { $('board-status').textContent = '看板を取得できませんでした。'; return; }
      lastData = await response.json();
      render(lastData);
    } catch {
      $('board-status').textContent = '接続できません。Many Irisが起動しているか確認してください。';
    } finally { loading = false; }
  }
  $('board-refresh').addEventListener('click', () => load(true));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  setInterval(() => { if (!document.hidden) load(); }, 60000);
  load(true);
})();
