'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const token = document.querySelector('meta[name="iris-ui-token"]')?.content || '';
  const states = { planned: '予定', in_progress: '進行中', waiting: '待ち', done: '完了', stopped: '停止' };
  const kinds = { project: '案件', plan: '計画', context: '文脈', issue: 'Issue', pr: 'PR', task: '作業' };
  const eventKinds = { session_start: '作業開始', session_end: '作業終了', note: 'メモ', state_change: '状態の変更' };
  let loading = false;

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
  function card(item) {
    const box = el('div', 'board-card');
    const head = el('div', 'board-card-head');
    head.append(el('p', 'board-title', item.title));
    const badges = el('div', 'board-badges');
    badges.append(el('span', 'badge', kinds[item.kind] || item.kind), stateBadge(item.state));
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
        li.append(card(item));
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
      section.append(tree);
      const loose = el('div', 'board-unlinked');
      const heading = el('h3', null, 'まだ結ばれていない作業');
      heading.append(el('span', 'count', unlinkedCount + ' 件'));
      loose.append(heading);
      if (unlinkedCount) {
        loose.append(el('p', 'board-hint', 'どの計画の分か、まだ分かっていない作業です。鍵を持つ AI に頼むと、計画の下へ付け替えられます。'));
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
  async function load() {
    if (loading) return;
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
  $('board-refresh').addEventListener('click', load);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  setInterval(() => { if (!document.hidden) load(); }, 60000);
  load();
})();
