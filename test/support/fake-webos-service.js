'use strict';
/*
 * Just enough of the webOS `webos-service` module to run service/service.js
 * off-device: register(name, onRequest, onCancel), Message.respond/cancel,
 * isSubscription, activityManager.create/complete.
 */
function Message(service, method, payload, sink) {
  this.service = service;
  this.method = method;
  this.payload = payload || {};
  this.isSubscription = this.payload.subscribe === true;
  this.sink = sink; // function(response) ; sink.closed set by transport
  this.cancelled = false;
}
Message.prototype.respond = function (obj) {
  if (this.cancelled) throw new Error('respond after cancel');
  this.sink(JSON.parse(JSON.stringify(obj)));
};
Message.prototype.cancel = function () {
  // Service-side end of a subscription (does NOT fire the cancel callback).
  if (this.cancelled) return;
  this.cancelled = true;
  if (this.onEnd) this.onEnd();
};

function Service(name) {
  this.name = name;
  this.methods = {};
  this.activities = 0;
  var self = this;
  this.activityManager = {
    create: function (id, cb) { self.activities++; var a = { id: id }; if (cb) setImmediate(cb, a); return a; },
    complete: function (a, cb) { self.activities--; if (cb) setImmediate(cb); }
  };
  Service.instances.push(this);
}
Service.instances = [];
Service.prototype.register = function (name, onRequest, onCancel) {
  this.methods[name] = { onRequest: onRequest, onCancel: onCancel };
};
/** Client-side call. Returns {message, cancel()} — cancel() = client drops the subscription. */
Service.prototype.call = function (method, payload, onResponse) {
  var m = this.methods[method];
  if (!m) throw new Error('Unknown method ' + method);
  var msg = new Message(this, method, payload, onResponse);
  m.onRequest(msg);
  return {
    message: msg,
    cancel: function () {
      if (msg.cancelled) return;
      msg.cancelled = true;
      if (m.onCancel) m.onCancel(msg);
    }
  };
};
module.exports = Service;
