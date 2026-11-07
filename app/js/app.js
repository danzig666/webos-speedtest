/* Speedtest CLI — UI controller. */
(function () {
  'use strict';

  var SERVICE = 'luna://io.github.danzig666.speedtest.service';
  var SERVICE_ID = 'io.github.danzig666.speedtest.service';
  var HBCHANNEL = 'luna://org.webosbrew.hbchannel.service';
  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 461, ESC: 27, BACKSPACE: 8, PGUP: 33, PGDN: 34 };
  var ELEVATE_CODES = ['BINARY_NO_ACCESS', 'BINARY_NOT_EXECUTABLE', 'PTY_UNAVAILABLE', 'INSTALL_DENIED'];
  var DOWNLOAD_CODES = ['BINARY_MISSING', 'BINARY_INCOMPATIBLE', 'BINARY_BROKEN', 'BINARY_INVALID', 'BINARY_NOT_EXECUTABLE'];

  var $ = function (id) { return document.getElementById(id); };
  var ui = {
    main: $('main'), results: $('results'), console: $('console'), state: $('state'), version: $('version'), svcMode: $('svcMode'),
    live: $('live'), livePhase: $('livePhase'), liveValue: $('liveValue'), liveBar: $('liveBar'), livePct: $('livePct'),
    error: $('error'), errorTitle: $('errorTitle'), errorHint: $('errorHint'),
    start: $('startBtn'), cancel: $('cancelBtn'), resultsBtn: $('resultsBtn'), elevate: $('elevateBtn'), mode: $('modeBtn'),
    download: $('downloadBtn'), termsBtn: $('termsBtn'), terms: $('terms'), accept: $('acceptBtn'), decline: $('declineBtn'),
    again: $('againBtn'), consoleBtn: $('consoleBtn')
  };

  var screen = new Term.Screen({ cols: 100, rows: 22, maxLines: 3000 });
  var view = new Term.DomView(ui.console, screen);
  var parsers = { out: new Term.AnsiParser(screen), err: new Term.AnsiParser(screen, { stream: 'err' }) };

  var state = 'idle';
  var sub = null;
  var runId = null;
  var uid = null;
  var renderQueued = false;
  var follow = true;
  var samples = { download: [], upload: [] };
  var phaseStart = {};
  var lastSummary = null;
  var transport = 'pipe';
  try { transport = localStorage.getItem('transport') === 'pty' ? 'pty' : 'pipe'; } catch (e) { /* storage unavailable */ }

  /* ---------------- rendering ---------------- */

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    (window.requestAnimationFrame || setTimeout)(function () {
      renderQueued = false;
      view.showCursor = state === 'running';
      view.render();
      if (follow) ui.console.scrollTop = ui.console.scrollHeight;
    });
  }

  ui.console.addEventListener('scroll', function () {
    var c = ui.console;
    follow = c.scrollTop + c.clientHeight >= c.scrollHeight - 8;
  });

  function writeLocal(text) {
    // Messages from the app itself, shown dimmed in the console.
    parsers.out.feed('\x1b[2m' + text + '\x1b[0m');
    scheduleRender();
  }

  function setState(s, label) {
    state = s;
    ui.state.className = 'chip state-' + (s === 'stopping' ? 'running' : s);
    ui.state.textContent = label || { idle: 'Ready', running: 'Running', stopping: 'Stopping…', done: 'Finished', failed: 'Failed', cancelled: 'Cancelled' }[s];
    var busy = s === 'running' || s === 'stopping';
    ui.start.disabled = busy;
    ui.cancel.disabled = !busy;
    ui.mode.disabled = busy;
    ui.start.textContent = s === 'idle' ? 'Start test' : 'Start again';
    var active = document.activeElement;
    if (active && active.disabled) focusEl(busy ? ui.cancel : ui.start);
    scheduleRender();
  }

  function showError(err) {
    ui.errorTitle.textContent = err.message || String(err);
    ui.errorHint.textContent = err.hint || '';
    ui.errorHint.hidden = !err.hint;
    ui.error.hidden = false;
    ui.elevate.hidden = !(uid !== 0 && ELEVATE_CODES.indexOf(err.code) !== -1 && window.Luna.available());
    ui.download.hidden = DOWNLOAD_CODES.indexOf(err.code) === -1;
    ui.termsBtn.hidden = err.code !== 'LICENSE_REQUIRED';
    var offer = !ui.download.hidden ? ui.download : !ui.termsBtn.hidden ? ui.termsBtn : null;
    if (offer) setTimeout(function () { focusEl(offer); }, 0);
  }

  function clearError() {
    ui.error.hidden = true;
    ui.elevate.hidden = true;
    ui.download.hidden = true;
    ui.termsBtn.hidden = true;
    var a = document.activeElement;
    if (!a || a === document.body || a.hidden || a.offsetParent === null) focusEl(ui.start.disabled ? ui.cancel : ui.start);
  }

  function setMode(m) {
    transport = m;
    ui.mode.textContent = 'Output: ' + m;
    try { localStorage.setItem('transport', m); } catch (e) { /* ignore */ }
  }

  /* ---------------- live progress ---------------- */

  function fmtMbps(v) { return v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2); }

  function updateLive() {
    var p = Results.parseProgress(screen.currentLineText());
    if (!p) return;
    ui.live.hidden = false;
    ui.live.classList.toggle('upload', p.phase === 'upload');
    if (p.phase === 'download' || p.phase === 'upload') {
      var now = Date.now();
      if (!phaseStart[p.phase]) phaseStart[p.phase] = now;
      var list = samples[p.phase];
      var t = (now - phaseStart[p.phase]) / 1000;
      if (!list.length || list[list.length - 1].t !== t) list.push({ t: t, v: p.mbps });
      ui.livePhase.textContent = p.phase === 'download' ? 'Download' : 'Upload';
      ui.liveValue.textContent = p.value + ' ' + p.unit;
      ui.liveBar.style.width = (p.percent || 0) + '%';
      ui.livePct.textContent = p.percent === null ? '' : p.percent + '%';
    } else {
      ui.livePhase.textContent = p.phase === 'latency' ? 'Latency' : 'Server';
      ui.liveValue.textContent = p.phase === 'latency' ? 'measuring…' : 'selecting…';
      ui.liveBar.style.width = '0';
      ui.livePct.textContent = '';
    }
  }

  /* ---------------- test lifecycle ---------------- */

  function startTest(acceptTerms) {
    if (state === 'running' || state === 'stopping') return;
    acceptTerms = acceptTerms === true;
    closeTerms(true);
    closeResults(true);
    clearError();
    screen.reset();
    view.clear();
    parsers.out.reset();
    parsers.err.reset();
    follow = true;
    samples = { download: [], upload: [] };
    phaseStart = {};
    lastSummary = null;
    ui.resultsBtn.hidden = true;
    ui.live.hidden = true;
    setState('running', 'Starting…');
    writeLocal('$ speedtest --format=human-readable --progress=yes' + (acceptTerms ? ' --accept-license --accept-gdpr' : '') + '   (' + transport + ')\r\n');

    var mySub = window.Luna.call(SERVICE + '/start', { subscribe: true, pty: transport === 'pty', acceptTerms: acceptTerms }, function (r) {
      if (sub !== mySub) return; // stale subscription
      onResponse(r);
    });
    sub = mySub;
  }

  function onResponse(r) {
    if (r.returnValue === false) {
      var code = r.errorCode || 'ERROR';
      finish(code === 'BUSY' ? 'running' : 'failed');
      if (code === 'BUSY') {
        // Another subscriber owns the run (e.g. a previous app instance). Allow cancelling it.
        setState('running', 'Busy');
        ui.start.disabled = false;
      }
      showError({ code: code, message: r.errorText || ('Service error ' + code), hint: r.hint ||
        (code === 'NO_LUNA' ? 'Open the app on the TV.' : /Unknown method|not found|Service does not exist/i.test(r.errorText || '') ? 'The service is not installed or not running. Reinstall the .ipk.' : '') });
      return;
    }
    switch (r.event) {
      case 'accepted':
        runId = r.runId;
        uid = r.uid;
        ui.svcMode.hidden = false;
        ui.svcMode.textContent = uid === 0 ? 'service: root' : 'service: jailed' + (uid !== null && uid !== undefined ? ' (uid ' + uid + ')' : '');
        break;
      case 'version':
        ui.version.textContent = r.text;
        break;
      case 'started':
        setState('running');
        break;
      case 'output':
        for (var i = 0; i < r.chunks.length; i++) parsers[r.chunks[i].s === 'err' ? 'err' : 'out'].feed(r.chunks[i].d);
        updateLive();
        scheduleRender();
        break;
      case 'stopping':
        setState('stopping', r.reason === 'timeout' ? 'Timed out' : r.reason === 'stalled' ? 'Stalled' : 'Stopping…');
        break;
      case 'exit':
        onExit(r);
        break;
    }
  }

  function onExit(r) {
    var secs = (r.durationMs / 1000).toFixed(1);
    var how = r.ran === false ? 'did not start' : r.signal ? 'stopped by ' + r.signal : 'exited with code ' + r.code;
    if (screen.col > 0) parsers.out.feed('\r\n');
    writeLocal('[speedtest ' + how + ' after ' + secs + ' s]\r\n');
    ui.live.hidden = true;
    if (r.error) {
      finish(r.reason === 'cancelled' ? 'cancelled' : 'failed');
      showError(r.error);
    } else if (r.reason === 'cancelled' || r.reason === 'client-gone') {
      finish('cancelled');
    } else {
      finish('done');
      lastSummary = Results.parseSummary(screen.text());
      if (lastSummary.complete) {
        ui.resultsBtn.hidden = false;
        setTimeout(function () { if (state === 'done' && lastSummary) openResults(); }, 1500);
      }
    }
  }

  function finish(s) {
    if (sub) { sub.cancel(); sub = null; }
    setState(s);
  }

  /* ---------------- CLI download ---------------- */

  function fmtBytes(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB'; }

  function downloadCli() {
    if (state === 'running' || state === 'stopping') return;
    clearError();
    ui.live.hidden = false;
    ui.live.classList.remove('upload');
    ui.livePhase.textContent = 'Get CLI';
    ui.liveValue.textContent = 'connecting…';
    ui.liveBar.style.width = '0';
    ui.livePct.textContent = '';
    setState('running', 'Downloading…');
    var mySub = window.Luna.call(SERVICE + '/install', { subscribe: true }, function (r) {
      if (sub !== mySub) return;
      if (r.returnValue === false) {
        ui.live.hidden = true;
        finish('failed');
        showError({ code: r.errorCode, message: r.errorText || 'Download failed', hint: r.hint });
        return;
      }
      if (r.event === 'install-started') {
        writeLocal('Downloading ' + r.url + '\r\n  -> ' + r.target + '\r\n');
      } else if (r.event === 'download') {
        var pct = r.total ? Math.round(r.received / r.total * 100) : null;
        ui.liveValue.textContent = fmtBytes(r.received) + (r.total ? ' / ' + fmtBytes(r.total) : '');
        ui.liveBar.style.width = (pct || 0) + '%';
        ui.livePct.textContent = pct === null ? '' : pct + '%';
      } else if (r.event === 'verifying') {
        ui.liveValue.textContent = 'checking SHA-256…';
        writeLocal('Verifying checksum and unpacking…\r\n');
      } else if (r.event === 'install-done') {
        ui.live.hidden = true;
        if (r.ok) {
          writeLocal('Installed: ' + r.version + '\r\nPress Start test.\r\n');
          ui.version.textContent = r.version;
          finish('idle');
          focusEl(ui.start);
        } else {
          writeLocal('Download failed.\r\n');
          finish(r.error && r.error.code === 'CANCELLED' ? 'cancelled' : 'failed');
          if (!(r.error && r.error.code === 'CANCELLED')) showError(r.error);
        }
      }
    });
    sub = mySub;
  }

  /* ---------------- licence / privacy terms ---------------- */

  function openTerms() {
    ui.terms.hidden = false;
    ui.error.hidden = true;
    focusEl(ui.decline); // accepting must be a deliberate choice
  }

  function closeTerms(silent) {
    if (ui.terms.hidden) return;
    ui.terms.hidden = true;
    if (!silent) { ui.error.hidden = false; focusEl(ui.termsBtn); }
  }

  function cancelTest() {
    if (state !== 'running' && state !== 'stopping') return;
    setState('stopping');
    window.Luna.call(SERVICE + '/cancel', {}, function (r) {
      if (r.returnValue === false) { showError({ message: 'Cancel failed: ' + (r.errorText || 'unknown error') }); return; }
      if (!sub) setState(r.cancelled ? 'cancelled' : 'idle'); // run owned by an older subscriber
    });
  }

  function elevate() {
    ui.elevate.disabled = true;
    writeLocal('Asking Homebrew Channel to elevate ' + SERVICE_ID + '…\r\n');
    window.Luna.call(HBCHANNEL + '/elevateService', { id: SERVICE_ID }, function (r) {
      if (r.returnValue === false) {
        ui.elevate.disabled = false;
        showError({ message: 'Elevation failed: ' + (r.errorText || 'unknown error'), hint: 'Homebrew Channel must run as root. Over SSH run:\n  /media/developer/apps/usr/palm/services/org.webosbrew.hbchannel.service/elevate-service ' + SERVICE_ID });
        return;
      }
      // Restart the jailed instance so the next call runs elevated. "[.]" keeps
      // pkill from matching the shell that runs this very command.
      window.Luna.call(HBCHANNEL + '/exec', { command: '/usr/sbin/ls-control scan-services >/dev/null 2>&1; pkill -f "io[.]github[.]danzig666[.]speedtest[.]service" ; true' }, function () {
        ui.elevate.disabled = false;
        clearError();
        uid = null;
        writeLocal('Service elevated. Press Start again.\r\n');
        focusEl(ui.start);
      });
    });
  }

  /* ---------------- results screen ---------------- */

  function text(id, v) { $(id).textContent = v; }
  function lat(l) { return l ? l.latency.toFixed(2) + ' ms (jitter ' + l.jitter.toFixed(2) + ', high ' + l.high.toFixed(1) + ')' : 'n/a'; }

  function openResults() {
    var r = lastSummary;
    if (!r) return;
    text('resWhere', [r.server, r.isp].filter(Boolean).join('  ·  '));
    text('resDl', fmtMbps(r.download.mbps));
    text('resUl', fmtMbps(r.upload.mbps));
    text('resDlSub', 'data used ' + r.download.dataUsed + (r.download.unit !== 'Mbps' ? '  ·  ' + r.download.value + ' ' + r.download.unit : ''));
    text('resUlSub', 'data used ' + r.upload.dataUsed + (r.upload.unit !== 'Mbps' ? '  ·  ' + r.upload.value + ' ' + r.upload.unit : ''));
    text('resPing', r.idle ? r.idle.latency.toFixed(r.idle.latency < 10 ? 2 : 1) : '–');
    text('resPingSub', r.idle ? 'jitter ' + r.idle.jitter.toFixed(2) + ' ms  ·  ' + r.idle.low.toFixed(1) + '–' + r.idle.high.toFixed(1) + ' ms' : '');
    text('resLoss', r.packetLossText || '–');
    text('resLoaded', 'download ' + lat(r.download.latency) + '  ·  upload ' + lat(r.upload.latency));
    text('resUrl', r.resultUrl || 'not reported');
    ui.main.hidden = true;
    ui.results.hidden = false; // visible first: the charts size themselves to their boxes
    var css = getComputedStyle(document.documentElement);
    Charts.draw($('chartDl'), samples.download, { color: css.getPropertyValue('--series-dl').trim(), label: 'Download throughput', final: r.download.mbps });
    Charts.draw($('chartUl'), samples.upload, { color: css.getPropertyValue('--series-ul').trim(), label: 'Upload throughput', final: r.upload.mbps });
    focusEl(ui.again);
  }

  function closeResults(silent) {
    if (ui.results.hidden) return;
    ui.results.hidden = true;
    ui.main.hidden = false;
    if (!silent) focusEl(ui.resultsBtn.hidden ? ui.start : ui.resultsBtn);
    scheduleRender();
  }

  /* ---------------- remote control navigation ---------------- */

  function focusables() {
    var scope = !ui.results.hidden ? ui.results : !ui.terms.hidden ? ui.terms : ui.main;
    return Array.prototype.filter.call(scope.querySelectorAll('.focusable'), function (e) {
      return !e.disabled && !e.hidden && e.offsetParent !== null;
    });
  }

  function focusEl(e) { if (e && !e.disabled && !e.hidden) e.focus(); }

  function moveFocus(dir) {
    var cur = document.activeElement;
    var list = focusables();
    if (list.indexOf(cur) === -1) { focusEl(list[0]); return; }
    var a = cur.getBoundingClientRect();
    var ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    var best = null, bestScore = Infinity;
    list.forEach(function (e) {
      if (e === cur) return;
      var b = e.getBoundingClientRect();
      var bx = b.left + b.width / 2, by = b.top + b.height / 2;
      var dx = bx - ax, dy = by - ay;
      var primary = dir === 'left' ? -dx : dir === 'right' ? dx : dir === 'up' ? -dy : dy;
      if (primary <= 4) return;
      var horizontal = dir === 'left' || dir === 'right';
      var ortho = horizontal ? Math.abs(dy) : Math.abs(dx);
      // Left/right never leaves the current row; up/down prefers overlap.
      var overlap = horizontal ? (b.top < a.bottom && b.bottom > a.top) : (b.left < a.right && b.right > a.left);
      if (horizontal && !overlap) return;
      var score = primary + ortho * (overlap ? 1 : 4);
      if (score < bestScore) { bestScore = score; best = e; }
    });
    if (best) focusEl(best);
  }

  function scrollConsole(lines) {
    var lh = parseFloat(getComputedStyle(ui.console).lineHeight) || 37;
    ui.console.scrollTop += lines * lh;
  }

  function back() {
    if (!ui.results.hidden) { closeResults(); return; }
    if (!ui.terms.hidden) { closeTerms(); return; }
    if (state === 'running' || state === 'stopping') { cancelTest(); return; }
    if (!ui.error.hidden) { clearError(); return; }
    // Top level: leave the app (this also cancels any subscription).
    window.close();
  }

  document.addEventListener('keydown', function (ev) {
    var k = ev.keyCode;
    var inConsole = document.activeElement === ui.console;
    if (k === KEY.BACK || k === KEY.ESC || (k === KEY.BACKSPACE && !/INPUT|TEXTAREA/.test(document.activeElement.tagName))) {
      ev.preventDefault(); back(); return;
    }
    if (k === KEY.PGUP || k === KEY.PGDN) { ev.preventDefault(); scrollConsole((k === KEY.PGUP ? -1 : 1) * 10); return; }
    if (inConsole && (k === KEY.UP || k === KEY.DOWN)) {
      ev.preventDefault();
      var c = ui.console;
      if (k === KEY.DOWN && c.scrollTop + c.clientHeight >= c.scrollHeight - 4) { moveFocus('down'); return; }
      scrollConsole(k === KEY.UP ? -3 : 3);
      return;
    }
    var dir = { 37: 'left', 38: 'up', 39: 'right', 40: 'down' }[k];
    if (dir) { ev.preventDefault(); moveFocus(dir); }
  });

  // Magic Remote pointer: hovering focuses, like the rest of webOS.
  document.addEventListener('mouseover', function (ev) {
    var t = ev.target.closest ? ev.target.closest('.focusable') : null;
    if (t && !t.disabled && t !== document.activeElement) t.focus({ preventScroll: true });
  });

  ui.start.addEventListener('click', function () { startTest(false); });
  ui.download.addEventListener('click', downloadCli);
  ui.termsBtn.addEventListener('click', openTerms);
  ui.accept.addEventListener('click', function () { startTest(true); });
  ui.decline.addEventListener('click', function () { closeTerms(); });
  ui.cancel.addEventListener('click', cancelTest);
  ui.resultsBtn.addEventListener('click', openResults);
  ui.again.addEventListener('click', function () { startTest(false); });
  ui.consoleBtn.addEventListener('click', function () { closeResults(); });
  ui.elevate.addEventListener('click', elevate);
  ui.mode.addEventListener('click', function () { setMode(transport === 'pipe' ? 'pty' : 'pipe'); });

  // App closing: stop the process. The service also kills it when the
  // subscription drops, so this is belt and braces.
  function teardown() {
    if (sub) {
      try { window.Luna.call(SERVICE + '/cancel', {}, function () {}); } catch (e) { /* ignore */ }
      sub.cancel();
      sub = null;
    }
  }
  window.addEventListener('pagehide', teardown);
  window.addEventListener('beforeunload', teardown);

  setMode(transport);
  setState('idle');
  writeLocal('Press Start test to run the Ookla Speedtest CLI.\r\n' +
    (window.Luna.available() ? '' : 'Note: Luna bus not available — this page must run on the TV.\r\n'));
  focusEl(ui.start);

  window.SpeedtestApp = { screen: screen, state: function () { return state; }, samples: function () { return samples; } };
})();
