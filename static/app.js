/* PadKeys — iPad side. Captures typing and sends it to the laptop over a WebSocket. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const SENTINEL = '\u200B'; // invisible char so Backspace works even when the box is "empty"
  const MODS = ['ctrl', 'alt', 'shift', 'meta'];
  const MOD_LABEL = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Super' };
  const SPECIAL_KEYS = new Set([
    'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End',
    'PageUp', 'PageDown', 'Delete', 'Insert',
    'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  ]);
  const CODE_TO_KEY = {
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`', Space: ' ',
  };

  const SHORTCUTS = [
    ['Copy', ['ctrl'], 'c'], ['Paste', ['ctrl'], 'v'], ['Cut', ['ctrl'], 'x'],
    ['Undo', ['ctrl'], 'z'], ['Redo', ['ctrl', 'shift'], 'z'], ['Select all', ['ctrl'], 'a'],
    ['Save', ['ctrl'], 's'], ['Find', ['ctrl'], 'f'], ['Delete word', ['ctrl'], 'Backspace'],
    ['Word ←', ['ctrl'], 'ArrowLeft'], ['Word →', ['ctrl'], 'ArrowRight'],
    ['New tab', ['ctrl'], 't'], ['Close tab', ['ctrl'], 'w'], ['Reopen tab', ['ctrl', 'shift'], 't'],
    ['Switch app', ['alt'], 'Tab'], ['Activities', [], 'Meta'], ['Open terminal', ['ctrl', 'alt'], 't'],
    ['Terminal copy', ['ctrl', 'shift'], 'c'], ['Terminal paste', ['ctrl', 'shift'], 'v'],
    ['Lock screen', ['meta'], 'l'],
    ['🔉 Vol −', [], 'AudioVolumeDown', 'media'], ['🔇 Mute', [], 'AudioVolumeMute', 'media'],
    ['🔊 Vol +', [], 'AudioVolumeUp', 'media'], ['⏯ Play/Pause', [], 'MediaPlayPause', 'media'],
    ['⏮ Previous', [], 'MediaTrackPrevious', 'media'], ['⏭ Next', [], 'MediaTrackNext', 'media'],
  ];

  // ------------------------------------------------------------------ settings
  const settings = Object.assign(
    { cmdAsCtrl: true, autocorrect: false, echo: true, naturalScroll: true },
    JSON.parse(localStorage.getItem('padkeys.settings') || '{}'),
  );
  const saveSettings = () => localStorage.setItem('padkeys.settings', JSON.stringify(settings));

  // ------------------------------------------------------------------ PIN
  const hashPin = location.hash.match(/pin=(\d{6})/);
  if (hashPin) {
    localStorage.setItem('padkeys.pin', hashPin[1]);
    history.replaceState(null, '', location.pathname); // keep the PIN out of the address bar
  }
  let pin = localStorage.getItem('padkeys.pin');

  // ------------------------------------------------------------------ UI helpers
  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
  }

  function setStatus(state, text) {
    $('status').dataset.state = state;
    $('status-text').textContent = text ||
      { online: 'Connected', connecting: 'Connecting…', offline: 'Offline — retrying' }[state];
    if (state !== 'online') $('latency').textContent = '';
  }

  // ------------------------------------------------------------------ connection
  let ws = null;
  let connected = false;
  let retry = 0;
  let retryTimer = null;
  let pingTimer = null;
  let lastPong = 0;
  let host = '';

  function connect() {
    clearTimeout(retryTimer);
    if (ws) { ws.onclose = null; ws.close(); }
    setStatus('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sock = new WebSocket(`${proto}://${location.host}/ws`);
    let opened = false;
    ws = sock;

    sock.onopen = () => {
      opened = true;
      connected = true;
      retry = 0;
      lastPong = performance.now();
      setStatus('online');
      startPing();
    };

    sock.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t === 'hello') {
        host = msg.host;
        $('info-host').textContent = `${host} (${location.host})`;
        setStatus('online', `Connected to ${host}`);
        toast(`⌨️  Connected to ${host}`);
      } else if (msg.t === 'pong') {
        lastPong = performance.now();
        $('latency').textContent = `${Math.max(1, Math.round(lastPong - msg.id))} ms`;
      } else if (msg.t === 'clipboard_data') {
        const text = msg.v || '';
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(() => {
            toast('📋 Copied laptop clipboard to iPad!');
          }).catch(() => {
            prompt('Laptop Clipboard Content:', text);
          });
        } else {
          prompt('Laptop Clipboard Content:', text);
        }
      }
    };

    sock.onclose = () => {
      if (ws !== sock) return;
      connected = false;
      stopPing();
      setStatus(retry > 1 ? 'offline' : 'connecting');
      retry += 1;
      retryTimer = setTimeout(connect, Math.min(5000, 300 * 2 ** retry));
    };
  }

  function startPing() {
    stopPing();
    pingTimer = setInterval(() => {
      if (performance.now() - lastPong > 6000) { ws && ws.close(); return; }
      send({ t: 'ping', id: performance.now() }, true);
    }, 2000);
  }
  function stopPing() { clearInterval(pingTimer); }

  function send(obj, silent) {
    if (connected && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
      return true;
    }
    if (!silent) toast('Not connected — reconnecting…');
    return false;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && pin && !connected && !$('app').hidden) connect();
  });

  // ------------------------------------------------------------------ sticky modifiers
  // 0 = off, 1 = one-shot (next key only), 2 = locked (double-tap)
  const modState = { ctrl: 0, alt: 0, shift: 0, meta: 0 };
  const modTapAt = {};

  function activeMods() { return MODS.filter((m) => modState[m]); }

  function renderMods() {
    for (const el of document.querySelectorAll('.key.mod')) {
      const s = modState[el.dataset.mod];
      el.classList.toggle('on', s > 0);
      el.classList.toggle('locked', s === 2);
    }
    const a = activeMods();
    $('mod-hint').textContent = a.length ? `${a.map((m) => MOD_LABEL[m]).join(' + ')} + …` : '';
  }

  function tapMod(m) {
    const now = performance.now();
    const quick = now - (modTapAt[m] || 0) < 350;
    modTapAt[m] = now;
    if (modState[m] === 0) modState[m] = 1;
    else if (modState[m] === 1 && quick) modState[m] = 2;
    else modState[m] = 0;
    renderMods();
  }

  function consumeMods() {
    let changed = false;
    for (const m of MODS) if (modState[m] === 1) { modState[m] = 0; changed = true; }
    if (changed) renderMods();
  }

  function sendKey(key, extra = [], useSticky = true) {
    const mods = [...new Set([...(useSticky ? activeMods() : []), ...extra])];
    send({ t: 'key', k: key, m: mods });
    if (useSticky) consumeMods();
  }

  // ------------------------------------------------------------------ press handling (keeps focus!)
  // Using touchstart + preventDefault means tapping a key never blurs the text box,
  // so the iPad keyboard stays open.
  function bindPress(el, fn, repeat) {
    let delay, interval;
    const start = (e) => {
      e.preventDefault();
      el.classList.add('pressed');
      fn();
      if (repeat) delay = setTimeout(() => { interval = setInterval(fn, 55); }, 380);
    };
    const end = () => {
      el.classList.remove('pressed');
      clearTimeout(delay);
      clearInterval(interval);
    };
    el.addEventListener('touchstart', start, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
    el.addEventListener('mousedown', start);
    el.addEventListener('mouseup', end);
    el.addEventListener('mouseleave', end);
  }

  for (const el of document.querySelectorAll('.key[data-key]')) {
    bindPress(el, () => sendKey(el.dataset.key), el.hasAttribute('data-repeat'));
  }
  for (const el of document.querySelectorAll('.key.mod:not([data-mod="meta"])')) {
    bindPress(el, () => tapMod(el.dataset.mod));
  }

  // Super: TAP = press Super on the laptop (opens Activities / app search).
  //        LONG-PRESS = arm Super as a modifier for the next key (Super+L, Super+←, …).
  (() => {
    const el = $('k-super');
    let holdTimer = null;
    let held = false;
    let active = false;
    const start = (e) => {
      e.preventDefault();
      active = true;
      held = false;
      el.classList.add('pressed');
      holdTimer = setTimeout(() => {
        held = true;
        if (navigator.vibrate) navigator.vibrate(10);
        tapMod('meta');
        if (modState.meta) toast('Super armed — now press a key (e.g. L, ←, A)');
      }, 450);
    };
    const end = (e) => {
      if (!active) return;
      active = false;
      e.preventDefault();
      el.classList.remove('pressed');
      clearTimeout(holdTimer);
      if (held) return;
      if (modState.meta) { modState.meta = 0; renderMods(); return; } // tap while armed = cancel
      sendKey('Meta', [], false);
    };
    const cancel = () => { active = false; el.classList.remove('pressed'); clearTimeout(holdTimer); };
    el.addEventListener('touchstart', start, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', cancel);
    el.addEventListener('mousedown', start);
    el.addEventListener('mouseup', end);
    el.addEventListener('mouseleave', cancel);
  })();
  bindPress($('k-fn'), () => {
    const row = $('fn-row');
    row.hidden = !row.hidden;
    $('k-fn').classList.toggle('on', !row.hidden);
  });

  // Shortcut chips
  const fmt = (mods, key) => [...mods.map((m) => MOD_LABEL[m]),
    key.length === 1 ? key.toUpperCase() : key.replace('Arrow', '').replace('Meta', 'Super')].join('+');
  for (const [label, mods, key, kind] of SHORTCUTS) {
    const b = document.createElement('button');
    b.className = `chip${kind ? ` ${kind}` : ''}`;
    b.id = `sc-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    b.innerHTML = `<b></b>${kind ? '' : '<kbd></kbd>'}`;
    b.querySelector('b').textContent = label;
    if (!kind) b.querySelector('kbd').textContent = fmt(mods, key);
    $('chips').appendChild(b);
    bindPress(b, () => sendKey(key, mods, false), kind === 'media');
  }

  // ------------------------------------------------------------------ the type area
  const ta = $('input');
  let prev = SENTINEL;
  let sentCount = 0;
  ta.value = SENTINEL;

  const cps = (s) => Array.from(s); // code points (emoji-safe)

  function caretToEnd() {
    const n = ta.value.length;
    if (ta.selectionStart !== n || ta.selectionEnd !== n) ta.setSelectionRange(n, n);
  }

  function updateEmpty() {
    $('typepad').classList.toggle('empty', ta.value === SENTINEL || !settings.echo);
  }

  function resetBox() {
    ta.value = SENTINEL;
    prev = SENTINEL;
    caretToEnd();
    updateEmpty();
  }

  function onInput(e) {
    if (e && e.isComposing) return; // wait for IME composition to finish
    const v = ta.value;
    if (v === prev) return;

    const a = cps(prev);
    const b = cps(v);
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p += 1;

    const removed = a.slice(p);
    let del = removed.length;
    // If the invisible sentinel was wiped along with real text (e.g. select-all + delete), don't count it.
    if (del > 1 && removed.includes(SENTINEL)) del -= 1;
    const added = b.slice(p).join('').split(SENTINEL).join('');

    if (del > 0) send({ t: 'bs', n: del });

    let next = v;
    if (added) {
      const mods = activeMods();
      if (mods.length) {
        // A sticky modifier is armed: treat typed chars as shortcuts (e.g. Ctrl + c).
        for (const ch of cps(added)) send({ t: 'key', k: ch === '\n' ? 'Enter' : ch, m: mods });
        consumeMods();
        next = b.slice(0, p).join('');
      } else {
        send({ t: 'text', v: added });
        sentCount += cps(added).length;
        $('sent-count').textContent = sentCount.toLocaleString();
      }
    }

    if (!next.startsWith(SENTINEL)) next = SENTINEL + next.split(SENTINEL).join('');
    const nc = cps(next);
    if (nc.length > 4000) next = SENTINEL + nc.slice(-1500).join(''); // keep the box light
    if (next !== ta.value) ta.value = next;
    prev = ta.value;
    caretToEnd();
    updateEmpty();
  }

  ta.addEventListener('input', onInput);
  ta.addEventListener('compositionend', () => setTimeout(onInput, 0));
  ta.addEventListener('focus', () => { $('typepad').classList.add('focused'); setTimeout(caretToEnd, 0); });
  ta.addEventListener('blur', () => $('typepad').classList.remove('focused'));
  ta.addEventListener('click', caretToEnd);
  document.addEventListener('selectionchange', () => { if (document.activeElement === ta) caretToEnd(); });
  $('typepad').addEventListener('click', (e) => { if (e.target.id !== 'btn-clear') ta.focus(); });
  bindPress($('btn-clear'), () => { resetBox(); toast('Cleared (laptop text untouched)'); });

  function applyInputPrefs() {
    const on = settings.autocorrect;
    ta.setAttribute('autocorrect', on ? 'on' : 'off');
    ta.setAttribute('autocapitalize', on ? 'sentences' : 'off');
    ta.setAttribute('spellcheck', on ? 'true' : 'false');
    ta.setAttribute('autocomplete', on ? 'on' : 'off');
    document.body.classList.toggle('no-echo', !settings.echo);
    updateEmpty();
    if (document.activeElement === ta) { ta.blur(); setTimeout(() => ta.focus(), 50); }
  }

  // ------------------------------------------------------------------ hardware keyboard on the iPad
  function keyFromCode(code, fallback) {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
    if (/^Digit\d$/.test(code)) return code.slice(5);
    return CODE_TO_KEY[code] || fallback;
  }

  document.addEventListener('keydown', (e) => {
    if ($('app').hidden || !$('sheet').hidden) return;
    if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Unidentified', 'Dead'].includes(e.key)) return;

    const mods = [];
    if (e.ctrlKey) mods.push('ctrl');
    if (e.metaKey) mods.push(settings.cmdAsCtrl ? 'ctrl' : 'meta');
    if (e.altKey) mods.push('alt');
    const combo = mods.length > 0;

    if (combo || SPECIAL_KEYS.has(e.key)) {
      e.preventDefault();
      if (e.shiftKey) mods.push('shift');
      sendKey(combo ? keyFromCode(e.code, e.key) : e.key, mods);
      return;
    }
    if (document.activeElement !== ta) {
      // Text box not focused: forward plain keys directly.
      if (e.key === 'Backspace' || e.key === 'Enter') { e.preventDefault(); sendKey(e.key); }
      else if (e.key.length === 1) { e.preventDefault(); send({ t: 'text', v: e.key }); }
    }
  });

  // ------------------------------------------------------------------ iOS keyboard / viewport
  function fitViewport() {
    const vv = window.visualViewport;
    const h = vv ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty('--app-h', `${h}px`);
    document.body.classList.toggle('kb-open', window.innerHeight - h > 150);
    window.scrollTo(0, 0);
  }
  if (window.visualViewport) {
    visualViewport.addEventListener('resize', fitViewport);
    visualViewport.addEventListener('scroll', () => window.scrollTo(0, 0));
  }
  window.addEventListener('resize', fitViewport);
  fitViewport();

  // ------------------------------------------------------------------ settings sheet
  // ------------------------------------------------------------------ Clipboard sheet
  function openClipSheet(open) {
    $('clip-sheet').hidden = !open;
    $('clip-sheet-backdrop').hidden = !open;
  }
  const btnClip = $('btn-clipboard');
  if (btnClip) btnClip.addEventListener('click', () => openClipSheet(true));
  const btnCloseClip = $('btn-close-clip-sheet');
  if (btnCloseClip) btnCloseClip.addEventListener('click', () => openClipSheet(false));
  const backdropClip = $('clip-sheet-backdrop');
  if (backdropClip) backdropClip.addEventListener('click', () => openClipSheet(false));

  // ------------------------------------------------------------------ H-Scroll mode toggle
  let hScrollMode = false;
  const btnHScroll = $('btn-hscroll');
  if (btnHScroll) {
    btnHScroll.addEventListener('click', (e) => {
      e.stopPropagation();
      hScrollMode = !hScrollMode;
      btnHScroll.setAttribute('aria-pressed', hScrollMode ? 'true' : 'false');
      btnHScroll.textContent = hScrollMode ? '↔ H-Scroll: ON' : '↔ H-Scroll: Off';
      toast(hScrollMode ? 'Horizontal scroll mode ON' : 'Swipe Back / Forward mode ON');
    });
  }

  // Quick edit buttons on trackpad (Copy / Cut / Paste / Select All / Undo)
  for (const qb of document.querySelectorAll('.tp-q')) {
    bindPress(qb, () => {
      const q = qb.dataset.q;
      sendKey(q, ['ctrl']);
      toast(`Ctrl+${q.toUpperCase()}`);
    });
  }

  // ------------------------------------------------------------------ Trackpad & Gestures
  const tp = $('trackpad-surface');
  const tpScrollbar = $('tp-scrollbar');
  const tpThumb = $('tp-scrollbar-thumb');
  let tpTouches = {};
  let gestureStartPos = { x: 0, y: 0 };
  let gestureMaxFingers = 0;
  let gestureTriggered = false;
  let isMoving = false;
  let isDragging = false;
  let isScrollbarActive = false;
  let scrollbarAccY = 0;
  let scrollbarThumbOffset = 0;
  let lastTapTime = 0;
  let tapCount = 0;
  let totalDistance = 0;

  let pendingDx = 0;
  let pendingDy = 0;
  let moveRafId = null;

  function flushMove() {
    if (pendingDx !== 0 || pendingDy !== 0) {
      send({ t: 'move', dx: Math.round(pendingDx), dy: Math.round(pendingDy) });
      pendingDx = 0;
      pendingDy = 0;
    }
    moveRafId = null;
  }

  function queueMove(dx, dy) {
    pendingDx += dx;
    pendingDy += dy;
    if (!moveRafId) {
      moveRafId = requestAnimationFrame(flushMove);
    }
  }

  tp.addEventListener('touchstart', (e) => {
    e.preventDefault();
    tp.classList.add('active');
    const count = e.touches.length;
    gestureMaxFingers = Math.max(gestureMaxFingers, count);
    const now = performance.now();

    if (count === 1) {
      const t = e.touches[0];
      const rect = tp.getBoundingClientRect();
      const inScrollbar = (tpScrollbar && tpScrollbar.contains(e.target)) || (t.clientX >= rect.right - 44);

      if (inScrollbar) {
        isScrollbarActive = true;
        isMoving = true;
        scrollbarAccY = 0;
        scrollbarThumbOffset = 0;
        if (tpScrollbar) tpScrollbar.classList.add('scrolling');
      } else {
        isScrollbarActive = false;
      }

      tpTouches[t.identifier] = { x: t.clientX, y: t.clientY };
      gestureStartPos = { x: t.clientX, y: t.clientY };
      if (!isScrollbarActive) isMoving = false;
      totalDistance = 0;

      // Double-tap & hold -> start drag-selection
      if (!isScrollbarActive) {
        if (now - lastTapTime < 300) {
          tapCount += 1;
        } else {
          tapCount = 1;
        }
        lastTapTime = now;

        if (tapCount === 2) {
          isDragging = true;
          tp.classList.add('dragging');
          send({ t: 'btn', b: 'left', down: true });
        }
      }
    } else if (count === 2) {
      isScrollbarActive = false;
      if (tpScrollbar) tpScrollbar.classList.remove('scrolling');
      const t1 = e.touches[0], t2 = e.touches[1];
      const avgX = (t1.clientX + t2.clientX) / 2;
      const avgY = (t1.clientY + t2.clientY) / 2;
      tpTouches['scroll'] = { x: avgX, y: avgY };
      gestureStartPos = { x: avgX, y: avgY };
      gestureTriggered = false;
      totalDistance = 0;
    } else if (count >= 3) {
      isScrollbarActive = false;
      if (tpScrollbar) tpScrollbar.classList.remove('scrolling');
      let sumX = 0, sumY = 0;
      for (let i = 0; i < count; i++) { sumX += e.touches[i].clientX; sumY += e.touches[i].clientY; }
      gestureStartPos = { x: sumX / count, y: sumY / count };
      gestureTriggered = false;
    }
  }, { passive: false });

  tp.addEventListener('touchmove', (e) => {
    e.preventDefault();
    const count = e.touches.length;
    gestureMaxFingers = Math.max(gestureMaxFingers, count);

    if (count === 1) {
      const t = e.touches[0];
      const prev = tpTouches[t.identifier];
      if (prev) {
        const rawDy = t.clientY - prev.y;
        totalDistance += Math.hypot(t.clientX - prev.x, rawDy);

        if (isScrollbarActive) {
          scrollbarAccY += rawDy;
          if (Math.abs(scrollbarAccY) >= 4) {
            const dir = settings.naturalScroll ? (scrollbarAccY > 0 ? -1 : 1) : (scrollbarAccY > 0 ? 1 : -1);
            send({ t: 'scroll', d: dir });
            scrollbarAccY = 0;
          }
          scrollbarThumbOffset = Math.max(-25, Math.min(25, scrollbarThumbOffset + rawDy * 0.5));
          if (tpThumb) tpThumb.style.transform = `translateY(${scrollbarThumbOffset}px)`;
        } else {
          const dx = (t.clientX - prev.x) * 1.8;
          const dy = rawDy * 1.8;
          const dist = Math.hypot(t.clientX - gestureStartPos.x, t.clientY - gestureStartPos.y);

          if (dist > 6) {
            isMoving = true;
          }
          if (dx !== 0 || dy !== 0) queueMove(dx, dy);
        }
      }
      tpTouches[t.identifier] = { x: t.clientX, y: t.clientY };
    } else if (count === 2) {
      const t1 = e.touches[0], t2 = e.touches[1];
      const currX = (t1.clientX + t2.clientX) / 2;
      const currY = (t1.clientY + t2.clientY) / 2;
      const prev = tpTouches['scroll'];

      if (prev) {
        const dx = currX - prev.x;
        const dy = currY - prev.y;
        totalDistance += Math.hypot(dx, dy);

        if (hScrollMode) {
          // Horizontal scroll mode is enabled: 2 fingers move content vertically and horizontally
          if (Math.abs(dy) > 4) {
            const dir = settings.naturalScroll ? (dy > 0 ? 1 : -1) : (dy > 0 ? -1 : 1);
            send({ t: 'scroll', d: dir });
            prev.y = currY;
          }
          if (Math.abs(dx) > 4) {
            const dir = settings.naturalScroll ? (dx > 0 ? -1 : 1) : (dx > 0 ? 1 : -1);
            send({ t: 'hscroll', d: dir });
            prev.x = currX;
          }
        } else {
          // Standard mode: Vertical scroll ↕ OR Two-finger swipe Left (Back) / Right (Forward)
          if (!gestureTriggered) {
            const totalDx = currX - gestureStartPos.x;
            const totalDy = currY - gestureStartPos.y;

            if (Math.abs(totalDx) > 50 && Math.abs(totalDx) > Math.abs(totalDy) * 1.4) {
              gestureTriggered = true;
              if (totalDx > 0) {
                sendKey('ArrowRight', ['alt']); // Alt+Right (Forward in browsers/files)
                toast('Forward (Alt+→)');
              } else {
                sendKey('ArrowLeft', ['alt']); // Alt+Left (Back in browsers/files)
                toast('Back (Alt+←)');
              }
            } else if (Math.abs(dy) > 4) {
              const dir = settings.naturalScroll ? (dy > 0 ? 1 : -1) : (dy > 0 ? -1 : 1);
              send({ t: 'scroll', d: dir });
              prev.y = currY;
            }
          }
        }
      } else {
        tpTouches['scroll'] = { x: currX, y: currY };
      }
    } else if (count >= 3 && !gestureTriggered) {
      let sumX = 0, sumY = 0;
      for (let i = 0; i < count; i++) { sumX += e.touches[i].clientX; sumY += e.touches[i].clientY; }
      const currX = sumX / count;
      const currY = sumY / count;
      const dx = currX - gestureStartPos.x;
      const dy = currY - gestureStartPos.y;

      if (count === 3) {
        if (dx < -40) {
          gestureTriggered = true;
          sendKey('Tab', ['ctrl']); // Next tab
          toast('Next Tab (Ctrl+Tab)');
        } else if (dx > 40) {
          gestureTriggered = true;
          sendKey('Tab', ['ctrl', 'shift']); // Prev tab
          toast('Previous Tab (Ctrl+Shift+Tab)');
        } else if (dy < -40) {
          gestureTriggered = true;
          sendKey('Tab', ['alt']); // Switch App (Alt+Tab)
          toast('Switch App (Alt+Tab)');
        }
      } else if (count >= 4) {
        if (Math.abs(dy) > 35 || Math.abs(dx) > 35) {
          gestureTriggered = true;
          sendKey('Meta'); // Activities / Super Overview
          toast('Activities / Super Overview');
        }
      }
    }
  }, { passive: false });

  tp.addEventListener('touchend', (e) => {
    e.preventDefault();
    flushMove();

    if (isScrollbarActive && e.touches.length === 0) {
      isScrollbarActive = false;
      if (tpScrollbar) tpScrollbar.classList.remove('scrolling');
      if (tpThumb) tpThumb.style.transform = 'translateY(0px)';
      scrollbarThumbOffset = 0;
      scrollbarAccY = 0;
    }

    if (isDragging && e.touches.length === 0) {
      isDragging = false;
      tp.classList.remove('dragging');
      send({ t: 'btn', b: 'left', down: false });
    }

    if (e.touches.length === 0) {
      tp.classList.remove('active');

      // Tap detection: ONLY tap if total movement was under 10px and no gesture or scrollbar triggered
      if (!isMoving && !gestureTriggered && totalDistance < 10 && !isDragging && !isScrollbarActive) {
        if (gestureMaxFingers === 1) {
          send({ t: 'click', b: 'left' });
        } else if (gestureMaxFingers === 2) {
          send({ t: 'click', b: 'right' });
        } else if (gestureMaxFingers === 3) {
          send({ t: 'click', b: 'middle' });
        }
      }

      tpTouches = {};
      gestureMaxFingers = 0;
      gestureTriggered = false;
      isMoving = false;
    }
  }, { passive: false });

  // ------------------------------------------------------------------ Shared Clipboard
  bindPress($('btn-copy-from-laptop'), () => {
    send({ t: 'copy_from_laptop' });
  });

  bindPress($('btn-paste-to-laptop'), () => {
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then((text) => {
        if (text) {
          send({ t: 'paste_to_laptop', v: text });
          toast('📥 Pasted iPad text to Laptop!');
        } else {
          toast('iPad clipboard is empty');
        }
      }).catch(() => {
        const text = prompt('Paste text to send to laptop:');
        if (text) {
          send({ t: 'paste_to_laptop', v: text });
          toast('📥 Sent text to Laptop!');
        }
      });
    } else {
      const text = prompt('Paste text to send to laptop:');
      if (text) {
        send({ t: 'paste_to_laptop', v: text });
        toast('📥 Sent text to Laptop!');
      }
    }
  });

  // Fallback for mouse dragging on trackpad (desktop browser testing)
  let mDown = false, mPos = { x: 0, y: 0 };
  tp.addEventListener('mousedown', (e) => {
    mDown = true; mPos = { x: e.clientX, y: e.clientY }; tp.classList.add('active');
  });
  window.addEventListener('mousemove', (e) => {
    if (!mDown) return;
    const dx = (e.clientX - mPos.x) * 1.8;
    const dy = (e.clientY - mPos.y) * 1.8;
    mPos = { x: e.clientX, y: e.clientY };
    send({ t: 'move', dx: Math.round(dx), dy: Math.round(dy) });
  });
  window.addEventListener('mouseup', () => {
    if (mDown) { mDown = false; tp.classList.remove('active'); }
  });

  // Start app immediately
  applyInputPrefs();
  resetBox();
  connect();
})();

