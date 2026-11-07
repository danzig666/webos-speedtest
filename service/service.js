'use strict';
/*
 * Luna service for the Speedtest app.
 *
 *   luna://io.github.danzig666.speedtest.service/start   {subscribe:true, pty?:bool}
 *   luna://io.github.danzig666.speedtest.service/cancel  {}
 *
 * `start` must be a subscription. It streams:
 *   {event:'accepted'}            run created (mode, binary, uid)
 *   {event:'version', text}       output of `speedtest --version`
 *   {event:'started', pid}        CLI process launched
 *   {event:'output', chunks:[{s:'out'|'err', d:'raw text'}]}
 *   {event:'stopping', reason}    cancel/timeout in progress
 *   {event:'exit', ran, code, signal, reason, error?}   last message
 *
 * If the subscriber goes away (app closed, subscription cancelled), the
 * running process is killed.
 */

var pkg = require('./package.json');
var Runner = require('./lib/runner').Runner;

function createService(Service, runnerConfig) {
  var service = new Service(pkg.name);
  var runner = new Runner(runnerConfig);
  var owner = null; // {message, run, activity}

  function keepAlive() {
    // Keep the JS service process alive while a test runs.
    try {
      if (service.activityManager && service.activityManager.create) {
        return service.activityManager.create('speedtest-run', function () {});
      }
    } catch (e) { /* not fatal */ }
    return null;
  }

  function release(activity) {
    try {
      if (activity && service.activityManager && service.activityManager.complete) {
        service.activityManager.complete(activity, function () {});
      }
    } catch (e) { /* not fatal */ }
  }

  service.register('start', function (message) {
    var payload = message.payload || {};
    if (!message.isSubscription) {
      message.respond({ returnValue: false, errorCode: 'SUBSCRIPTION_REQUIRED', errorText: 'Call start with {"subscribe": true}.' });
      return;
    }
    var entry = { message: message, run: null, activity: null, ended: false };
    try {
      entry.run = runner.start({ pty: payload.pty === true }, function (evt) {
        if (entry.ended) return;
        evt.returnValue = true;
        evt.subscribed = evt.event !== 'exit';
        try { message.respond(evt); } catch (e) { /* client gone */ }
        if (evt.event === 'exit') {
          entry.ended = true;
          if (owner === entry) owner = null;
          release(entry.activity);
          try { message.cancel(); } catch (e2) { /* already closed */ }
        }
      });
    } catch (err) {
      message.respond({ returnValue: false, subscribed: false, errorCode: err.code || 'ERROR', errorText: err.message, hint: err.hint });
      try { message.cancel(); } catch (e3) { /* ignore */ }
      return;
    }
    owner = entry;
    entry.activity = keepAlive();
  }, function onSubscriptionCancel(message) {
    // Client disappeared (app closed / relaunched / subscription cancelled).
    if (owner && owner.message === message && !owner.ended) {
      owner.run.cancel('client-gone');
    }
  });

  service.register('cancel', function (message) {
    var cancelled = runner.cancel('cancelled');
    message.respond({ returnValue: true, cancelled: cancelled });
  });

  function shutdown() {
    runner.dispose();
  }
  process.on('exit', shutdown);
  ['SIGTERM', 'SIGINT', 'SIGHUP'].forEach(function (sig) {
    process.on(sig, function () { shutdown(); process.exit(0); });
  });

  return { service: service, runner: runner };
}

module.exports = { createService: createService };

// run-js-service loads this file through its own launcher, so
// `require.main === module` is not reliable on the TV. Tests opt out instead.
if (process.env.SPEEDTEST_SERVICE_TEST !== '1') {
  createService(require('webos-service'));
}
