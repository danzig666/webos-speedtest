/*
 * Throughput-over-time line chart (inline SVG, no library).
 * One series per chart (download and upload are separate small multiples
 * sharing nothing but the visual language), 3px line with a light area,
 * recessive grid, a direct end label, and a crosshair tooltip for the
 * Magic Remote pointer.
 */
(function (root) {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';

  function el(name, attrs, parent) {
    var e = document.createElementNS(NS, name);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function niceMax(v) {
    if (v <= 0) return 1;
    var p = Math.pow(10, Math.floor(Math.log10(v)));
    var steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
    for (var i = 0; i < steps.length; i++) if (steps[i] * p >= v * 1.05) return steps[i] * p;
    return 10 * p;
  }

  function fmt(v) { return v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2); }

  /**
   * draw(svg, samples:[{t:seconds, v:Mbps}], {color, label, final})
   */
  function draw(svg, samples, opts) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    // Match the viewBox to the rendered size so text is never stretched.
    var W = Math.round(svg.clientWidth) || 860, H = Math.round(svg.clientHeight) || 260;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    var L = 70, R = 120, T = 16, B = 40;
    var pw = W - L - R, ph = H - T - B;
    svg.setAttribute('aria-label', opts.label + ': ' + (samples.length ? samples.length + ' samples, final ' + fmt(opts.final || samples[samples.length - 1].v) + ' Mbps' : 'no data'));

    if (samples.length < 2) {
      el('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', 'class': 'empty' }, svg).textContent = 'No progress samples captured';
      return;
    }
    var tMax = Math.max(0.001, samples[samples.length - 1].t);
    var vMax = niceMax(Math.max.apply(null, samples.map(function (s) { return s.v; }).concat([opts.final || 0])));
    var x = function (t) { return L + (t / tMax) * pw; };
    var y = function (v) { return T + ph - (v / vMax) * ph; };

    for (var i = 0; i <= 4; i++) {
      var gv = vMax * i / 4;
      el('line', { x1: L, x2: L + pw, y1: y(gv), y2: y(gv), 'class': 'grid' }, svg);
      el('text', { x: L - 12, y: y(gv) + 6, 'text-anchor': 'end', 'class': 'axis' }, svg).textContent = fmt(gv);
    }
    var ticks = 4;
    for (var j = 0; j <= ticks; j++) {
      var tv = tMax * j / ticks;
      el('text', { x: x(tv), y: H - 10, 'text-anchor': 'middle', 'class': 'axis' }, svg).textContent = tv.toFixed(tMax < 5 ? 1 : 0) + ' s';
    }

    var d = samples.map(function (s, k) { return (k ? 'L' : 'M') + x(s.t).toFixed(1) + ' ' + y(s.v).toFixed(1); }).join(' ');
    el('path', { d: d + ' L' + x(tMax) + ' ' + y(0) + ' L' + x(samples[0].t) + ' ' + y(0) + ' Z', fill: opts.color, 'class': 'area' }, svg);
    el('path', { d: d, stroke: opts.color, 'class': 'line' }, svg);

    var last = samples[samples.length - 1];
    var finalV = opts.final || last.v;
    el('text', { x: x(last.t) + 12, y: y(last.v) + 7, 'class': 'endlabel' }, svg).textContent = fmt(finalV) + ' Mbps';

    // hover layer: crosshair + tooltip
    var cross = el('line', { x1: 0, x2: 0, y1: T, y2: T + ph, 'class': 'cross', visibility: 'hidden' }, svg);
    var dot = el('circle', { r: 7, fill: opts.color, 'class': 'dot', visibility: 'hidden' }, svg);
    var hit = el('rect', { x: L, y: 0, width: pw, height: H, fill: 'transparent' }, svg);
    var tip = svg.parentNode.querySelector('.tooltip') || svg.parentNode.appendChild(document.createElement('div'));
    tip.className = 'tooltip';
    tip.hidden = true;
    hit.addEventListener('mousemove', function (ev) {
      var box = svg.getBoundingClientRect();
      var sx = (ev.clientX - box.left) * (W / box.width);
      var tt = (sx - L) / pw * tMax;
      var best = samples[0];
      samples.forEach(function (s) { if (Math.abs(s.t - tt) < Math.abs(best.t - tt)) best = s; });
      var px = x(best.t), py = y(best.v);
      cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', px); dot.setAttribute('cy', py); dot.setAttribute('visibility', 'visible');
      var fig = svg.parentNode.getBoundingClientRect();
      tip.style.left = (box.left - fig.left + px * box.width / W) + 'px';
      tip.style.top = (box.top - fig.top + py * box.height / H) + 'px';
      tip.textContent = best.t.toFixed(1) + ' s · ' + fmt(best.v) + ' Mbps';
      tip.hidden = false;
    });
    hit.addEventListener('mouseleave', function () {
      cross.setAttribute('visibility', 'hidden');
      dot.setAttribute('visibility', 'hidden');
      tip.hidden = true;
    });
  }

  root.Charts = { draw: draw };
})(this);
