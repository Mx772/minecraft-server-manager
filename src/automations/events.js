'use strict';

// The events an automation can trigger on, as data: how each reads in a sentence,
// and the rules its steps follow. Which actions each event allows is on the
// action itself (`events` in actions.js), so a new action opts in by data.

/**
 * @typedef {object} EventInfo
 * @property {string} when how it reads in an error ("can't run <when>")
 * @property {string} fired how it reads in a history line ("Automation fired <fired>: Name.")
 * @property {string} reason why an action that does not fit cannot run then
 * @property {boolean} [zeroOffsetOnly] every step must be at offset 0
 */

/** @type {Record<string, EventInfo>} */
const EVENTS = {
  'before-start': {
    when: 'before the server starts',
    fired: 'before the server started',
    reason: "the server isn't running yet",
    zeroOffsetOnly: true,
  },
  'after-start': {
    when: 'after the server starts',
    fired: 'after the server started',
    reason: 'it could undo the start that just happened',
  },
  'after-stop': {
    when: 'after the server stops',
    fired: 'after the server stopped',
    reason: 'the server is stopped',
  },
  'on-crash': {
    when: 'after the server crashes',
    fired: 'after the server crashed',
    reason: 'the server is down',
  },
  'after-pack-install': {
    when: 'after a modpack update installs',
    fired: 'after a modpack update installed',
    reason: 'it could undo the update that just happened',
  },
};

const EVENT_NAMES = /** @type {[string, ...string[]]} */ (Object.keys(EVENTS));

/** Longest a step on an event may wait after the event, in seconds. */
const MAX_EVENT_OFFSET_SEC = 3600;

module.exports = { EVENTS, EVENT_NAMES, MAX_EVENT_OFFSET_SEC };
