'use strict';

const { app } = require('electron');

/**
 * Keeping an unattended machine up to date.
 *
 * The agent is meant to sit on a box nobody logs into, so "update" cannot mean
 * "someone downloads an installer". It means: notice a new GitHub Release,
 * fetch it, and restart into it — on its own, in one go.
 *
 * It used to hold a downloaded update until the agent went idle. With the
 * tracking passes, the CSV timer and the inbox each on their own clock, "idle"
 * could take hours to come round, so a fix sat on disk while the box ran the
 * old code. Now a downloaded update is installed straight away. What that
 * costs is small: a 17track batch cut short is under a ten-minute lease and
 * WrL hands it out again, and every other job picks up on its next round.
 *
 * It never blocks the work. Every failure here — no network, a malformed
 * release, GitHub down — is logged and dropped. An agent that cannot update
 * must still track parcels.
 *
 * Only a packaged build updates. Run from source, electron-updater has no
 * app-update.yml to read and throws, so that case is reported and skipped.
 */

/** Short enough that a release lands within the hour, long enough to be polite to GitHub. */
const CHECK_EVERY_MS = 30 * 60 * 1000;

let started = false;

/**
 * @param {object} options
 * @param {(message: string) => void} options.log
 */
function start({ log }) {
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
  // The backstop: if the app is closed by hand between download and install,
  // the update is applied on the way out.
  autoUpdater.autoInstallOnAppQuit = true;

  let installing = false;

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
    if (installing) return;
    installing = true;
    log('Đã tải xong bản ' + info.version + ' — cài ngay và khởi động lại.');
    // Give the log line a moment to reach the file and the window.
    setTimeout(() => {
      // (isSilent, isForceRunAfter): no installer UI on a headless box, and come
      // back up afterwards rather than leaving the machine with nothing running.
      autoUpdater.quitAndInstall(true, true);
    }, 3000);
  });

  const check = () => {
    if (installing) return;
    autoUpdater.checkForUpdates().catch((error) => {
      log('Không kiểm tra được bản cập nhật: ' + error.message);
    });
  };

  // Not on the first tick of the event loop: the control window is still being
  // created, and a message logged before it exists only reaches the file.
  setTimeout(check, 10 * 1000);
  setInterval(check, CHECK_EVERY_MS);
}

module.exports = { start, CHECK_EVERY_MS };
