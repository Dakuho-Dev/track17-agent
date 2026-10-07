'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Settings live next to the app's own data, not in the repo: the token is a
 * shared secret and the operator edits it from the window, not by hand.
 */

const DEFAULTS = {
  /** WrL's public base URL — the agent talks to nothing else. */
  baseUrl: 'https://wearelucky.io.vn',
  /** Matches MANUAL_TRACKING_TOKEN on WrL. */
  token: '',
  /** 17track.net takes forty numbers per query; WrL hands out at most that. */
  batchSize: 40,
  /** Pause between batches, in seconds. Enough for the site to settle. */
  batchDelaySeconds: 25,
  /** How long to wait for 17track to answer one batch, in seconds. */
  lookupTimeoutSeconds: 60,
  /**
   * Which lanes to work: 'both', 'track17' (non-USPS, via 17track.net) or
   * 'etsy' (everything Etsy can answer for, which is the only route left for
   * USPS). See src/etsy.js for why USPS has no third-party option.
   */
  lanes: 'both',
  /** Calls per status list per shop in the Etsy lane, 50 orders each. */
  etsyPagesPerShop: 5,
  /** Pause between those calls, in seconds. */
  etsyPageDelaySeconds: 8,
  /** Hidemyacc's local API; the Etsy lane reads each shop inside its profile. */
  hmaUrl: 'http://127.0.0.1:2268',
  /**
   * Which Hidemyacc profile reads which shop: { [shopName]: profileId }.
   * A shop left out here is matched by name when that is unambiguous — see
   * guessProfile in src/hidemyacc.js.
   */
  hmaProfiles: {},
  /** Close a profile after reading, but only one the agent opened itself. */
  hmaCloseAfterRead: false,
  /**
   * Download each shop's Etsy CSV at the times set on the CMS page "Tải Etsy
   * CSV" (see src/csv-download.js). The CSV type and the timetable live in the
   * CMS; only where the files go is set here.
   */
  csvEnabled: true,
  /** The CMS API that holds that config. */
  cmsApiUrl: 'https://apiserver.dakuho.com',
  /** Where the CSVs are saved, one folder per shop. */
  csvDownloadDir: path.join(os.homedir(), 'Downloads', 'Etsy CSV'),
  /** Timetable slots already run ("2026-10-07 08:00"), so a restart does not repeat one. */
  csvDoneSlots: [],
  /** Keep working through the queue on a timer instead of one batch at a time. */
  autoRun: false,
  /** Minutes to idle after the queue empties before asking again. */
  idleMinutes: 30,
  /** Show the 17track window. Off puts it out of the way but still running. */
  showBrowser: true,
};

function configPath(app) {
  return path.join(app.getPath('userData'), 'config.json');
}

function load(app) {
  try {
    const raw = fs.readFileSync(configPath(app), 'utf8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    // No file yet, or a file someone hand-edited into invalid JSON. Either way
    // the defaults are a working starting point.
    return { ...DEFAULTS };
  }
}

function save(app, patch) {
  const next = { ...load(app), ...patch };
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(configPath(app), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

module.exports = { DEFAULTS, load, save, configPath };
