/*
 * Minimal streaming terminal for the console panel.
 *
 * - Screen: scrollback buffer of styled cells with a cursor; supports
 *   CR, LF, BS, TAB, cursor movement, erase-in-line/display, SGR colours.
 * - AnsiParser: incremental escape-sequence state machine. State survives
 *   between feed() calls, so a control sequence (or UTF-16 surrogate pair)
 *   split across chunks is handled. One parser per stream (stdout/stderr)
 *   so interleaved chunks can never corrupt each other's sequences.
 *
 * Works in the browser (window.Term) and in Node (module.exports) for tests.
 */
(function (root) {
  'use strict';

  var DEFAULT_STYLE = Object.freeze({});

  function Line() {
    this.chars = [];
    this.styles = [];
  }

  function Screen(opts) {
    opts = opts || {};
    this.cols = opts.cols || 100;
    this.rows = opts.rows || 30;
    this.maxLines = opts.maxLines || 3000;
    this.reset();
  }

  Screen.prototype.reset = function () {
    this.lines = [new Line()];
    this.row = 0;
    this.col = 0;
    this.saved = { row: 0, col: 0 };
    this.dirty = {};
    this.trimmed = 0; // lines dropped from the top (for incremental renderers)
    this.version = (this.version || 0) + 1;
    this.structural = true;
  };

  Screen.prototype._touch = function (r) {
    this.dirty[r] = true;
    this.version++;
  };

  Screen.prototype._ensureRow = function (r) {
    while (this.lines.length <= r) {
      this.lines.push(new Line());
      this.structural = true;
    }
  };

  Screen.prototype.viewTop = function () {
    return Math.max(0, this.lines.length - this.rows);
  };

  Screen.prototype.put = function (ch, style) {
    if (this.col >= this.cols) {
      this.newline();
    }
    this._ensureRow(this.row);
    var line = this.lines[this.row];
    while (line.chars.length < this.col) {
      line.chars.push(' ');
      line.styles.push(DEFAULT_STYLE);
    }
    line.chars[this.col] = ch;
    line.styles[this.col] = style || DEFAULT_STYLE;
    this.col++;
    this._touch(this.row);
  };

  Screen.prototype.cr = function () { this.col = 0; };

  Screen.prototype.lf = function () {
    this.row++;
    this._ensureRow(this.row);
    this._trim();
  };

  Screen.prototype.newline = function () { this.cr(); this.lf(); };

  Screen.prototype.bs = function () { if (this.col > 0) this.col--; };

  Screen.prototype.tab = function () {
    var next = Math.min(this.cols - 1, (Math.floor(this.col / 8) + 1) * 8);
    while (this.col < next) this.put(' ', DEFAULT_STYLE);
  };

  Screen.prototype._trim = function () {
    var extra = this.lines.length - this.maxLines;
    if (extra > 0) {
      this.lines.splice(0, extra);
      this.row = Math.max(0, this.row - extra);
      this.trimmed += extra;
      this.dirty = {};
      this.structural = true;
      this.version++;
    }
  };

  Screen.prototype.moveTo = function (row, col) {
    this.row = Math.max(0, row);
    this.col = Math.max(0, Math.min(this.cols - 1, col));
    this._ensureRow(this.row);
  };

  Screen.prototype.eraseInLine = function (mode) {
    this._ensureRow(this.row);
    var line = this.lines[this.row];
    if (mode === 0) {
      line.chars.length = Math.min(line.chars.length, this.col);
      line.styles.length = line.chars.length;
    } else if (mode === 1) {
      for (var i = 0; i <= this.col && i < line.chars.length; i++) { line.chars[i] = ' '; line.styles[i] = DEFAULT_STYLE; }
    } else {
      line.chars = []; line.styles = [];
    }
    this._touch(this.row);
  };

  Screen.prototype.eraseInDisplay = function (mode) {
    var top = this.viewTop();
    var r;
    if (mode === 2 || mode === 3) {
      for (r = top; r < this.lines.length; r++) { this.lines[r] = new Line(); this._touch(r); }
      return;
    }
    this.eraseInLine(mode);
    if (mode === 0) {
      for (r = this.row + 1; r < this.lines.length; r++) { this.lines[r] = new Line(); this._touch(r); }
    } else if (mode === 1) {
      for (r = top; r < this.row; r++) { this.lines[r] = new Line(); this._touch(r); }
    }
  };

  Screen.prototype.lineText = function (r) {
    var l = this.lines[r];
    return l ? l.chars.join('').replace(/\s+$/, '') : '';
  };

  Screen.prototype.currentLineText = function () { return this.lineText(this.row); };

  Screen.prototype.text = function () {
    var out = [];
    for (var r = 0; r < this.lines.length; r++) out.push(this.lineText(r));
    while (out.length && out[out.length - 1] === '') out.pop();
    return out.join('\n');
  };

  Screen.prototype.takeDirty = function () {
    var d = this.dirty;
    var s = this.structural;
    this.dirty = {};
    this.structural = false;
    return { rows: Object.keys(d).map(Number), structural: s };
  };

  /* ------------------------------------------------------------------ */

  var COLOR_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

  function AnsiParser(screen, baseStyle) {
    this.screen = screen;
    this.base = Object.freeze(baseStyle || {});
    this.style = this.base;
    this.state = 0; // 0 ground, 1 ESC, 2 CSI, 3 OSC, 4 OSC-ESC, 5 ESC-intermediate
    this.params = '';
    this.inter = '';
    this.pendingHigh = ''; // dangling UTF-16 high surrogate
  }

  AnsiParser.prototype.reset = function () {
    this.style = this.base;
    this.state = 0;
    this.params = '';
    this.inter = '';
    this.pendingHigh = '';
  };

  AnsiParser.prototype.feed = function (str) {
    var s = this.screen;
    if (this.pendingHigh) { str = this.pendingHigh + str; this.pendingHigh = ''; }
    for (var i = 0; i < str.length; i++) {
      var c = str.charAt(i);
      var code = str.charCodeAt(i);
      switch (this.state) {
        case 0:
          if (code === 0x1b) { this.state = 1; }
          else if (code === 0x0d) { s.cr(); }
          else if (code === 0x0a || code === 0x0b || code === 0x0c) { s.newline(); }
          else if (code === 0x08) { s.bs(); }
          else if (code === 0x09) { s.tab(); }
          else if (code < 0x20 || code === 0x7f) { /* BEL and other C0: ignore */ }
          else if (code >= 0xd800 && code <= 0xdbff) {
            if (i + 1 < str.length) { s.put(c + str.charAt(i + 1), this.style); i++; }
            else { this.pendingHigh = c; }
          }
          else if (code >= 0x80 && code < 0xa0) { /* C1: ignore */ }
          else { s.put(c, this.style); }
          break;
        case 1: // after ESC
          if (c === '[') { this.state = 2; this.params = ''; this.inter = ''; }
          else if (c === ']') { this.state = 3; }
          else if (code >= 0x20 && code <= 0x2f) { this.state = 5; }
          else {
            this.state = 0;
            if (c === '7') s.saved = { row: s.row, col: s.col };
            else if (c === '8') s.moveTo(s.saved.row, s.saved.col);
            else if (c === 'c') { s.reset(); this.style = this.base; }
            else if (c === 'D') s.lf();
            else if (c === 'E') s.newline();
            else if (c === 'M') s.moveTo(s.row - 1, s.col);
            else if (code === 0x1b) this.state = 1;
          }
          break;
        case 2: // CSI
          if (code >= 0x30 && code <= 0x3f) {
            if (this.params.length < 64) this.params += c;
          } else if (code >= 0x20 && code <= 0x2f) {
            this.inter += c;
          } else if (code >= 0x40 && code <= 0x7e) {
            this.state = 0;
            this._csi(c);
          } else if (code === 0x1b) {
            this.state = 1;
          } else if (code === 0x18 || code === 0x1a) {
            this.state = 0;
          } else if (code === 0x0d) { s.cr(); }
          else if (code === 0x0a) { s.newline(); }
          break;
        case 3: // OSC ... BEL | ESC \
          if (code === 0x07) this.state = 0;
          else if (code === 0x1b) this.state = 4;
          break;
        case 4:
          this.state = c === '\\' ? 0 : 3;
          break;
        case 5: // ESC ( B and friends: swallow final byte
          if (code >= 0x30 && code <= 0x7e) this.state = 0;
          break;
      }
    }
  };

  AnsiParser.prototype._csi = function (final) {
    var s = this.screen;
    var priv = this.params.charAt(0) === '?' || this.params.charAt(0) === '>' || this.params.charAt(0) === '=';
    var raw = priv ? this.params.slice(1) : this.params;
    var p = raw === '' ? [] : raw.split(/[;:]/).map(function (x) { return x === '' ? 0 : parseInt(x, 10) || 0; });
    var n = p[0] || 1;
    if (priv || this.inter) return; // cursor visibility, modes: no visual effect here
    switch (final) {
      case 'A': s.moveTo(s.row - n, s.col); break;
      case 'B': s.moveTo(s.row + n, s.col); break;
      case 'C': s.col = Math.min(s.cols - 1, s.col + n); break;
      case 'D': s.col = Math.max(0, s.col - n); break;
      case 'E': s.moveTo(s.row + n, 0); break;
      case 'F': s.moveTo(s.row - n, 0); break;
      case 'G': case '`': s.col = Math.max(0, Math.min(s.cols - 1, n - 1)); break;
      case 'H': case 'f': s.moveTo(s.viewTop() + (p[0] || 1) - 1, (p[1] || 1) - 1); break;
      case 'd': s.moveTo(s.viewTop() + n - 1, s.col); break;
      case 'J': s.eraseInDisplay(p[0] || 0); break;
      case 'K': s.eraseInLine(p[0] || 0); break;
      case 'X': for (var k = 0, c0 = s.col; k < n; k++) s.put(' ', this.base); s.col = c0; break;
      case 's': s.saved = { row: s.row, col: s.col }; break;
      case 'u': s.moveTo(s.saved.row, s.saved.col); break;
      case 'm': this._sgr(p.length ? p : [0]); break;
      default: break; // unsupported: ignore silently
    }
  };

  AnsiParser.prototype._sgr = function (p) {
    var st = {};
    var k;
    for (k in this.style) st[k] = this.style[k];
    for (var i = 0; i < p.length; i++) {
      var v = p[i];
      if (v === 0) { st = {}; for (k in this.base) st[k] = this.base[k]; }
      else if (v === 1) st.bold = true;
      else if (v === 2) st.dim = true;
      else if (v === 3) st.italic = true;
      else if (v === 4) st.underline = true;
      else if (v === 7) st.inverse = true;
      else if (v === 22) { st.bold = false; st.dim = false; }
      else if (v === 23) st.italic = false;
      else if (v === 24) st.underline = false;
      else if (v === 27) st.inverse = false;
      else if (v >= 30 && v <= 37) st.fg = COLOR_NAMES[v - 30];
      else if (v === 39) delete st.fg;
      else if (v >= 40 && v <= 47) st.bg = COLOR_NAMES[v - 40];
      else if (v === 49) delete st.bg;
      else if (v >= 90 && v <= 97) st.fg = 'bright-' + COLOR_NAMES[v - 90];
      else if (v >= 100 && v <= 107) st.bg = 'bright-' + COLOR_NAMES[v - 100];
      else if (v === 38 || v === 48) {
        var key = v === 38 ? 'fg' : 'bg';
        if (p[i + 1] === 5) { st[key] = xterm256(p[i + 2] || 0); i += 2; }
        else if (p[i + 1] === 2) { st[key] = 'rgb(' + (p[i + 2] || 0) + ',' + (p[i + 3] || 0) + ',' + (p[i + 4] || 0) + ')'; i += 4; }
      }
    }
    this.style = Object.freeze(st);
  };

  function xterm256(n) {
    if (n < 8) return COLOR_NAMES[n];
    if (n < 16) return 'bright-' + COLOR_NAMES[n - 8];
    if (n >= 232) { var g = 8 + (n - 232) * 10; return 'rgb(' + g + ',' + g + ',' + g + ')'; }
    n -= 16;
    var lv = [0, 95, 135, 175, 215, 255];
    return 'rgb(' + lv[Math.floor(n / 36)] + ',' + lv[Math.floor(n / 6) % 6] + ',' + lv[n % 6] + ')';
  }

  /* ------------------------------------------------------------------ */
  /* DOM renderer (browser only)                                         */

  function styleKey(st) {
    return (st.fg || '') + '|' + (st.bg || '') + '|' + (st.bold ? 1 : 0) + (st.dim ? 1 : 0) + (st.italic ? 1 : 0) +
      (st.underline ? 1 : 0) + (st.inverse ? 1 : 0) + (st.stream || '');
  }

  function applyStyle(span, st) {
    var cls = [];
    var fg = st.fg, bg = st.bg;
    if (st.inverse) { var t = fg || 'default-fg'; fg = bg || 'default-bg'; bg = t; }
    if (fg) { if (fg.indexOf('rgb') === 0) span.style.color = fg; else cls.push('fg-' + fg); }
    if (bg) { if (bg.indexOf('rgb') === 0) span.style.backgroundColor = bg; else cls.push('bg-' + bg); }
    if (st.bold) cls.push('b');
    if (st.dim) cls.push('dim');
    if (st.italic) cls.push('i');
    if (st.underline) cls.push('u');
    if (st.stream === 'err') cls.push('stderr');
    if (cls.length) span.className = cls.join(' ');
  }

  function renderLine(el, line, cursorCol) {
    while (el.firstChild) el.removeChild(el.firstChild);
    var chars = line ? line.chars : [];
    var styles = line ? line.styles : [];
    var doc = el.ownerDocument;
    var i = 0;
    while (i < chars.length) {
      var st = styles[i];
      var key = styleKey(st);
      var j = i + 1;
      while (j < chars.length && styleKey(styles[j]) === key) j++;
      var text = chars.slice(i, j).join('');
      if (key === '||00000') el.appendChild(doc.createTextNode(text));
      else {
        var span = doc.createElement('span');
        applyStyle(span, st);
        span.textContent = text;
        el.appendChild(span);
      }
      i = j;
    }
    if (cursorCol >= 0) {
      var cur = doc.createElement('span');
      cur.className = 'cursor';
      cur.textContent = ' ';
      // pad so the cursor sits at its real column
      var pad = cursorCol - chars.length;
      if (pad > 0) el.appendChild(doc.createTextNode(new Array(pad + 1).join(' ')));
      if (pad >= 0) el.appendChild(cur);
    }
    if (!el.firstChild) el.appendChild(doc.createTextNode('​'));
  }

  /** Mirrors a Screen into a container element, one <div> per line. */
  function DomView(container, screen) {
    this.el = container;
    this.screen = screen;
    this.nodes = [];
    this.showCursor = false;
    this._cursorRow = -1;
  }

  DomView.prototype.render = function () {
    var s = this.screen;
    var d = s.takeDirty();
    var doc = this.el.ownerDocument;
    if (d.structural) {
      // sync node count (lines are only appended or trimmed from the top)
      while (this.nodes.length > s.lines.length) { this.el.removeChild(this.nodes.shift()); }
      while (this.nodes.length < s.lines.length) {
        var div = doc.createElement('div');
        div.className = 'ln';
        this.el.appendChild(div);
        this.nodes.push(div);
        d.rows.push(this.nodes.length - 1);
      }
      if (s.trimmed !== this._trimmed) { this._trimmed = s.trimmed; d.rows = s.lines.map(function (_, idx) { return idx; }); }
    }
    if (this._cursorRow !== s.row && this._cursorRow >= 0) d.rows.push(this._cursorRow);
    d.rows.push(s.row);
    var seen = {};
    for (var k = 0; k < d.rows.length; k++) {
      var r = d.rows[k];
      if (seen[r] || r >= this.nodes.length) continue;
      seen[r] = true;
      renderLine(this.nodes[r], s.lines[r], this.showCursor && r === s.row ? s.col : -1);
    }
    this._cursorRow = s.row;
  };

  DomView.prototype.clear = function () {
    while (this.el.firstChild) this.el.removeChild(this.el.firstChild);
    this.nodes = [];
    this._cursorRow = -1;
    this._trimmed = 0;
  };

  var api = { Screen: Screen, AnsiParser: AnsiParser, DomView: DomView };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Term = api;
})(this);
