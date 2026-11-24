// What a request has actually come to, in words that keep four things apart:
//   registered (the board saved it) != accepted (a writer took it) !=
//   running (the run said it is working after taking it) != done.
// Pure and read-only: store.ts gathers the item, its handoff, the dispatcher's
// rows and the latest events, and this file only judges them (like resume.ts),
// so test/lifecycle.test.mjs runs it under Node with no board. It writes
// nothing and starts nothing: asking "where is it" can never run the work twice.
//
// It adds no second state. Every stage is read off the columns the handoff
// already keeps (handoff_state, accepted_at, heartbeat_at, lease_until) and the
// dispatcher's claim rows. What the board cannot see is reported as
// `unconfirmed`, never guessed as waiting or running.
import { leaseExpired, type HandoffView } from "./resume.ts";

/** A request nobody took within this long is reported as stalled (information only: nothing is retried by it). */
export const REQUEST_STALL_MS = 60 * 60 * 1000;

export const STAGES = [
  "not_handed_over", // saved on the board, nobody was asked
  "requested", // asked, nobody has taken it yet
  "held", // asked, but parked for the owner (to = owner / hold): no writer will take it
  "dispatch_unknown", // the dispatcher started a session and lost the answer
  "accepted", // a writer took it; no sign of work since
  "running", // taken, and the run reported in after taking it
  "silent", // taken, but its lease ran out without a report
  "unknown", // marked unknown: outcome unconfirmed, waiting for a person
  "completed", // the run closed it (outcome done / stopped)
] as const;
export type Stage = (typeof STAGES)[number];

export interface LifecycleInput {
  item: { item_id: string; state: string; updated_at: number; updated_by: string };
  /** The item's handoff as store.ts shows it, or null when it was never handed over. */
  handoff: {
    state: string; request_id: string | null; requested_at: number | null; accepted_by: string | null;
    accepted_at: number | null; to: string | null; generation: number | null; heartbeat_at: number | null;
    lease_until: number | null; phase?: string | null; phase_at?: number | null;
  } | null;
  /** The dispatcher's newest row for this request (devin only), or null. */
  dispatch: { status: string; at: number; session_id: string | null; attempts: number } | null;
  /** Newest-first https refs written as events of the item (PR / Issue / commit links). */
  refs: { at: number; actor: string; ref: string }[];
}

export interface Lifecycle {
  stage: Stage;
  /** One line for the person asking. */
  summary: string;
  /** Facts the stage rests on: what was seen, with when and by whom. Nothing here is a guess. */
  evidence: string[];
  /** What the board cannot see; reported instead of guessed. */
  unconfirmed: string[];
  needs_attention: boolean;
  stalled: boolean;
  /** Ways forward, as descriptions. The board runs none of them; each one names the tool and the duplicate-run risk. */
  options: string[];
  times: { requested_at: number | null; accepted_at: number | null; heartbeat_at: number | null; lease_until: number | null };
  accepted_by: string | null;
  reported_phase: { label: string; at: number } | null;
  outcome: "done" | "stopped" | null;
  result_refs: { at: number; actor: string; ref: string }[];
}

const stamp = (t: number) => new Date(t).toISOString();

export function deriveLifecycle(input: LifecycleInput, now: number): Lifecycle {
  const { item, handoff: h, dispatch } = input;
  const out: Lifecycle = {
    stage: "not_handed_over", summary: "", evidence: [], unconfirmed: [], needs_attention: false, stalled: false, options: [],
    times: {
      requested_at: h?.requested_at ?? null, accepted_at: h?.accepted_at ?? null,
      heartbeat_at: h?.heartbeat_at ?? null, lease_until: h?.lease_until ?? null,
    },
    accepted_by: h?.accepted_by ?? null,
    reported_phase: h?.phase && typeof h.phase_at === "number" ? { label: h.phase, at: h.phase_at } : null,
    outcome: null,
    result_refs: input.refs,
  };
  out.evidence.push(`item ${item.item_id} is ${item.state}, last written ${stamp(item.updated_at)} by ${item.updated_by}`);

  if (h === null) {
    out.stage = "not_handed_over";
    out.summary = "看板に保存されているだけです。誰にも依頼されておらず、受け付けた担当もいません。";
    out.unconfirmed.push("保存に成功したことは、実行する担当に届いたことを意味しません。この項目には引渡し依頼（handoff）がありません");
    out.needs_attention = item.state === "planned" || item.state === "in_progress";
    if (out.needs_attention) out.options.push("引き渡すなら board_request_handoff（宛先 to を付けると、その担当だけが受け付けられる）");
    return out;
  }

  const view: HandoffView = {
    state: h.state, request_id: h.request_id, accepted_by: h.accepted_by, generation: h.generation, lease_until: h.lease_until,
  };
  const request = h.request_id ?? "(no id)";
  if (h.requested_at !== null) out.evidence.push(`request ${request} was made ${stamp(h.requested_at)}`);

  if (h.state === "requested") {
    const waited = h.requested_at === null ? null : now - h.requested_at;
    out.stalled = waited !== null && waited > REQUEST_STALL_MS;
    const to = h.to;
    if (to === "owner" || to === "hold") {
      out.stage = "held";
      out.summary = `依頼は ${to === "owner" ? "持ち主の判断待ち" : "保留"} に置かれています。誰も受け付けません。`;
      out.needs_attention = true;
      out.options.push("宛先を決めるなら board_route_handoff（持ち主が決めるまで誰も受け付けない）");
      return out;
    }
    out.stage = "requested";
    out.evidence.push(to === null ? "no destination yet: the board chooses on its next pass" : `destination: ${to}`);
    out.summary = `依頼は出ていますが、まだ誰も受け付けていません${to ? `（宛先: ${to}）` : "（宛先は看板が選ぶところです）"}。`;
    out.unconfirmed.push("実行者が依頼を読んだか、そもそも存在するかは、受付の記録が出るまで確認できません");
    if (dispatch !== null) {
      out.evidence.push(`dispatcher: ${dispatch.attempts} attempt(s), last "${dispatch.status}" at ${stamp(dispatch.at)}${dispatch.session_id ? ` (session ${dispatch.session_id})` : ""}`);
      if (dispatch.status === "unknown") {
        out.stage = "dispatch_unknown";
        out.summary = "起動を試みた結果が分かりません。起動の返事が届かず、動いているかどうか確認できていません。";
        out.needs_attention = true;
        out.options.push("起動先を人が見て、動いていなければ board_resolve_dispatch(resolution: retry)、動いていれば resolution: started と session_id。確認前に再試行すると二重実行になりえます");
        return out;
      }
      if (dispatch.status === "refused") {
        out.needs_attention = true;
        out.evidence.push("the start was refused by the other side (4xx): nothing was started");
      }
      if (dispatch.status === "claimed") out.unconfirmed.push("起動の途中です。結果はまだ記録されていません");
      if (dispatch.status === "started") out.unconfirmed.push("起動の返事は受け取りましたが、担当はまだ受付を返していません");
    } else if (to !== null && to !== "devin") {
      out.unconfirmed.push(`宛先 ${to} へこの看板から起動をかける仕組みはありません。担当が自分で看板を見に来るまで届きません`);
    }
    if (out.stalled) {
      out.needs_attention = true;
      out.evidence.push(`nobody took it in ${Math.round((waited as number) / 60000)} minutes`);
      out.options.push("宛先を替える board_route_handoff、依頼を取り下げる board_take_back_handoff。受付が無いうちは取り下げても二重実行になりません");
    }
    return out;
  }

  if (h.state === "accepted") {
    out.evidence.push(`taken by ${h.accepted_by ?? "?"}${h.accepted_at !== null ? ` at ${stamp(h.accepted_at)}` : ""}, generation ${h.generation ?? "none (taken before generations)"}`);
    const reported = h.heartbeat_at !== null && h.accepted_at !== null && h.heartbeat_at > h.accepted_at;
    if (h.heartbeat_at !== null) out.evidence.push(`last report ${stamp(h.heartbeat_at)}${h.lease_until !== null ? `, lease until ${stamp(h.lease_until)}` : ""}`);
    if (leaseExpired(view, now)) {
      out.stage = "silent";
      out.summary = `${h.accepted_by ?? "担当"} が受け付けたあと、期限（lease）内に連絡がありません。動いているのか止まったのか、看板からは分かりません。`;
      out.needs_attention = true;
      out.unconfirmed.push("止まったとは断定できません。連絡が切れただけで、まだ動いている可能性があります");
      out.options.push("担当に状況を確かめる。確認が取れないなら board_mark_handoff_unknown で『不明』に記録（自動では再実行されません）");
      return out;
    }
    if (reported || out.reported_phase !== null) {
      out.stage = "running";
      out.summary = out.reported_phase
        ? `${h.accepted_by ?? "担当"} の最新の工程報告：${out.reported_phase.label}。`
        : `${h.accepted_by ?? "担当"} から連絡があります。作業工程は未報告です。`;
    } else {
      out.stage = "accepted";
      out.summary = `${h.accepted_by ?? "担当"} が受け付けました。ただし、受付のあとの連絡（進捗・心拍）はまだありません。`;
      out.unconfirmed.push("着手したかどうかは、受付のあとの連絡が来るまで確認できません");
    }
    if (h.phase === "回答待ち") out.needs_attention = true;
    return out;
  }

  if (h.state === "unknown") {
    out.stage = "unknown";
    out.summary = "担当の結果が不明として記録されています。人が確かめるまで、再実行も再依頼もされません。";
    out.needs_attention = true;
    out.options.push("まだ動いていると確認できれば board_resume_handoff。止まっていると確認できれば board_release_handoff(stopped_confirmed: true) で依頼を戻す");
    return out;
  }

  if (h.state === "completed") {
    out.stage = "completed";
    out.outcome = item.state === "done" ? "done" : item.state === "stopped" ? "stopped" : null;
    out.summary = out.outcome === "stopped"
      ? `${h.accepted_by ?? "担当"} が『停止』として締めました。完了ではありません。`
      : `${h.accepted_by ?? "担当"} が完了として締めました。人の受け入れ確認は別です。`;
    out.needs_attention = out.outcome === "stopped";
    return out;
  }

  // A handoff state this file does not know: say so rather than guess.
  out.summary = `依頼の状態「${h.state}」はこの判定が知らない値です。`;
  out.unconfirmed.push("未知の状態");
  out.needs_attention = true;
  return out;
}
