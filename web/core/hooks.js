// Tiny event bus so optional features (the personal layer, Drive files, the public preview cache) can react to writes
// without the core knowing about them.
// Events: afterWrite({ key, type, input, created }), beforeRemove({ key }), afterRemove({ key }).
// A failing hook is logged, never fatal.
const log = require('./log');

const handlers = { afterWrite: [], beforeRemove: [], afterRemove: [] };

function on(event, fn) {
  if (!handlers[event]) throw new Error(`unknown hook event: ${event}`);
  handlers[event].push(fn);
}

async function emit(event, payload) {
  for (const fn of handlers[event]) {
    try { await fn(payload); } catch (e) { log.error(`hook ${event} failed: ${e.message}`); }
  }
}

module.exports = { on, emit };
