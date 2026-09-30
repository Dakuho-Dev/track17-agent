'use strict';

/** The control window: a form over config.json, a Start/Stop pair, and a log. */

const fields = {
  text: ['baseUrl', 'token'],
  number: ['batchSize', 'batchDelaySeconds', 'idleMinutes', 'etsyPagesPerShop', 'etsyPageDelaySeconds'],
  check: ['autoRun', 'showBrowser'],
  select: ['lanes'],
};

const el = (id) => document.getElementById(id);

function readForm() {
  const patch = {};
  for (const id of fields.text) patch[id] = el(id).value.trim();
  for (const id of fields.number) patch[id] = Number(el(id).value) || undefined;
  for (const id of fields.check) patch[id] = el(id).checked;
  for (const id of fields.select) patch[id] = el(id).value;
  return patch;
}

function fillForm(settings) {
  for (const id of [...fields.text, ...fields.number, ...fields.select]) {
    el(id).value = settings[id] ?? '';
  }
  for (const id of fields.check) el(id).checked = Boolean(settings[id]);
}

function appendLog(line) {
  const log = el('log');
  // Keep the window responsive over a long unattended run.
  if (log.childElementCount > 500) log.removeChild(log.firstChild);
  const row = document.createElement('div');
  row.textContent = line;
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
}

async function save() {
  await window.agent.saveConfig(readForm());
  appendLog('Đã lưu cài đặt.');
}

el('save').addEventListener('click', save);

el('test').addEventListener('click', async () => {
  await save();
  try {
    const result = await window.agent.test();
    appendLog(result.message);
  } catch (error) {
    appendLog(`Không kết nối được: ${error.message}`);
  }
});

el('open').addEventListener('click', () => window.agent.showBrowser());

el('etsy-login').addEventListener('click', async () => {
  await save();
  try {
    const result = await window.agent.etsyLogin();
    appendLog(result.message);
  } catch (error) {
    appendLog(`Không mở được cửa sổ Etsy: ${error.message}`);
  }
});

el('start').addEventListener('click', async () => {
  // Save first: an operator who edits a field and presses Start expects the
  // run to use what is on screen, not what was last saved.
  await save();
  const result = await window.agent.start();
  if (!result.ok) appendLog(result.message);
});

el('stop').addEventListener('click', async () => {
  const result = await window.agent.stop();
  if (!result.ok) appendLog(result.message);
});

window.agent.onLog(appendLog);

window.agent.onState(({ running, stats }) => {
  el('start').disabled = running;
  el('stop').disabled = !running;
  el('status').textContent = running ? 'Đang chạy' : 'Đang nghỉ';
  el('status').className = running ? 'on' : '';
  el('s-batches').textContent = stats.batches;
  el('s-looked').textContent = stats.looked;
  el('s-etsy').textContent = stats.etsyOrders;
  el('s-updated').textContent = stats.updated;
  el('s-delivered').textContent = stats.delivered;
  el('s-errors').textContent = stats.errors;
});

window.agent.getConfig().then(fillForm);
