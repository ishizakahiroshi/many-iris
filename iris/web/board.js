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
    return item.state === 'planned' ? '積んである' : '記録だけ';
  };
  const writeErrors = {
    REVISION_CONFLICT: 'ほかの書き込みで変わっていました。読み直してから、もう一度お試しください。',
    HANDOFF_CONFLICT: '任せた状態が変わっていました。読み直してから、もう一度お試しください。',
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
      if (response.ok && answer && answer.ok === true) return true;
      status.textContent = writeErrors[answer && answer.code] || '書き込めませんでした。読み直してから、もう一度お試しください。';
      return false;
    } catch {
      status.textContent = '接続できません。通信を確かめてから、もう一度お試しください。';
      return false;
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
  // Where handed-over work goes (handoff.to). '' = the board chooses.
  const targets = [
    ['', 'おまかせ'], ['devin', 'Devin'], ['vps-claude', 'VPS の claude -p'], ['local-claude', '手元 PC の claude -p'],
    ['muse', 'Muse'], ['grokbot', 'GrokBot'], ['owner', '自分'], ['hold', '保留'],
  ];
  const targetLabel = (to) => (targets.find(([value]) => value === (to || '')) || [null, to])[1];
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
      row.append(el('span', 'board-write-note', '行き先：' + targetLabel(item.handoff.to) + '　依頼の番号：' + item.handoff.request_id + '（' + when(item.handoff.requested_at) + '）'));
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
    const button = el('button', 'quiet', '積む');
    button.type = 'button';
    const status = el('span', 'board-write-status');
    status.setAttribute('role', 'status');
    const send = async () => {
      const text = title.value.trim();
      if (!text) { status.textContent = '題名を入れてください。'; return; }
      const now = new Date();
      // This device's calendar day, for the new item's id.
      const day = String(now.getFullYear()) + String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0');
      const body = { op: 'add', project, title: text, day };
      if (select.value) body.parent_id = select.value;
      const done = await write(body, status, button);
      if (done) { title.value = ''; load(true); }
    };
    button.addEventListener('click', send);
    title.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.isComposing) send(); });
    row.append(title, select, button, status);
    box.append(row);
    return box;
  }
  // Someone is in the middle of typing or choosing: a timed reload would wipe it.
  function editing() {
    const host = $('board-projects');
    if (host.contains(document.activeElement) && ['INPUT', 'SELECT'].includes(document.activeElement.tagName)) return true;
    if (host.querySelector('details.board-write[open]')) return true;
    return [...host.querySelectorAll('.board-add input')].some((input) => input.value !== '');
  }
  function card(item, peers) {
    const box = el('div', 'board-card');
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
      last.append(eventLine(item.last_event, false));
      box.append(last);
    }
    if (canWrite && item.kind === 'task' && item.state === 'planned') box.append(orderControl(item));
    if (item.handoff && item.handoff.state === 'accepted')
      box.append(el('p', 'board-wait', '受けた担当：' + item.handoff.accepted_by + '（' + when(item.handoff.accepted_at) + '、依頼の番号 ' + item.handoff.request_id + '）'));
    if (canWrite && item.kind === 'task' && (item.handoff ? item.handoff.state === 'requested' : item.state === 'planned')) box.append(handControl(item));
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
    const host = $('board-projects');
    host.replaceChildren();
    if (!items.length) host.append(el('p', 'empty', 'まだ項目がありません。'));
    const byProject = new Map();
    for (const item of items) {
      if (!byProject.has(item.project)) byProject.set(item.project, []);
      byProject.get(item.project).push(item);
    }
    for (const [project, list] of byProject) {
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
  // `force` is a reload the person asked for, or one that follows their own write.
  async function load(force) {
    if (loading) return;
    if (force !== true && editing()) return;
    loading = true;
    try {
      const response = await fetch('/api/board', { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store' });
      if (response.status === 401) { $('board-status').textContent = '本人用キーでの接続が切れています。このページを開き直してください。'; return; }
      if (!response.ok) { $('board-status').textContent = '看板を取得できませんでした。'; return; }
      render(await response.json());
    } catch {
      $('board-status').textContent = '接続できません。Many Irisが起動しているか確認してください。';
    } finally { loading = false; }
  }
  $('board-refresh').addEventListener('click', () => load(true));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  setInterval(() => { if (!document.hidden) load(); }, 60000);
  load(true);
})();
