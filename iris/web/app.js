'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const token = document.querySelector('meta[name="iris-ui-token"]')?.content || '';
  const storageKey = 'many-iris.pending-action.v1';
  const selectedKey = 'many-iris.selection.v1';
  const stateNames = {
    ready: '開始前', running: '実行中', waiting_decision: '判断待ち', paused: '次の作業を一時停止', completed: '計画の作業終了', blocked: '確認が必要',
    not_dispatched: '未開始', dispatch_intent: '依頼を保存済み', accepted: '実行側が受付済み', stop_requested: '停止を依頼済み', stopped_confirmed: '停止を確認済み', stop_unconfirmed: '停止は未確認', unknown: '結果不明',
    pending: '結果待ち', succeeded: '成功の結果あり', failed: '失敗の結果あり', rejected: '拒否', online: '接続可能', stale: '情報が古い', disconnected: '接続断', authentication_required: '認証の確認が必要', unsupported: 'この操作には未対応',
    valid: '許可は有効', granted: '許可は有効', active: '有効', approved: '承認済み', denied: '却下済み', expired: '有効期限切れ', revoked: '許可は失効', superseded: '内容が更新済み', resolved: '返答済み', approve: '承認', reject: '却下', stopped: '停止済み'
  };
  const errorNames = {
    INVALID: '依頼内容を確認できませんでした。状態を読み直してください。', NOT_FOUND: '対象が見つかりません。現在の一覧を確認してください。',
    FORBIDDEN: 'この対象または操作の許可がありません。', REQUEST_CONFLICT: '同じ依頼番号に別の内容があるため、処理を止めました。',
    STALE_APPROVAL: '許可が古いか失効しています。現在の内容と許可を確認してください。', STALE_BINDING: '対象の版が変わっています。内容を読み直してください。',
    SCOPE_MISMATCH: '指定した計画の許可範囲に含まれないため、実行していません。', ACTIVE_RUN: 'この仕事には未解決の実行があります。新しく開始していません。',
    STOP_UNCONFIRMED: '元の担当が停止したことを確認できないため、交代できません。', OUTCOME_UNRESOLVED: '結果が未確認のため、繰り返し実行していません。',
    RECEIPT_CONFLICT: '受け取った結果と保存済みの内容が一致しません。確認が必要です。', UNSUPPORTED_EXECUTOR: 'この担当は必要な実行能力に対応していません。',
    RESTORE_HOLD: '復元後の照合待ちです。新しい実行を止めています。', STORAGE: '状態を保存できませんでした。実行結果を確認してください。',
    STATE: '現在の状態ではこの操作を行えません。状態を確認してください。', HUMAN_DECISION_REQUIRED: 'この判断は本人用画面での確認と操作が必要です。'
  };
  let snapshot = null;
  let displayedPlan = null;
  let selected = safeRead(selectedKey) || '';
  let pending = parsePending();
  let staged = null;
  let awaiting = false;
  let refreshing = false;
  let connected = false;
  let latestFetch = 0;
  let detailSignature = '';
  let listSignature = '';
  let deferredSnapshot = false;
  let confirmation = null;
  let returnFocus = null;
  let pendingIssue = '';
  // True when the store holds the user's approved real-project cases, which are sent to a real AI.
  let realProject = false;

  function applyMode() {
    text('mode-title', realProject ? '本人承認済みの実案件' : '合成データの確認用');
    text('mode-detail', realProject ? '実AI（claude）へ送信あり' : '実AI・ChatGPTは未接続');
    text('source-note', realProject ? '本人が承認した実案件の原文です。元ファイルや外部サイトを自動で開くことはありません。' : '合成の原文です。元ファイルや外部サイトを自動で開くことはありません。');
    text('welcome-note', realProject ? '本人が承認した実案件を実AIへ送る画面です。開始した案件の指示文だけを1回送り、自動の再送はしません。' : 'ここで動くのは合成の実行候補です。実案件や実AIを動かす画面ではありません。');
    text('footer-mode', realProject ? 'Many Iris / 本人承認済みの実案件・実AIへ送信あり' : 'Many Iris / ローカルの合成実行候補');
  }
  function caseError(plan) { const code = snapshot?.scheduler?.case_errors?.[plan?.plan_id]; return typeof code === 'string' ? code : ''; }

  function safeRead(key) { try { return sessionStorage.getItem(key); } catch { return null; } }
  function safeWrite(key, value) { try { if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, value); } catch { /* State remains in memory when storage is unavailable. */ } }
  function parsePending() { try { const value = JSON.parse(safeRead(storageKey) || 'null'); return value && typeof value.operation === 'string' && typeof value.input?.request_id === 'string' ? value : null; } catch { return null; } }
  function text(id, value) { $(id).textContent = value == null ? '未確認' : String(value); }
  function label(value) { return stateNames[value] || (value ? '未対応の状態' : '未確認'); }
  function date(value) { return Number.isFinite(Number(value)) && value !== null ? new Date(Number(value) * 1000).toLocaleString('ja-JP') : '未確認'; }
  function element(tag, className, content) { const node = document.createElement(tag); if (className) node.className = className; if (content !== undefined) node.textContent = String(content); return node; }
  function announce(message) { text('live-message', message); }
  function showNotice(title, message, canReconcile = true) { $('notice').hidden = false; text('notice-title', title); text('notice-text', message); $('reconcile').hidden = !canReconcile; }
  function clearNotice() { if (!pending) { $('notice').hidden = true; $('check-receipt').hidden = true; } }
  function badge(value) { const node = element('span', 'badge', label(value)); if (['unknown', 'stop_unconfirmed', 'rejected', 'failed'].includes(value)) node.classList.add('danger'); else if (['waiting_decision', 'stop_requested', 'blocked', 'stale'].includes(value)) node.classList.add('attention'); else if (['succeeded', 'stopped_confirmed', 'completed'].includes(value)) node.classList.add('good'); return node; }
  function plans() { return Array.isArray(snapshot?.plans) ? snapshot.plans : []; }
  function currentPlan() { return plans().find((p) => p.plan_id === selected); }
  function isFresh() { return connected && latestFetch > 0 && Date.now() - latestFetch < 20000 && snapshot?.connection_state === 'online'; }
  function hasUnresolved(plan) { return (plan?.tasks || []).some((t) => ['unknown', 'stop_unconfirmed', 'stop_requested'].includes(t.execution_state) || t.outcome === 'unknown'); }
  function allowed(plan, operation) {
    if (snapshot?.scheduler?.state === 'paused_error') return false;
    if (!plan || !isFresh() || pending || awaiting || deferredSnapshot || snapshot?.restore_hold) return false;
    if (!Array.isArray(plan.allowed_actions) || !plan.allowed_actions.includes(operation)) return false;
    if (['start_plan', 'continue_plan', 'handoff_task'].includes(operation) && hasUnresolved(plan)) return false;
    // A case with its own scheduler error keeps only stop and pause; other cases are unaffected.
    if (caseError(plan) && !['request_stop', 'pause_plan'].includes(operation)) return false;
    return true;
  }
  function makeButton(title, operation, payload, explanation, options = {}) {
    const button = element('button', options.quiet ? 'quiet' : '', title);
    button.type = 'button';
    button.disabled = !allowed(currentPlan(), operation) || options.disabled === true;
    if (options.reason) button.title = options.reason;
    button.addEventListener('click', () => openConfirmation(title, operation, payload, explanation, button));
    return button;
  }
  function meaningfulSignature(plan) { return JSON.stringify({plan, restore_hold: snapshot?.restore_hold, connection_state: snapshot?.connection_state, case_error: caseError(plan)}); }

  async function readState(manual = false) {
    if (awaiting || refreshing || !token || token.startsWith('__')) return;
    refreshing = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    $('refresh').disabled = true;
    try {
      const response = await fetch('/api/state', {headers: {Authorization: `Bearer ${token}`, Accept: 'application/json'}, cache: 'no-store', credentials: 'same-origin', signal: controller.signal});
      const data = await response.json();
      if (!response.ok || data?.ok === false || !Array.isArray(data?.plans) || typeof data?.synthetic !== 'boolean') throw new Error('state_unavailable');
      if (data.synthetic !== true) { connected = false; showNotice('合成用画面の対象ではありません', 'この候補は合成データ専用です。実行操作を止めています。'); return; }
      const reconnected = !connected;
      connected = true; latestFetch = Date.now(); snapshot = data;
      const wasRealProject = realProject;
      realProject = data.real_project_cases != null;
      if (realProject !== wasRealProject) applyMode();
      text('connection-label', `${realProject ? '実案件' : '合成環境'}：${label(data.connection_state)}`);
      text('observed-label', `確認時点：${date(data.observed_at)}`);
      if (data.restore_hold) showNotice('復元後の照合待ちです', '旧担当の停止と結果を確認するまで、新しい実行は行いません。');
      else if (data.scheduler?.state === 'paused_error') showNotice('実行結果の照合が必要です', '自動実行を止めています。新しい依頼を繰り返さず、元の実行と保存済みの結果を確認してください。');
      else clearNotice();
      renderList();
      const plan = currentPlan();
      if (displayedPlan && plan && (meaningfulSignature(plan) !== detailSignature || reconnected)) {
        staged = plan; deferredSnapshot = true; $('detail-update').hidden = false;
        invalidateVisibleActions();
        text('decision-warning', '状態が更新されました。現在の内容を読み直してから返答してください。');
        $('decision-warning').hidden = !displayedPlan.decision;
        announce('新しい状態があります。内容を更新すると現在の状況を確認できます。');
      } else if (!displayedPlan || !plan || manual && !deferredSnapshot) renderDetail(plan);
      if (pending) showPending();
      if (manual) announce('状態を確認しました。');
    } catch {
      connected = false;
      text('connection-label', '接続を確認できません。表示は最後の確認時点です。');
      invalidateVisibleActions();
      showNotice(pending ? '依頼の受付結果が未確認です' : '最新の状態を取得できません', pending ? '同じ依頼を保ったまま照会します。新しい依頼番号で繰り返し実行しません。' : '最後に取得した情報を表示しています。接続を確認してから操作してください。');
      if (manual) announce('状態を取得できませんでした。');
    } finally { window.clearTimeout(timeout); refreshing = false; $('refresh').disabled = false; }
  }

  function renderList() {
    const query = $('plan-search').value.trim().toLocaleLowerCase();
    const filtered = plans().filter((p) => [p.project_title, p.title, p.source_ref].join(' ').toLocaleLowerCase().includes(query));
    text('plan-count', `${filtered.length} 計画`);
    const signature = JSON.stringify(filtered.map((p) => [p.plan_id, p.project_title, p.title, p.source_ref, p.plan_state, p.decision?.status])) + selected;
    if (signature === listSignature) return;
    listSignature = signature;
    const focused = document.activeElement?.dataset?.planId;
    const list = $('plan-list'); const scroll = list.scrollTop;
    list.replaceChildren();
    if (!filtered.length) list.append(element('p', 'empty', plans().length ? '該当する案件・計画がありません。' : '表示できる計画はありません。'));
    for (const plan of filtered) {
      const button = element('button', 'plan-card'); button.type = 'button'; button.dataset.planId = plan.plan_id; button.setAttribute('aria-current', String(plan.plan_id === selected));
      button.append(element('span', 'project-name', plan.project_title || '案件名は未取得'), element('span', 'plan-name', plan.title || '計画名は未取得'));
      const foot = element('span', 'card-foot'); foot.append(badge(plan.plan_state)); if (plan.decision?.status === 'pending') foot.append(element('span', '', '本人の判断待ち'));
      button.append(foot, element('span', 'source-label', plan.source_ref || `案件 ${plan.project_id || '未確認'}`));
      button.addEventListener('click', () => selectPlan(plan.plan_id, true)); list.append(button);
    }
    list.scrollTop = scroll;
    if (focused) Array.from(list.querySelectorAll('button')).find((b) => b.dataset.planId === focused)?.focus({preventScroll: true});
  }

  function selectPlan(id, focus = false) {
    selected = id; safeWrite(selectedKey, id); staged = null; deferredSnapshot = false;
    renderList(); renderDetail(currentPlan());
    if (focus) { $('detail-title').tabIndex = -1; $('detail-title').focus({preventScroll: true}); $('detail').scrollIntoView({block: 'start', behavior: 'instant'}); }
  }

  function renderDetail(plan) {
    displayedPlan = plan || null; staged = null; deferredSnapshot = false; $('detail-update').hidden = true;
    $('detail').hidden = !plan; $('no-selection').hidden = !!plan;
    if (!plan) return;
    detailSignature = meaningfulSignature(plan);
    text('project-label', plan.project_title || '案件名は未取得'); text('detail-title', plan.title || '計画名は未取得');
    $('plan-state').replaceWith(Object.assign(badge(plan.plan_state), {id: 'plan-state'}));
    text('summary', summary(plan)); text('approval-state', label(plan.approval?.status)); text('approval-expiry', date(plan.approval?.expires_at));
    const caseIssue = caseError(plan) ? `この案件の送信で確認が必要です（${caseError(plan)}）。自動の再送はしません。ほかの案件には影響しません。` : '';
    const blockedText = [plan.blocked_reason, caseIssue].filter(Boolean).join(' / ');
    text('blocked', blockedText); $('blocked').hidden = !blockedText;
    text('source-reference', plan.source_ref || '原文の取得元は未確認');
    text('bindings', JSON.stringify({plan_id: plan.plan_id, project_id: plan.project_id, run_id: plan.run_id, plan_revision: plan.plan_revision, plan_hash: plan.plan_hash, approval_id: plan.approval?.approval_id, approval_revision: plan.approval?.revision, scope_hash: plan.approval?.scope_hash}, null, 2));
    const actions = $('plan-actions'); actions.replaceChildren();
    actions.append(makeButton('この計画を開始', 'start_plan', {plan_id: plan.plan_id, plan_revision: plan.plan_revision, plan_hash: plan.plan_hash, approval_id: plan.approval?.approval_id, approval_revision: plan.approval?.revision}, realProject ? 'この案件の指示文を実AI（claude）へ1回だけ送ります。結果は記録だけで、成功とは扱いません。自動の再送はしません。' : '指定した計画と現在の許可範囲だけを合成実行します。受付と実行開始は別々に確認します。'));
    if (plan.run_id) {
      actions.append(makeButton('次の作業を一時停止', 'pause_plan', {run_id: plan.run_id}, '次の作業を選ぶ処理を一時停止します。現在動いている担当の停止は、作業ごとの停止操作で確認します。', {quiet: true}));
      actions.append(makeButton('計画内の次の作業へ', 'continue_plan', {run_id: plan.run_id}, '同じ計画の許可範囲で、条件を満たす次の作業だけを進めます。', {quiet: true}));
    }
    renderTasks(plan); renderDecision(plan); renderHistory(plan);
    if (!isFresh() || pending || awaiting) invalidateVisibleActions();
  }

  function summary(plan) {
    if (snapshot?.restore_hold) return '復元後の照合待ちです。新しい実行を止めています。';
    if (hasUnresolved(plan)) return '結果または停止の確認が必要です。新たな実行や担当交代は行いません。';
    if (plan.decision?.status === 'pending') return '本人の判断を待っている作業があります。内容と対象の版を確認してください。';
    if (plan.plan_state === 'running') return '指定した計画の範囲で進行中です。作業ごとの状態と根拠を確認できます。';
    if (plan.plan_state === 'completed') return '計画内の作業が終了しています。個々の結果と根拠、未確認の範囲を確認してください。';
    return '計画と原文、許可範囲を確認してから仕事を任せられます。';
  }

  function renderTasks(plan) {
    const list = $('tasks'); list.replaceChildren();
    if (!Array.isArray(plan.tasks) || !plan.tasks.length) { list.append(element('li', 'empty', '作業の情報は未取得です。')); return; }
    for (const task of plan.tasks) {
      const item = element('li', 'task'); const heading = element('div', 'task-heading');
      heading.append(element('h4', '', task.title || '作業名は未取得'), badge(task.execution_state || task.status)); item.append(heading);
      item.append(element('p', '', `結果：${label(task.outcome)}${task.executor_id ? ` / 担当：${task.executor_id}` : ''}`));
      if (task.instruction && realProject) { const details = element('details', 'technical'); details.append(element('summary', '', '送る指示文を読む')); details.append(element('pre', 'prose', task.instruction)); item.append(details); }
      else if (task.instruction) item.append(element('p', '', task.instruction));
      if (task.execution_state === 'stop_requested') item.append(element('p', 'blocked', '停止を依頼しました。まだ停止を確認した状態ではありません。'));
      if (['unknown', 'stop_unconfirmed'].includes(task.execution_state) || task.outcome === 'unknown') item.append(element('p', 'blocked', '結果や停止が未確認です。再実行・新しい担当への交代は行いません。'));
      const actions = element('div', 'action-row');
      if (task.attempt_id) actions.append(makeButton('この作業の停止を依頼', 'request_stop', {attempt_id: task.attempt_id, fence: task.fence}, '現在の担当へ停止を依頼します。受付だけでは停止確定にせず、停止の根拠を確認します。', {quiet: true}));
      if (task.stop_receipt_id && task.execution_state === 'stopped_confirmed') {
        const targets = executorChoices(task);
        if (targets.length) {
          const target = targets[0];
          actions.append(makeButton('停止済みの仕事を引き継ぐ', 'handoff_task', {old_attempt_id: task.attempt_id, stop_receipt_id: task.stop_receipt_id, new_executor_id: target.id}, `停止の証拠と結果を照合し、同じ指示・許可範囲を「${target.title}」へ引き継ぎます。`, {quiet: true}));
        } else actions.append(element('p', 'small', '交代先の一覧を確認できないため、ここから担当交代はできません。'));
      }
      if (actions.childNodes.length) item.append(actions);
      if (task.evidence != null) { const details = element('details', 'technical'); details.append(element('summary', '', 'この結果の根拠を読む')); details.append(element('pre', '', typeof task.evidence === 'string' ? task.evidence : JSON.stringify(task.evidence, null, 2))); item.append(details); }
      list.append(item);
    }
  }

  function executorChoices(task) {
    const choices = snapshot?.capabilities?.executors;
    if (!Array.isArray(choices)) return [];
    return choices.filter((x) => x && typeof x.id === 'string' && x.id !== task.executor_id && x.synthetic === true).map((x) => ({id: x.id, title: x.label || '合成担当'}));
  }

  function renderDecision(plan) {
    const decision = plan.decision;
    $('decision-section').hidden = !decision || decision.status !== 'pending';
    $('decision-warning').hidden = true;
    $('decision-actions').replaceChildren();
    if (!decision || decision.status !== 'pending') return;
    const task = (plan.tasks || []).find((t) => t.task_id === decision.task_id);
    text('decision-binding', `対象：${task?.title || '対象を確認できません'} / 判断の版：${decision.revision ?? '未確認'}`);
    text('decision-content', task?.instruction || '判断対象の内容を取得できません。内容が確認できるまで返答できません。');
    const bindingComplete = !!task?.instruction && typeof decision.decision_id === 'string' && typeof decision.content_hash === 'string' && decision.revision != null;
    const payload = {decision_id: decision.decision_id, decision_revision: decision.revision, content_hash: decision.content_hash};
    $('decision-actions').append(makeButton('この内容を承認', 'submit_decision', {...payload, decision: 'approve'}, '画面で確認した対象と現在の判断版だけを承認します。承認の保存と実行開始は別に確認します。', {disabled: !bindingComplete}));
    $('decision-actions').append(makeButton('この内容を却下', 'submit_decision', {...payload, decision: 'reject'}, 'この判断対象の操作を却下します。既にある成果物は削除しません。', {quiet: true, disabled: !bindingComplete}));
  }

  function renderHistory(plan) {
    const host = $('history'); host.replaceChildren();
    const history = Array.isArray(snapshot?.history) ? snapshot.history : [];
    const relevant = history.filter((h) => !h.plan_id || h.plan_id === plan.plan_id).slice(-15).reverse();
    if (!relevant.length) host.append(element('p', 'small', '記録はまだありません。成果の自己申告だけで検証済みとはしません。'));
    for (const entry of relevant) {
      const item = element('div', 'history-item');
      item.append(element('time', '', date(entry.observed_at ?? entry.created_at ?? entry.timestamp)));
      item.append(element('p', '', entry.summary || entry.detail || operationLabel(entry.operation) || '状態の記録'));
      const details = element('details'); details.append(element('summary', 'small', '照合情報')); details.append(element('pre', '', JSON.stringify(entry, null, 2))); item.append(details); host.append(item);
    }
  }

  function operationLabel(operation) { return ({start_plan: '計画の開始依頼', submit_decision: '本人の判断', pause_plan: '次作業の一時停止', continue_plan: '計画内の継続', request_stop: '担当への停止依頼', handoff_task: '担当交代', dispatch_attempt: '実行の依頼', record_executor_event: '実行側からの記録'})[operation]; }
  function invalidateVisibleActions() { $('plan-actions').querySelectorAll('button').forEach((b) => { b.disabled = true; }); $('tasks').querySelectorAll('button').forEach((b) => { b.disabled = true; }); $('decision-actions').querySelectorAll('button').forEach((b) => { b.disabled = true; }); $('confirm-submit').disabled = true; }
  function showPending() { showNotice('依頼の受付結果を確認してください', `${pendingIssue ? `${pendingIssue} ` : ''}${operationLabel(pending.operation) || '送った依頼'}の受付結果が未確認です。新しい依頼は作らず、「同じ依頼の受付確認」で元の内容の受付だけを確認できます。`); $('check-receipt').hidden = false; $('check-receipt').disabled = awaiting; invalidateVisibleActions(); }

  function openConfirmation(title, operation, payload, explanation, sourceButton) {
    const plan = currentPlan();
    if (!allowed(plan, operation)) { showNotice('現在の内容を確認してください', '状態・許可または対象の版が更新されています。内容を読み直してから操作してください。'); return; }
    confirmation = {operation, payload, planId: plan.plan_id, signature: meaningfulSignature(plan)};
    returnFocus = sourceButton;
    text('confirm-title', title); text('confirm-target', `${plan.project_title || ''} / ${plan.title || ''}`); text('confirm-explanation', explanation);
    text('confirm-binding', `計画の版：${plan.plan_revision ?? '未確認'} / 許可の版：${plan.approval?.revision ?? '未確認'} / ${realProject ? '実AIへ送信' : '合成実行'}`);
    $('confirm-submit').disabled = false;
    $('confirm-dialog').showModal(); $('confirm-cancel').focus();
  }

  async function sendAction(action) {
    awaiting = true; pending = action; safeWrite(storageKey, JSON.stringify(action)); invalidateVisibleActions();
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('/api/action', {method: 'POST', headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json'}, credentials: 'same-origin', body: JSON.stringify(action), signal: controller.signal});
      const data = await response.json();
      if (!response.ok || data?.ok !== true || !data.receipt || !Array.isArray(data.snapshot?.plans) || data.snapshot.synthetic !== true) {
        if (data?.ok === false && typeof data.code === 'string') {
          if (!['REQUEST_CONFLICT', 'STORAGE', 'RECEIPT_CONFLICT'].includes(data.code)) { pending = null; safeWrite(storageKey, null); $('check-receipt').hidden = true; }
          else pendingIssue = errorNames[data.code];
          showNotice('依頼は完了していません', errorNames[data.code] || 'この依頼を受け付けられませんでした。状態を確認してください。');
          if (pending) $('check-receipt').hidden = false;
          connected = false;
          return;
        }
        throw new Error('response_unconfirmed');
      }
      pending = null; pendingIssue = ''; safeWrite(storageKey, null); $('check-receipt').hidden = true; snapshot = data.snapshot; connected = true; latestFetch = Date.now();
      showNotice('依頼を受け付けました', `${operationLabel(action.operation) || '操作'}の受付を保存しました。実行や停止の確定とは分けて、作業の状態を確認してください。`, false);
      renderList(); renderDetail(currentPlan()); announce('依頼を受け付けました。作業の状態を確認してください。');
    } catch {
      connected = false; showPending(); announce('依頼の結果は未確認です。新しい依頼は作りません。');
    } finally { window.clearTimeout(timeout); awaiting = false; $('check-receipt').disabled = false; if (!pending && connected) renderDetail(currentPlan()); }
  }

  $('confirm-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const chosen = confirmation;
    if (!chosen || !allowed(currentPlan(), chosen.operation) || selected !== chosen.planId || meaningfulSignature(currentPlan()) !== chosen.signature) {
      $('confirm-dialog').close(); confirmation = null;
      showNotice('対象の内容が変わりました', '現在の内容と許可を読み直してください。古い判断は送信していません。'); return;
    }
    const requestId = `ui-${crypto.randomUUID()}`;
    const action = {operation: chosen.operation, input: {request_id: requestId, payload: chosen.payload}};
    $('confirm-dialog').close(); confirmation = null; await sendAction(action);
  });
  $('confirm-cancel').addEventListener('click', () => $('confirm-dialog').close());
  $('confirm-dialog').addEventListener('close', () => { confirmation = null; if (returnFocus?.isConnected) returnFocus.focus({preventScroll: true}); });
  $('refresh').addEventListener('click', () => readState(true));
  $('reconcile').addEventListener('click', () => readState(true));
  $('check-receipt').addEventListener('click', () => { if (pending && !awaiting) sendAction(pending); });
  $('plan-search').addEventListener('input', renderList);
  $('apply-update').addEventListener('click', () => { const next = staged || currentPlan(); renderDetail(next); $('detail-title').tabIndex = -1; $('detail-title').focus({preventScroll: true}); announce('現在の内容に更新しました。'); });
  $('back-to-list').addEventListener('click', () => { const button = Array.from($('plan-list').querySelectorAll('button')).find((b) => b.dataset.planId === selected); (button || $('plan-search')).focus(); document.querySelector('.project-pane').scrollIntoView({block: 'start'}); });
  $('open-source').addEventListener('click', () => { if (!displayedPlan) return; text('source-dialog-title', `${displayedPlan.title || '計画'}の原文`); text('dialog-source-reference', displayedPlan.source_ref || '取得元は未確認'); text('source-text', displayedPlan.source_text || '原文を取得できません。'); $('source-dialog').showModal(); $('close-source').focus(); });
  $('close-source').addEventListener('click', () => $('source-dialog').close());
  $('source-dialog').addEventListener('close', () => $('open-source').focus({preventScroll: true}));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) readState(); });
  window.setInterval(() => { if (!document.hidden && !$('confirm-dialog').open) readState(); }, 4000);
  if (!token || token.startsWith('__')) { showNotice('この画面の接続を確認してください', '起動したIrisから本人用画面を開き直してください。実行操作は有効になっていません。', false); text('connection-label', '本人用画面の接続は未確認'); }
  else { readState(); if (pending) showPending(); }
})();
