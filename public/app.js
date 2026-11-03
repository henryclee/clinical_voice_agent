// Text-mode demo client (no build step). Streams transcript over /ws/call?callId=…
/* eslint-env browser */
(function () {
  const log = document.getElementById('log');
  const input = document.getElementById('text');
  const sendBtn = document.getElementById('send');
  const startBtn = document.getElementById('start');
  const hangupBtn = document.getElementById('hangup');
  const latencies = [];
  let socket = null;
  let callId = null;

  function add(kind, text, meta) {
    const div = document.createElement('div');
    div.className = 'msg ' + kind;
    div.textContent = text;
    if (meta) {
      const line = document.createElement('div');
      line.className = 'meta';
      line.textContent = meta;
      div.appendChild(line);
    }
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  function percentile(values, p) {
    if (!values.length) return null;
    const sorted = values.slice().sort(function (a, b) { return a - b; });
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
  }

  function renderLatency() {
    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);
    document.getElementById('latency').textContent =
      (p50 === null ? '—' : Math.round(p50) + ' ms') + ' / ' + (p95 === null ? '—' : Math.round(p95) + ' ms');
  }

  async function getJson(url, options) {
    const response = await fetch(url, options);
    const body = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(body.error || response.status + ' ' + url);
    return body;
  }

  async function checkHealth() {
    try {
      const health = await getJson('/healthz');
      document.getElementById('health').textContent =
        'agent: ' + health.llm + (health.llm === 'openai-compat' ? ' (' + health.model + ')' : '') +
        ' · store: ' + health.repositories + ' · script ' + health.script +
        (health.textOnly ? ' · text-only mode' : ' · voice transport configured');
    } catch (error) {
      document.getElementById('health').textContent = 'server unreachable: ' + error.message;
    }
  }

  function renderSummary(summary) {
    const staff = summary.staff || {};
    const fields = Object.entries(summary.fields || {})
      .filter(function (entry) { return entry[1] !== null && entry[1] !== undefined; })
      .map(function (entry) { return entry[0] + '=' + JSON.stringify(entry[1]); });
    const lines = ['outcome: ' + (summary.outcome || 'none'), 'fields: ' + (fields.join(', ') || 'none')];
    if ((summary.missingRequired || []).length) lines.push('missing steps: ' + summary.missingRequired.join(', '));
    if ((staff.escalations || []).length)
      lines.push('escalations: ' + staff.escalations.map(function (e) { return e.rule_id + '/' + e.urgency; }).join(', '));
    lines.push(staff.one_line_summary || summary.summaryText || '');
    document.getElementById('summary').className = 'summary';
    document.getElementById('summary').textContent = lines.join('\n');
    document.getElementById('outcome').textContent = summary.outcome || 'none';
    const list = document.getElementById('escalations');
    list.innerHTML = (staff.escalations || [])
      .map(function (e) { return '<li>' + e.rule_id + ' (' + e.urgency + '): ' + e.reason + '</li>'; })
      .join('');
    if (!list.children.length) list.innerHTML = '<li class="hint">none</li>';
  }

  async function showSummary(id) {
    try {
      renderSummary(await getJson('/calls/' + encodeURIComponent(id) + '/summary'));
    } catch (error) {
      add('agent', 'could not load summary: ' + error.message);
    }
  }

  function finish() {
    sendBtn.disabled = true;
    hangupBtn.disabled = true;
    if (callId) void showSummary(callId);
  }


  function openSocket(id) {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(scheme + '://' + location.host + '/ws/call?callId=' + encodeURIComponent(id));
    socket.onmessage = function (event) {
      const message = JSON.parse(event.data);
      if (message.type === 'agent_text') {
        if (typeof message.latencyMs === 'number') {
          latencies.push(message.latencyMs);
          renderLatency();
        }
        document.getElementById('step').textContent = message.step || '—';
        (message.escalations || []).forEach(function (rule) {
          const item = document.createElement('li');
          item.textContent = rule;
          document.getElementById('escalations').appendChild(item);
          add('escalation', 'red flag -> ' + rule);
        });
        add('agent', message.text, 'step: ' + (message.step || '—') + (message.callEnded ? ' · call ended' : ''));
        if (message.callEnded) {
          document.getElementById('outcome').textContent = message.outcome || 'closed';
          finish();
        }
      } else if (message.type === 'ended') {
        finish();
      } else if (message.type === 'error') {
        add('agent', 'error: ' + message.error);
      }
    };
    socket.onerror = function () {
      add('agent', 'websocket error — start the server with `npm start` and reload');
    };
    socket.onclose = function () {
      sendBtn.disabled = true;
      hangupBtn.disabled = true;
    };
  }

  startBtn.addEventListener('click', function () {
    startBtn.disabled = true;
    log.innerHTML = '';
    latencies.length = 0;
    document.getElementById('summary').className = 'summary hint';
    document.getElementById('summary').textContent = 'appears when the call ends';
    document.getElementById('escalations').innerHTML = '<li class="hint">none</li>';
    getJson('/patients')
      .then(function (patients) {
        if (!patients.length) throw new Error('no patients — run `npm run db:seed` or POST /ingest/discharge');
        return getJson('/calls/text', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ patientId: patients[0].id }),
        });
      })
      .then(function (turn) {
        callId = turn.callId;
        document.getElementById('callId').textContent = String(callId).slice(0, 8) + '…';
        document.getElementById('step').textContent = turn.stepId || '—';
        document.getElementById('outcome').textContent = turn.outcome || 'open';
        add('agent', turn.agentUtterance, 'step: ' + (turn.stepId || '—'));
        openSocket(callId);
      })
      .catch(function (error) {
        add('agent', 'start failed: ' + error.message);
        startBtn.disabled = false;
      });
  });

  document.getElementById('chat').addEventListener('submit', function (event) {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || !socket || socket.readyState !== 1 || !callId) return;
    socket.send(JSON.stringify({ type: 'text', text: text }));
    add('user', text);
    input.value = '';
  });

  hangupBtn.addEventListener('click', function () {
    if (socket && socket.readyState === 1) socket.send(JSON.stringify({ type: 'end' }));
    finish();
  });

  void checkHealth();
})();
