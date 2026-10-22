'use strict';

/**
 * Turning what 17track.net answered into the vocabulary WrL stores.
 *
 * Two shapes reach us, in descending order of confidence:
 *   1. the site's own tracking response, captured off the wire
 *   2. words scraped off the rendered page, when no such response shows up
 *
 * The response was read from a live query on 2026-09-28 and looks like this
 * (trimmed): the call is POST https://t.17track.net/track/restapi, and it
 * answers twice per batch — once to register the numbers (`code: 100`, no
 * `shipment`) and again with the data (`code: 200`).
 *
 *   { "shipments": [ {
 *       "code": 200,
 *       "number": "GFUS01073640572417",
 *       "pre_status": 40,
 *       "shipment": {
 *         "latest_status": { "status": "Delivered", "sub_status": "Delivered_Other" },
 *         "latest_event": { "time_iso": "...", "description": "...", "location": "Raleigh, NC" },
 *         "tracking": { "providers": [ { "provider": { "name": "GOFO" } } ] }
 *       } } ] }
 *
 * Older payload shapes (`dat` with a compact `track` object) are still read, so
 * a rollback on their side does not blind the agent.
 */

/**
 * 17track's numeric package state, as it appears in `pre_status`.
 * Only used when no status string came with the entry.
 */
const STATE_CODES = {
  0: 'NOT_FOUND',
  5: 'PRE_TRANSIT',
  10: 'IN_TRANSIT',
  20: 'EXPIRED',
  30: 'AVAILABLE_FOR_PICKUP',
  35: 'DELIVERY_FAILURE',
  40: 'DELIVERED',
  50: 'EXCEPTION',
};

/** Phrases the rendered page uses, longest/most specific first. */
const PAGE_PHRASES = [
  'Delivered',
  'Out For Delivery',
  'Out for delivery',
  'Available for Pickup',
  'Pick Up',
  'Undelivered',
  'Delivery Failure',
  'Expired',
  'Alert',
  'Exception',
  'In Transit',
  'Info Received',
  'InfoReceived',
  'Not Found',
  'NotFound',
];

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function eventTime(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Normalise one entry of a captured tracking response. */
function fromApiEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;

  const trackingNumber = firstString(entry.no, entry.number);
  if (!trackingNumber) return null;

  // `shipment` is the current shape, `track_info` an older one; `track` is the
  // oldest and compact. Whichever is present carries the same three things.
  const detail =
    (entry.shipment && typeof entry.shipment === 'object' && entry.shipment) ||
    (entry.track_info && typeof entry.track_info === 'object' && entry.track_info) ||
    null;
  const compact = entry.track && typeof entry.track === 'object' ? entry.track : null;

  const result = { trackingNumber };

  const code = Number.isInteger(entry.pre_status)
    ? entry.pre_status
    : compact && Number.isInteger(compact.e)
      ? compact.e
      : null;
  if (code !== null && STATE_CODES[code]) result.status = STATE_CODES[code];

  const latestStatus = detail && detail.latest_status ? detail.latest_status : null;
  result.statusText = firstString(
    latestStatus && latestStatus.status,
    entry.prior_status,
    latestStatus && latestStatus.sub_status,
  );

  // z0 is the newest event in the compact shape: `z` description, `c` place, `a` time.
  const latestEvent = (detail && detail.latest_event) || (compact && compact.z0) || null;
  if (latestEvent && typeof latestEvent === 'object') {
    const description = firstString(latestEvent.description, latestEvent.z);
    const place = firstString(latestEvent.location, latestEvent.c);
    result.lastEvent = [description, place].filter(Boolean).join(' — ') || null;
    result.lastEventAt = eventTime(
      firstString(latestEvent.time_iso, latestEvent.time_utc, latestEvent.a),
    );
    if (!result.statusText) result.statusText = description;
  }

  const provider =
    (detail &&
      detail.tracking &&
      detail.tracking.providers &&
      detail.tracking.providers[0] &&
      detail.tracking.providers[0].provider) ||
    null;
  result.carrier = firstString(provider && provider.name, provider && provider.alias);

  // The "More info" box on the page (Last-mile Carrier / Last-mile Tracking Number)
  // is `misc_info` in this same response — read on 2026-10-21 for Yanwen
  // UL588363235YP: { local_number: "4205960292…", local_provider: "USPS" }.
  const misc = detail && detail.misc_info && typeof detail.misc_info === 'object' ? detail.misc_info : null;
  const lastMile = misc ? firstString(misc.local_number) : null;
  if (lastMile && lastMile.toUpperCase() !== trackingNumber.toUpperCase()) {
    result.lastMileNumber = lastMile.replace(/\s+/g, '');
    result.lastMileCarrier = firstString(misc.local_provider);
    // When the last mile showed up: the first event in the destination country
    // ("Shipping Label Created, USPS Awaiting Item" in Los Angeles, for example).
    const country =
      detail.shipping_info && detail.shipping_info.recipient_address && detail.shipping_info.recipient_address.country;
    const events = ((detail.tracking && detail.tracking.providers) || []).flatMap((p) => (p && p.events) || []);
    const local = events
      .filter((e) => e && e.address && country && e.address.country === country)
      .map((e) => eventTime(firstString(e.time_utc, e.time_iso)))
      .filter(Boolean)
      .sort();
    result.lastMileSince = local[0] || null;
  }

  // The registration echo (`code: 100`) carries a number and nothing else —
  // posting that back would be claiming an answer we do not have.
  if (!result.status && !result.statusText && !result.lastEvent) return null;
  return result;
}

/** Pull every entry out of a captured tracking response body. */
function fromApiResponse(body) {
  if (!body || typeof body !== 'object') return [];
  const entries = Array.isArray(body.shipments)
    ? body.shipments
    : Array.isArray(body.dat)
      ? body.dat
      : Array.isArray(body.data)
        ? body.data
        : Array.isArray(body.data && body.data.accepted)
          ? body.data.accepted
          : [];
  return entries.map(fromApiEntry).filter(Boolean);
}

module.exports = { STATE_CODES, PAGE_PHRASES, fromApiEntry, fromApiResponse };
