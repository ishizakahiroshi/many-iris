// The picker's WebSocket watch on the board.
//
//   node src/main.mjs --watch   wake on board notifications, poll as fallback
//
// The board accepts GET + Upgrade on the same URL as the tool calls
// (/board/mcp, or /board/mcp/watch) with the writer key as the Bearer token,
// and sends {"type":"wake"} when work appears for this writer. The watch is
// a hint only: the regular interval pass still runs, so a missed or dropped
// connection only costs latency, never a pickup. Reconnects back off from
// a few seconds to a minute.

/** The watch URL is the board URL with an ws(s) scheme; the path is kept. */
export function watchUrl(boardUrl) {
  const url = new URL(boardUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

/**
 * Hold one watch connection and call onWake for each "wake" message.
 * Reconnects after a drop with backoff. `WebSocketImpl` and the timers are
 * injectable so tests need no server. Returns a close() handle.
 */
export function watchBoard({
  url,
  key,
  onWake,
  onState = () => {},
  WebSocketImpl = WebSocket,
  reconnectDelayMs = (attempt) => Math.min(5000 * attempt, 60000),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}) {
  let closed = false;
  let attempt = 0;
  let ws = null;
  let timer = null;

  const schedule = () => {
    if (closed || timer !== null) return;
    timer = setTimeoutImpl(() => { timer = null; connect(); }, reconnectDelayMs(attempt + 1));
    attempt += 1;
  };

  const connect = () => {
    if (closed) return;
    let socket;
    try {
      // Node's built-in WebSocket (undici) takes an options object here:
      // { headers } rides the upgrade request, so the writer key is only
      // ever in the Authorization header, as with the POST calls.
      socket = new WebSocketImpl(url, { headers: { authorization: `Bearer ${key}` } });
    } catch {
      schedule();
      return;
    }
    ws = socket;
    socket.onopen = () => { attempt = 0; onState("up"); };
    socket.onmessage = (event) => {
      const data = event.data;
      if (typeof data === "string" && data.includes('"wake"')) onWake();
    };
    const drop = () => {
      if (ws !== socket) return;
      ws = null;
      onState("down");
      schedule();
    };
    socket.onclose = drop;
    socket.onerror = () => { try { socket.close(); } catch { /* already gone */ } };
  };

  connect();
  return {
    close() {
      closed = true;
      if (timer !== null) clearTimeoutImpl(timer);
      try { ws?.close(); } catch { /* already gone */ }
    },
    get connected() { return ws !== null; },
  };
}
