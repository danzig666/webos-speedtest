/*
 * Tiny Luna bus client on top of webOS's PalmServiceBridge (no webOSTV.js
 * dependency). Bridges are kept referenced until finished: on webOS a
 * garbage-collected bridge silently drops its subscription.
 */
(function (root) {
  'use strict';

  var live = [];

  function available() {
    return typeof root.PalmServiceBridge === 'function';
  }

  /**
   * call('luna://svc/method', params, onResponse) -> {cancel()}
   * onResponse(response) runs for every response (subscriptions: many).
   */
  function call(uri, params, onResponse) {
    if (!available()) {
      setTimeout(function () {
        onResponse({ returnValue: false, errorCode: 'NO_LUNA', errorText: 'Luna bus not available (not running on webOS?)' });
      }, 0);
      return { cancel: function () {} };
    }
    var bridge = new root.PalmServiceBridge();
    var handle = { bridge: bridge, done: false };
    live.push(handle);
    bridge.onservicecallback = function (msg) {
      var res;
      try { res = typeof msg === 'string' ? JSON.parse(msg) : msg; }
      catch (e) { res = { returnValue: false, errorText: 'Invalid JSON from service' }; }
      try { onResponse(res); } catch (e2) { if (root.console) root.console.error(e2); }
    };
    bridge.call(uri, JSON.stringify(params || {}));
    handle.cancel = function () {
      if (handle.done) return;
      handle.done = true;
      try { bridge.cancel(); } catch (e) { /* ignore */ }
      var i = live.indexOf(handle);
      if (i >= 0) live.splice(i, 1);
    };
    return handle;
  }

  root.Luna = { call: call, available: available };
})(this);
