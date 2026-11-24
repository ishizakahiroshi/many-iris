// The board groups actual dates in Japan time, independent of the viewer's device.
const DAY = 86400000;
export const boardDay = ms => Number.isFinite(ms) ? Math.floor((ms + 9 * 3600000) / DAY) : null;
export const dateLabel = day => new Date(day * DAY).toISOString().slice(0, 10);
export const isClosed = state => state === 'done' || state === 'stopped';
const labels = { requested: '依頼', accepted: '受理', note: '記録', session_start: 'セッション開始', session_end: 'セッション終了' };

function mark(days, day, label) {
  if (day === null) return;
  if (!days.has(day)) days.set(day, new Set());
  days.get(day).add(label);
}

export class ActivityHistory {
  constructor(epoch) {
    this.epoch = epoch;
    this.cursor = 0;
    this.items = new Map();
  }

  append(page, through) {
    if (page.history_epoch !== this.epoch || !Array.isArray(page.events) || !page.events.length)
      throw new Error('Incomplete board history');
    let next = this.cursor;
    for (const e of page.events) {
      if (!Number.isSafeInteger(e.seq) || e.seq <= next || e.seq > through) throw new Error('Invalid history cursor');
      next = e.seq;
    }
    for (const e of page.events) {
      if (!this.items.has(e.item_id)) this.items.set(e.item_id, { days: new Map(), changes: [] });
      const item = this.items.get(e.item_id);
      const day = boardDay(e.at);
      let label = labels[e.kind] || '状態変更';
      if (e.kind === 'state_change') {
        item.changes.push(e);
        if (e.to === 'done') label = '完了';
        else if (e.to === 'stopped') label = '停止';
        else if (isClosed(e.from) && e.to) label = '再開';
      }
      mark(item.days, day, label);
    }
    this.cursor = next;
  }
}

// Open intervals come only from creation, recorded state transitions and the
// observed current state. A closed item without a dated closure gets no bar.
export function actuals(item, record, observedAt) {
  const days = new Map(record?.days);
  // Clone only the sets that receive an extra milestone.
  for (const [ms, label] of [[item.created_at, '作成'], [item.handoff?.requested_at, '依頼'], [item.handoff?.accepted_at, '受理']]) {
    const day = boardDay(ms);
    if (day !== null) {
      days.set(day, new Set(days.get(day)));
      mark(days, day, label);
    }
  }
  const changes = record?.changes || [];
  let state = changes[0]?.from ?? item.state;
  let start = isClosed(state) ? null : boardDay(item.created_at);
  const periods = [];
  let ended = null;
  for (const e of changes) {
    const day = boardDay(e.at);
    if (!e.from || !e.to || day === null || e.from !== state) {
      start = null;
      ended = null;
    } else if (isClosed(e.to)) {
      if (start !== null && start <= day) periods.push({ start, end: day });
      start = null;
      ended = day;
    } else if (isClosed(e.from)) {
      start = day;
      ended = null;
    }
    state = e.to;
  }
  const today = boardDay(observedAt);
  if (state === item.state && !isClosed(state) && start !== null && today !== null && start <= today)
    periods.push({ start, end: today, ongoing: true });
  return { days, periods, unknownEnd: isClosed(item.state) && (ended === null || state !== item.state) };
}

// A conditional response still carries a new observation time. Legacy
// handoffs can have no lease, and equality is still inside the lease.
export function mergeBoard(previous, response) {
  if (!response.unchanged) return response;
  if (!previous || previous.revision !== response.revision) throw new Error('Missing board snapshot');
  let items = previous.items;
  for (const [index, item] of previous.items.entries()) {
    const h = item.handoff;
    if (h?.state !== 'accepted') continue;
    const expired = Number.isFinite(h.lease_until) && response.generated_at > h.lease_until;
    if (expired !== h.lease_expired) {
      if (items === previous.items) items = previous.items.slice();
      items[index] = { ...item, handoff: { ...h, lease_expired: expired } };
    }
  }
  return { ...previous, ...response, items };
}
