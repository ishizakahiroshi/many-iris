// Owner actions go only to the Access-protected route. Each control closes over
// its opaque row ID, even when another client refreshes or answers first.
export function mountConfirmations() {
  const list = document.getElementById('confirmation-list');
  const count = document.getElementById('confirmation-count');
  const status = document.getElementById('confirmation-status');
  let version = 0;
  let previous = null;
  const submitting = new Set();

  function node(tag, value) {
    const element = document.createElement(tag);
    element.textContent = value;
    return element;
  }

  function row(item) {
    const line = document.createElement('li');
    const copy = document.createElement('div');
    const time = new Date(item.created_at);
    const meta = ['接続元 ' + item.source, item.project, item.agent];
    if (Number.isFinite(time.getTime())) meta.push(time.toLocaleString('ja-JP', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }) + ' 受付');
    copy.append(node('small', meta.join(' ／ ')),
      node('h3', item.task), node('p', item.question));
    line.append(copy);
    if (item.state === 'pending' && !item.local_only) {
      const button = node('button', '許可');
      button.type = 'button';
      button.disabled = submitting.has(item.id);
      button.setAttribute('aria-label', item.task + 'を許可');
      button.addEventListener('click', () => approve(item.id, button));
      line.append(button);
    } else {
      const messages = { approved: '許可済み・受取待ち', unknown: '適用結果不明・元の画面で確認' };
      line.append(node('small', messages[item.state] || '元の画面で確認'));
    }
    return line;
  }

  async function refresh() {
    const current = ++version;
    try {
      const response = await fetch('/api/confirmations', { cache: 'no-store' });
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (!data.ok || !Array.isArray(data.items)) throw new Error();
      if (current !== version) return;
      const next = JSON.stringify(data.items);
      if (previous !== next) {
        list.replaceChildren(...data.items.map(row));
        previous = next;
      }
      count.textContent = data.items.filter((item) => item.state === 'pending').length + '件';
      status.textContent = data.items.length ? '' : '確認待ちはありません。';
    } catch {
      if (current !== version) return;
      previous = null;
      count.textContent = '—';
      list.replaceChildren();
      status.textContent = '確認待ちを取得できません。「読み直す」で再取得できます。';
    }
  }

  async function approve(id, button) {
    if (submitting.has(id)) return;
    submitting.add(id);
    button.disabled = true;
    let message = '';
    try {
      const response = await fetch('/api/confirmations', {
        method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, op: 'approve' }),
      });
      const answer = await response.json();
      if (!response.ok || !answer.ok) {
        message = answer.code === 'PAUSED' ? '全部止めています。再開後に許可できます。'
          : '許可できませんでした。確認の状態を読み直しました。';
      }
    } catch {
      message = '許可の受付結果が分かりません。「読み直す」で状態を確認してください。';
    } finally {
      submitting.delete(id);
      previous = null;
      await refresh();
      if (message) status.textContent = message;
    }
  }

  document.getElementById('board-refresh').addEventListener('click', refresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden) refresh(); }, 60000);
  refresh();
}
