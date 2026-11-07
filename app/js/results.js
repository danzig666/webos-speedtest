/*
 * Parses the human-readable output of Ookla Speedtest CLI 1.2.x.
 * Line formats taken from the official binary's format strings, e.g.
 *   "%12s: %13s (data used: %s%s) %50s"   and  " Packet Loss: %s%6.1f%%".
 * Works on the plain text of the terminal screen (after CR redraws).
 */
(function (root) {
  'use strict';

  var NUM = '(\\d+(?:\\.\\d+)?)';

  // Units accepted by `speedtest -u`: bps kbps Mbps Gbps, kibps Mibps Gibps,
  // B/s kB/s MB/s GB/s, kiB/s MiB/s GiB/s (case of k varies).
  function toMbps(value, unit) {
    var m = /^([kKMG]?)(i?)(bps|B\/s)$/.exec(String(unit || 'Mbps'));
    if (!m) return value;
    var power = { '': 0, k: 1, K: 1, M: 2, G: 3 }[m[1]];
    var bits = value * Math.pow(m[2] ? 1024 : 1000, power) * (m[3] === 'B/s' ? 8 : 1);
    return bits / 1e6;
  }

  function latencyBlock(str) {
    var m = new RegExp(NUM + ' ms\\s+\\(jitter: ' + NUM + ' ?ms, low: ' + NUM + ' ?ms, high: ' + NUM + ' ?ms\\)').exec(str);
    if (!m) return null;
    return { latency: +m[1], jitter: +m[2], low: +m[3], high: +m[4] };
  }

  function parseSummary(text) {
    var lines = String(text).split(/\r?\n/);
    var r = { server: null, serverId: null, isp: null, idle: null, download: null, upload: null, packetLoss: null, packetLossText: null, resultUrl: null };
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var m;
      if ((m = /^\s*Server:\s+(.*?)(?:\s+\(id:\s*(\d+)\))?\s*$/.exec(line))) {
        r.server = m[1]; r.serverId = m[2] || null;
      } else if ((m = /^\s*ISP:\s+(.*\S)\s*$/.exec(line))) {
        r.isp = m[1];
      } else if (/^\s*Idle Latency:/.test(line)) {
        r.idle = latencyBlock(line);
      } else if ((m = new RegExp('^\\s*(Download|Upload):\\s+' + NUM + ' (\\S+)\\s+\\(data used: ([^)]*)\\)').exec(line))) {
        var phase = { value: +m[2], unit: m[3], mbps: toMbps(+m[2], m[3]), dataUsed: m[4].trim(), latency: null };
        var next = lines[i + 1] || '';
        if (/^\s+\d/.test(next)) { phase.latency = latencyBlock(next); }
        r[m[1].toLowerCase()] = phase;
      } else if ((m = /^\s*(Download|Upload):\s+FAILED/.exec(line))) {
        r[m[1].toLowerCase()] = { failed: true };
      } else if ((m = /^\s*Packet Loss:\s+(?:(\d+(?:\.\d+)?)%|(.*\S))/.exec(line))) {
        if (m[1] !== undefined) r.packetLoss = +m[1];
        r.packetLossText = m[1] !== undefined ? m[1] + '%' : m[2];
      } else if ((m = /Result URL:\s+(https?:\/\/\S+)/.exec(line))) {
        r.resultUrl = m[1];
      }
    }
    r.complete = !!(r.download && r.upload && !r.download.failed && !r.upload.failed);
    return r;
  }

  /** Live progress from the line currently being redrawn. */
  function parseProgress(line) {
    var m = new RegExp('^\\s*(Download|Upload):\\s+' + NUM + ' (\\S+)').exec(line);
    if (m && !/data used/.test(line)) {
      var pct = /(\d{1,3})%/.exec(line.slice(m[0].length));
      var lat = /latency:\s+(\d+(?:\.\d+)?) ms/.exec(line);
      return { phase: m[1].toLowerCase(), value: +m[2], unit: m[3], mbps: toMbps(+m[2], m[3]), percent: pct ? Math.min(100, +pct[1]) : null, latency: lat ? +lat[1] : null };
    }
    if (/^\s*Idle Latency:/.test(line) && !/jitter/.test(line)) return { phase: 'latency' };
    if (/^\s*Selecting server/.test(line)) return { phase: 'server' };
    return null;
  }

  var api = { parseSummary: parseSummary, parseProgress: parseProgress, toMbps: toMbps };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Results = api;
})(this);
