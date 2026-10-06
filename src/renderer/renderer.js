'use strict';

/** The control window: a form over config.json, a Start/Stop pair, and a log. */

const fields = {
  text: ['baseUrl', 'token', 'hmaUrl'],
  number: ['batchSize', 'batchDelaySeconds', 'idleMinutes', 'etsyPagesPerShop', 'etsyPageDelaySeconds'],
  check: ['autoRun', 'showBrowser', 'hmaCloseAfterRead'],
  select: ['lanes'],
};

const el = (id) => document.getElementById(id);

/** Set once the shop ↔ profile table has been filled from Hidemyacc. */
let hmaLoaded = false;

function readForm() {
  const patch = {};
  for (const id of fields.text) patch[id] = el(id).value.trim();
  for (const id of fields.number) patch[id] = Number(el(id).value) || undefined;
  for (const id of fields.check) patch[id] = el(id).checked;
  for (const id of fields.select) patch[id] = el(id).value;
  // Only once the table is on screen: before that there is nothing to read,
  // and sending an empty map would wipe the saved pairings.
  if (hmaLoaded) patch.hmaProfiles = readMapping();
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

// ------------------------------------------------ shop ↔ Hidemyacc profile

/** Every pairing on screen, as { [shopName]: profileId }. Blank ones are left out. */
function readMapping() {
  const mapping = {};
  for (const select of document.querySelectorAll('#hma-table select')) {
    if (select.value) mapping[select.dataset.shop] = select.value;
  }
  return mapping;
}

/** Same folding as src/hidemyacc.js, so the list ranks what the guess matches. */
const fold = (text) =>
  String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

function renderMapping({ shops, profiles }) {
  const body = el('hma-table').querySelector('tbody');
  body.replaceChildren();
  if (!shops.length) {
    const cell = body.insertRow().insertCell();
    cell.colSpan = 3;
    cell.className = 'muted';
    cell.textContent = 'WrL chưa có shop Etsy nào đang kết nối.';
    return;
  }

  for (const shop of shops) {
    const row = body.insertRow();
    row.insertCell().textContent = shop.shopName;
    row.insertCell().textContent = shop.waiting ?? '';

    // Profiles whose name carries the shop name go first — the right one is
    // almost always among them.
    const key = fold(shop.shopName);
    const hit = (profile) => Number(fold(profile.name).includes(key));
    const ranked = [...profiles].sort((a, b) => hit(b) - hit(a));

    const select = document.createElement('select');
    select.dataset.shop = shop.shopName;
    select.add(new Option('— chưa chọn —', ''));
    for (const profile of ranked) {
      const label = profile.status === 'running' ? `${profile.name}  (đang mở)` : profile.name;
      select.add(new Option(label, profile.id));
    }
    select.value = shop.profileId || '';

    const cell = row.insertCell();
    cell.appendChild(select);
    if (shop.guessed) {
      const note = document.createElement('small');
      note.textContent = 'Tự đoán theo tên — bấm Lưu để giữ.';
      cell.appendChild(note);
    }
  }
  hmaLoaded = true;
}

async function loadMapping() {
  try {
    renderMapping(await window.agent.hmaMapping());
  } catch (error) {
    appendLog(`Không tải được danh sách profile: ${error.message}`);
  }
}

el('hma-load').addEventListener('click', async () => {
  await save();
  await loadMapping();
});

el('hma-open').addEventListener('click', async () => {
  await save();
  try {
    const result = await window.agent.hmaOpen();
    appendLog(result.message);
    await loadMapping();
  } catch (error) {
    appendLog(`Không mở được profile: ${error.message}`);
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

window.agent.getConfig().then((settings) => {
  fillForm(settings);
  // The table needs WrL for the shop list, so only once there is a token.
  if (settings.token) loadMapping();
});
