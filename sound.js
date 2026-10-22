/* МитькаBattle — лёгкий синтезатор UI-звуков без внешних файлов. */
(function () {
  'use strict';

  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  const MASTER_VOLUME = 0.58;
  const TICK_MIN_INTERVAL = 40;

  let masterGain = null;
  let compressor = null;
  let noiseBuffer = null;
  let visibilityMuted = document.hidden;
  let masterMuted = true;
  let lastTickAt = -Infinity;
  let unlockArmed = false;
  const activeVoices = new Set();

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const nowMs = () => (window.performance && performance.now ? performance.now() : Date.now());

  function normaliseOptions(options) {
    const source = typeof options === 'number' ? { volume: options } : (options || {});
    return {
      volume: clamp(Number(source.volume == null ? 1 : source.volume) || 0, 0, 1.8),
      pitch: clamp(Number(source.pitch == null ? 1 : source.pitch) || 1, 0.45, 2.25),
      delay: clamp(Number(source.delay) || 0, 0, 4),
      pan: clamp(Number(source.pan) || 0, -1, 1)
    };
  }

  function getContext() {
    try {
      if (!AudioContextCtor) return null;
      if (audioCtx && audioCtx.state === 'closed') audioCtx = null;
      if (!audioCtx) audioCtx = new AudioContextCtor();
      return audioCtx;
    } catch (_) {
      return null;
    }
  }

  function createGraph(ctx) {
    if (masterGain) return true;
    try {
      masterGain = ctx.createGain();
      compressor = ctx.createDynamicsCompressor();
      compressor.threshold.setValueAtTime(-18, ctx.currentTime);
      compressor.knee.setValueAtTime(15, ctx.currentTime);
      compressor.ratio.setValueAtTime(10, ctx.currentTime);
      compressor.attack.setValueAtTime(0.004, ctx.currentTime);
      compressor.release.setValueAtTime(0.16, ctx.currentTime);
      masterGain.gain.setValueAtTime(0, ctx.currentTime);
      masterGain.connect(compressor);
      compressor.connect(ctx.destination);
      return true;
    } catch (_) {
      masterGain = null;
      compressor = null;
      return false;
    }
  }

  function setMasterMuted(muted, immediate) {
    if (!masterGain || !audioCtx) return;
    try {
      const time = audioCtx.currentTime;
      const gain = masterGain.gain;
      if (!muted && !masterMuted) return;
      gain.cancelScheduledValues(time);
      if (muted) {
        // Ноль на master gain мгновенно глушит и уже запланированные голоса.
        gain.setValueAtTime(0, time);
        masterMuted = true;
      } else if (immediate) {
        gain.setValueAtTime(MASTER_VOLUME, time);
        masterMuted = false;
      } else {
        gain.setValueAtTime(0, time);
        gain.linearRampToValueAtTime(MASTER_VOLUME, time + 0.018);
        masterMuted = false;
      }
    } catch (_) {}
  }

  function disconnectVoice(voice) {
    if (!voice || voice.done) return;
    voice.done = true;
    activeVoices.delete(voice);
    try { voice.source.onended = null; } catch (_) {}
    voice.nodes.forEach((node) => {
      try { node.disconnect(); } catch (_) {}
    });
  }

  function stopActiveVoices() {
    const time = audioCtx ? audioCtx.currentTime : 0;
    Array.from(activeVoices).forEach((voice) => {
      try { voice.source.stop(time); } catch (_) {}
      disconnectVoice(voice);
    });
  }

  function registerVoice(source, nodes) {
    const voice = { source, nodes, done: false };
    activeVoices.add(voice);
    source.onended = () => disconnectVoice(voice);
    return voice;
  }

  function getNoiseBuffer(ctx) {
    if (noiseBuffer && noiseBuffer.sampleRate === ctx.sampleRate) return noiseBuffer;
    const duration = 0.72;
    const length = Math.ceil(ctx.sampleRate * duration);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    // Слегка коррелированный шум звучит мягче, чем жёсткий белый.
    let previous = 0;
    for (let index = 0; index < data.length; index += 1) {
      previous = previous * 0.78 + (Math.random() * 2 - 1) * 0.22;
      data[index] = previous;
    }
    noiseBuffer = buffer;
    return buffer;
  }

  function routeVoice(ctx, source, gain, config, nodes) {
    let tail = source;
    if (config.filter) {
      const filter = ctx.createBiquadFilter();
      filter.type = config.filter.type || 'lowpass';
      filter.Q.setValueAtTime(config.filter.q == null ? 0.7 : config.filter.q, config.time);
      filter.frequency.setValueAtTime(Math.max(30, config.filter.frequency || 1200), config.time);
      if (config.filter.toFrequency) {
        filter.frequency.exponentialRampToValueAtTime(
          Math.max(30, config.filter.toFrequency),
          config.time + Math.max(0.012, config.duration)
        );
      }
      tail.connect(filter);
      tail = filter;
      nodes.push(filter);
    }
    if (config.pan && ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner();
      panner.pan.setValueAtTime(config.pan, config.time);
      tail.connect(panner);
      tail = panner;
      nodes.push(panner);
    }
    tail.connect(gain);
    gain.connect(masterGain);
  }

  function shapeEnvelope(gain, time, duration, peak, attack) {
    const end = time + Math.max(0.018, duration);
    const attackEnd = Math.min(end - 0.006, time + Math.max(0.002, attack || 0.006));
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(Math.max(0.0001, peak), attackEnd);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
  }

  function tone(ctx, time, frequency, duration, amplitude, config) {
    if (!masterGain || amplitude <= 0) return;
    try {
      const options = config || {};
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const freq = Math.max(24, frequency);
      osc.type = options.wave || 'sine';
      osc.frequency.setValueAtTime(freq, time);
      if (options.toFrequency) {
        osc.frequency.exponentialRampToValueAtTime(
          Math.max(24, options.toFrequency),
          time + Math.max(0.012, duration)
        );
      }
      if (options.detune) osc.detune.setValueAtTime(options.detune, time);
      shapeEnvelope(gain, time, duration, amplitude, options.attack);
      const nodes = [osc, gain];
      routeVoice(ctx, osc, gain, { ...options, time, duration }, nodes);
      registerVoice(osc, nodes);
      osc.start(time);
      osc.stop(time + duration + 0.035);
    } catch (_) {}
  }

  function noise(ctx, time, duration, amplitude, config) {
    if (!masterGain || amplitude <= 0) return;
    try {
      const options = config || {};
      const source = ctx.createBufferSource();
      const gain = ctx.createGain();
      source.buffer = getNoiseBuffer(ctx);
      shapeEnvelope(gain, time, duration, amplitude, options.attack || 0.003);
      const nodes = [source, gain];
      routeVoice(ctx, source, gain, { ...options, time, duration }, nodes);
      registerVoice(source, nodes);
      source.start(time);
      source.stop(time + duration + 0.035);
    } catch (_) {}
  }

  function scheduleClick(ctx, time, volume, pitch, pan) {
    tone(ctx, time, 630 * pitch, 0.052, 0.040 * volume, {
      wave: 'sine', toFrequency: 560 * pitch, attack: 0.004, pan,
      filter: { type: 'lowpass', frequency: 2100 }
    });
    noise(ctx, time, 0.020, 0.006 * volume, {
      pan, filter: { type: 'highpass', frequency: 1850, q: 0.8 }
    });
  }

  function scheduleSelect(ctx, time, volume, pitch, pan) {
    tone(ctx, time, 445 * pitch, 0.060, 0.030 * volume, { wave: 'sine', attack: 0.006, pan });
    tone(ctx, time + 0.052, 665 * pitch, 0.095, 0.035 * volume, {
      wave: 'sine', attack: 0.006, pan, filter: { type: 'lowpass', frequency: 2600 }
    });
  }

  function scheduleLock(ctx, time, volume, pitch, pan) {
    tone(ctx, time, 205 * pitch, 0.070, 0.035 * volume, {
      wave: 'triangle', toFrequency: 170 * pitch, attack: 0.004, pan,
      filter: { type: 'lowpass', frequency: 1500 }
    });
    tone(ctx, time + 0.028, 820 * pitch, 0.036, 0.017 * volume, {
      wave: 'sine', attack: 0.003, pan
    });
    noise(ctx, time, 0.030, 0.008 * volume, {
      pan, filter: { type: 'bandpass', frequency: 1500, q: 2.2 }
    });
  }

  function scheduleTick(ctx, time, volume, pitch, pan) {
    tone(ctx, time, 920 * pitch, 0.028, 0.017 * volume, {
      wave: 'square', toFrequency: 760 * pitch, attack: 0.002, pan,
      filter: { type: 'lowpass', frequency: 2300, q: 0.5 }
    });
    noise(ctx, time, 0.018, 0.009 * volume, {
      pan, filter: { type: 'bandpass', frequency: 2450, q: 2.8 }
    });
  }

  function scheduleOpen(ctx, time, volume, pitch, pan) {
    noise(ctx, time, 0.260, 0.029 * volume, {
      pan, attack: 0.010,
      filter: { type: 'bandpass', frequency: 230, toFrequency: 1750, q: 0.58 }
    });
    tone(ctx, time, 116 * pitch, 0.230, 0.042 * volume, {
      wave: 'sine', toFrequency: 232 * pitch, attack: 0.012, pan,
      filter: { type: 'lowpass', frequency: 950 }
    });
    tone(ctx, time + 0.175, 370 * pitch, 0.110, 0.027 * volume, {
      wave: 'triangle', toFrequency: 490 * pitch, attack: 0.006, pan
    });
  }

  function scheduleUpgrade(ctx, time, volume, pitch, pan) {
    tone(ctx, time, 135 * pitch, 0.300, 0.042 * volume, {
      wave: 'triangle', toFrequency: 410 * pitch, attack: 0.010, pan,
      filter: { type: 'lowpass', frequency: 1300 }
    });
    noise(ctx, time + 0.025, 0.240, 0.014 * volume, {
      pan, attack: 0.012,
      filter: { type: 'bandpass', frequency: 480, toFrequency: 2300, q: 1.1 }
    });
    tone(ctx, time + 0.115, 620 * pitch, 0.045, 0.013 * volume, { wave: 'sine', pan });
    tone(ctx, time + 0.205, 820 * pitch, 0.055, 0.017 * volume, { wave: 'sine', pan });
  }

  function scheduleWin(ctx, time, volume, pitch, pan) {
    const notes = [523.25, 659.25, 783.99];
    notes.forEach((note, index) => {
      const at = time + index * 0.095;
      tone(ctx, at, note * pitch, index === 2 ? 0.220 : 0.115, 0.042 * volume, {
        wave: 'sine', attack: 0.006, pan,
        filter: { type: 'lowpass', frequency: 3000 }
      });
      tone(ctx, at + 0.005, note * 2 * pitch, index === 2 ? 0.160 : 0.075, 0.010 * volume, {
        wave: 'triangle', attack: 0.005, pan: pan * 0.7
      });
    });
    noise(ctx, time + 0.190, 0.105, 0.010 * volume, {
      pan, filter: { type: 'highpass', frequency: 3200, q: 0.7 }
    });
  }

  function scheduleDrop(ctx, time, volume, pitch, pan) {
    tone(ctx, time, 330 * pitch, 0.090, 0.037 * volume, { wave: 'sine', attack: 0.006, pan });
    tone(ctx, time + 0.075, 494 * pitch, 0.165, 0.043 * volume, {
      wave: 'triangle', attack: 0.006, pan,
      filter: { type: 'lowpass', frequency: 2700 }
    });
    noise(ctx, time + 0.064, 0.050, 0.007 * volume, {
      pan, filter: { type: 'bandpass', frequency: 2100, q: 1.8 }
    });
  }

  function scheduleSell(ctx, time, volume, pitch, pan) {
    tone(ctx, time, 720 * pitch, 0.070, 0.032 * volume, { wave: 'sine', toFrequency: 880 * pitch, attack: 0.004, pan });
    tone(ctx, time + 0.055, 990 * pitch, 0.130, 0.038 * volume, { wave: 'triangle', toFrequency: 1220 * pitch, attack: 0.005, pan });
    noise(ctx, time + 0.030, 0.060, 0.007 * volume, { pan, filter: { type: 'highpass', frequency: 2600, q: 0.8 } });
  }

  function scheduleProfile(ctx, time, volume, pitch, pan) {
    tone(ctx, time, 392 * pitch, 0.100, 0.026 * volume, { wave: 'sine', attack: 0.006, pan });
    tone(ctx, time + 0.070, 523 * pitch, 0.120, 0.032 * volume, { wave: 'sine', attack: 0.006, pan });
    tone(ctx, time + 0.150, 659 * pitch, 0.170, 0.035 * volume, { wave: 'triangle', attack: 0.006, pan });
  }

  function scheduleBonus(ctx, time, volume, pitch, pan) {
    tone(ctx, time, 523 * pitch, 0.080, 0.029 * volume, { wave: 'sine', attack: 0.005, pan });
    tone(ctx, time + 0.075, 784 * pitch, 0.130, 0.036 * volume, { wave: 'sine', attack: 0.005, pan });
    tone(ctx, time + 0.150, 1046 * pitch, 0.200, 0.040 * volume, { wave: 'triangle', attack: 0.006, pan });
  }

  function scheduleRare(ctx, time, volume, pitch, pan) {
    const notes = [659.25, 783.99, 1046.5, 1318.5];
    notes.forEach((note, index) => {
      const at = time + index * 0.078;
      tone(ctx, at, note * pitch, index === notes.length - 1 ? 0.260 : 0.115, 0.040 * volume, {
        wave: 'sine', attack: 0.005, pan: clamp(pan + (index % 2 ? 0.16 : -0.16), -1, 1)
      });
      tone(ctx, at + 0.008, note * 2 * pitch, 0.095, 0.010 * volume, {
        wave: 'triangle', attack: 0.004, pan
      });
    });
    noise(ctx, time + 0.180, 0.170, 0.012 * volume, {
      pan, filter: { type: 'highpass', frequency: 4100, q: 0.6 }
    });
  }

  function scheduleContract(ctx, time, volume, pitch, pan) {
    tone(ctx, time, 294 * pitch, 0.095, 0.037 * volume, { wave: 'triangle', attack: 0.006, pan });
    tone(ctx, time + 0.075, 392 * pitch, 0.105, 0.039 * volume, { wave: 'triangle', attack: 0.006, pan });
    tone(ctx, time + 0.155, 587 * pitch, 0.180, 0.042 * volume, { wave: 'sine', attack: 0.006, pan });
    noise(ctx, time + 0.010, 0.130, 0.009 * volume, {
      pan, filter: { type: 'bandpass', frequency: 900, q: 1.4 }
    });
  }

  function scheduleFail(ctx, time, volume, pitch, pan) {
    tone(ctx, time, 300 * pitch, 0.125, 0.035 * volume, {
      wave: 'sine', toFrequency: 245 * pitch, attack: 0.007, pan,
      filter: { type: 'lowpass', frequency: 1350 }
    });
    tone(ctx, time + 0.095, 220 * pitch, 0.205, 0.039 * volume, {
      wave: 'triangle', toFrequency: 150 * pitch, attack: 0.007, pan,
      filter: { type: 'lowpass', frequency: 1050 }
    });
    noise(ctx, time + 0.070, 0.090, 0.006 * volume, {
      pan, filter: { type: 'lowpass', frequency: 850, q: 0.8 }
    });
  }

  function resumeForInteraction() {
    const ctx = getContext();
    if (!ctx || !createGraph(ctx)) return null;
    try {
      if (ctx.state === 'suspended') {
        const resumed = ctx.resume();
        if (resumed && typeof resumed.catch === 'function') resumed.catch(() => {});
      }
    } catch (_) {}
    return ctx;
  }

  function unlockFromGesture() {
    document.removeEventListener('pointerdown', unlockFromGesture, true);
    document.removeEventListener('keydown', unlockFromGesture, true);
    unlockArmed = false;
    if (!soundOn || document.hidden) return;
    const ctx = resumeForInteraction();
    if (!ctx) return;
    visibilityMuted = false;
    setMasterMuted(false, false);
  }

  function armGestureUnlock() {
    if (unlockArmed || !document.addEventListener) return;
    unlockArmed = true;
    // Единственный capture-обработчик ничего не отменяет и нужен только для unlock Web Audio.
    document.addEventListener('pointerdown', unlockFromGesture, {
      capture: true,
      passive: true,
      once: true
    });
    document.addEventListener('keydown', unlockFromGesture, {
      capture: true,
      passive: true,
      once: true
    });
  }

  function sound(type = 'click', options) {
    const name = String(type || 'click').toLowerCase();
    const settings = normaliseOptions(options);

    if (!soundOn || document.hidden || visibilityMuted) return;
    if (name === 'tick') {
      const timestamp = nowMs();
      if (timestamp - lastTickAt < TICK_MIN_INTERVAL) return;
      lastTickAt = timestamp;
    }

    // Вызов из onclick/keydown идёт синхронно: resume успевает получить user activation.
    const ctx = resumeForInteraction();
    if (!ctx || !masterGain || settings.volume === 0) return;
    setMasterMuted(false, false);
    const time = ctx.currentTime + settings.delay;
    const { volume, pitch, pan } = settings;

    switch (name) {
      case 'select': scheduleSelect(ctx, time, volume, pitch, pan); break;
      case 'lock': scheduleLock(ctx, time, volume, pitch, pan); break;
      case 'tick': scheduleTick(ctx, time, volume, pitch, pan); break;
      case 'open': scheduleOpen(ctx, time, volume, pitch, pan); break;
      case 'upgrade': scheduleUpgrade(ctx, time, volume, pitch, pan); break;
      case 'win': scheduleWin(ctx, time, volume, pitch, pan); break;
      case 'victory': scheduleRare(ctx, time, volume, pitch, pan); break;
      case 'drop': scheduleDrop(ctx, time, volume, pitch, pan); break;
      case 'sell': scheduleSell(ctx, time, volume, pitch, pan); break;
      case 'profile': scheduleProfile(ctx, time, volume, pitch, pan); break;
      case 'bonus': scheduleBonus(ctx, time, volume, pitch, pan); break;
      case 'chat': scheduleSelect(ctx, time, volume, pitch, pan); break;
      case 'message': scheduleClick(ctx, time, volume, pitch, pan); break;
      case 'rare': scheduleRare(ctx, time, volume, pitch, pan); break;
      case 'contract': scheduleContract(ctx, time, volume, pitch, pan); break;
      case 'fail': scheduleFail(ctx, time, volume, pitch, pan); break;
      case 'click':
      default: scheduleClick(ctx, time, volume, pitch, pan); break;
    }
  }

  function updateSoundButton() {
    try {
      const button = typeof $ === 'function' ? $('soundBtn') : document.getElementById('soundBtn');
      if (button) button.textContent = soundOn ? '🔊 Звук: вкл.' : '🔇 Звук: выкл.';
    } catch (_) {}
  }

  function toggleSound() {
    soundOn = !soundOn;
    try { localStorage.setItem('mb_sound', soundOn ? 'on' : 'off'); } catch (_) {}
    updateSoundButton();

    if (!soundOn) {
      setMasterMuted(true, true);
      stopActiveVoices();
      return;
    }

    if (!document.hidden) {
      // Клик по переключателю — надёжный пользовательский жест для resume.
      visibilityMuted = false;
      const ctx = resumeForInteraction();
      if (ctx) setMasterMuted(false, false);
      sound('click', { volume: 0.72 });
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      visibilityMuted = true;
      setMasterMuted(true, true);
      stopActiveVoices();
      return;
    }
    // После возвращения звук включится только от следующего пользовательского жеста.
    visibilityMuted = true;
    armGestureUnlock();
  });

  armGestureUnlock();
  // Свойства window доступны последующему inline-коду и inline onclick-обработчикам.
  window.sound = sound;
  window.toggleSound = toggleSound;
})();
