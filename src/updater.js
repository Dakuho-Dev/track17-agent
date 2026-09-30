'use strict';

const { app } = require('electron');

/**
 * Keeping an unattended machine up to date.
 *
 * The agent is meant to sit on a box nobody logs into, so "update" cannot mean
 * "someone downloads an installer". It means: notice a new GitHub Release,
 * fetch it, and restart into it — on its own.
 *
 * Two things make that safe rather than merely automatic:
 *
 *   It never restarts mid-pass. A 17track batch is claimed from WrL under a
 *   ten-minute lease and an Etsy walk takes minutes per shop; quitting in the
 *   middle would drop the answers and leave the numbers to time out. So a
 *   downloaded update waits for the loop to go idle, however long that takes.
 *
 *   It never blocks the work. Every failure here — no network, a malformed
 *   release, GitHub down — is logged and dropped. An agent that cannot update
 *   must still track parcels.
 *
 * Only a packaged build updates. Run from source, electron-updater has no
 * app-update.yml to read and throws, so that case is reported and skipped.
 */

/** Long enough to be polite to GitHub, short enough that a fix lands the same day. */
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** How often to re-ask "are you idle yet?" once an update is sitting ready. */
const IDLE_POLL_MS = 60 * 1000;

let started = false;

/**
 * @param {object} options
 * @param {(message: string) => void} options.log
 * @param {() => boolean} options.isBusy  true while a tracking pass is running
 */
function start({ log, isBusy }) {
  if (started) return;
  started = true;

  if (!app.isPackaged) {
    log('Chạy từ mã nguồn nên bỏ qua tự cập nhật — chỉ bản đã cài mới cập nhật được.');
    return;
  }

  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (error) {
    log('Không nạp được electron-updater: ' + error.message);
    return;
  }

  // electron-updater is chatty and its messages are exactly what you want when
  // an update did not arrive. Route them into the same log as everything else.
  autoUpdater.logger = {
    info: (message) => log('Cập nhật: ' + message),
    warn: (message) => log('Cập nhật (cảnh báo): ' + message),
    error: (message) => log('Cập nhật (lỗi): ' + message),
    debug: () => {},
  };

  autoUpdater.autoDownload = true;
  // The backstop: if the operator ever closes the app by hand before the idle
  // window arrives, the update is applied on the way out.
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    log('Có bản mới ' + info.version + ' — đang tải về.');
  });

  autoUpdater.on('update-not-available', () => {
    log('Đang ở bản mới nhất (' + app.getVersion() + ').');
  });

  autoUpdater.on('error', (error) => {
    log('Không kiểm tra được bản cập nhật: ' + (error && error.message ? error.message : error));
  });

  autoUpdater.on('update-downloaded', (info) => {
    log('Đã tải xong bản ' + info.version + ' — sẽ cài khi agent rảnh.');
    installWhenIdle(autoUpdater, { log, isBusy, version: info.version });
  });

  const check = () => {
    autoUpdater.checkForUpdates().catch((error) => {
      log('Không kiểm tra được bản cập nhật: ' + error.message);
    });
  };

  // Not on the first tick of the event loop: the control window is still being
  // created, and a message logged before it exists only reaches the file.
  setTimeout(check, 10 * 1000);
  setInterval(check, CHECK_EVERY_MS);
}

/**
 * Restart into the new version at the first moment nothing is in flight.
 *
 * Deliberately has no deadline. A forced restart would cost a batch of answers,
 * and the agent idles between passes anyway, so waiting always wins.
 */
function installWhenIdle(autoUpdater, { log, isBusy, version }) {
  const attempt = () => {
    if (isBusy()) return;
    clearInterval(timer);
    log('Agent đang rảnh — cài bản ' + version + ' và khởi động lại.');
    // (isSilent, isForceRunAfter): no installer UI on a headless box, and come
    // back up afterwards rather than leaving the machine with nothing running.
    autoUpdater.quitAndInstall(true, true);
  };

  const timer = setInterval(attempt, IDLE_POLL_MS);
  attempt();
}

module.exports = { start, CHECK_EVERY_MS };
