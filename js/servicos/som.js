// Módulo ES (sem etapa de build): importa só com caminho relativo, sem import map,
// para funcionar no Safari do iOS 15.4+. Veja js/ponte.js.

import { Store } from './armazenamento.js';

/* ==========================================================================
   4. MOTOR DE EFEITOS SONOROS WEB AUDIO (SoundEngine)
   ========================================================================== */
const SoundEngine = (() => {
  let ctx = null;
  let muted = Store.get('sh_muted') === 'true';

  function init() {
    if (!ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) ctx = new AudioCtx();
    }
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
  }

  function toggleMute() {
    muted = !muted;
    Store.set('sh_muted', String(muted));
    updateMuteButtons();
    if (!muted) {
      init();
      select();
    }
  }

  function updateMuteButtons() {
    const lobbyBtn = document.getElementById('btn-mute-lobby');
    const gameBtn = document.getElementById('btn-mute-game');
    if (lobbyBtn) lobbyBtn.textContent = muted ? '🔇 Mudo' : '🔊 Som';
    if (gameBtn) gameBtn.textContent = muted ? '🔇' : '🔊';
  }

  function createNoiseBuffer(durationSec) {
    if (!ctx) return null;
    const sampleRate = ctx.sampleRate;
    const frameCount = Math.floor(sampleRate * durationSec);
    const buffer = ctx.createBuffer(1, frameCount, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frameCount; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  function select() {
    if (muted) return;
    init();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(520, now);
    osc.frequency.exponentialRampToValueAtTime(880, now + 0.045);
    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.045);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.05);
  }

  function slide() {
    if (muted) return;
    init();
    if (!ctx) return;
    const now = ctx.currentTime;
    const noise = ctx.createBufferSource();
    noise.buffer = createNoiseBuffer(0.14);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(900, now);
    filter.frequency.exponentialRampToValueAtTime(2400, now + 0.13);
    filter.Q.value = 1.8;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.01, now);
    gain.gain.linearRampToValueAtTime(0.15, now + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    noise.start(now);
  }

  function playCard() {
    if (muted) return;
    init();
    if (!ctx) return;
    slide();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(190, now + 0.04);
    osc.frequency.exponentialRampToValueAtTime(75, now + 0.13);
    gain.gain.setValueAtTime(0.22, now + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now + 0.04);
    osc.stop(now + 0.15);
  }

  function power2() {
    if (muted) return;
    init();
    if (!ctx) return;
    const now = ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now + idx * 0.055);
      gain.gain.setValueAtTime(0.15, now + idx * 0.055);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.055 + 0.22);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + idx * 0.055);
      osc.stop(now + idx * 0.055 + 0.23);
    });
  }

  function power7() {
    if (muted) return;
    init();
    if (!ctx) return;
    const now = ctx.currentTime;
    [330, 277.18].forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 950;
      osc.frequency.setValueAtTime(freq, now + idx * 0.11);
      gain.gain.setValueAtTime(0.14, now + idx * 0.11);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.11 + 0.18);
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + idx * 0.11);
      osc.stop(now + idx * 0.11 + 0.19);
    });
  }

  function burn10() {
    if (muted) return;
    init();
    if (!ctx) return;
    const now = ctx.currentTime;
    const noise = ctx.createBufferSource();
    noise.buffer = createNoiseBuffer(0.45);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1800, now);
    filter.frequency.exponentialRampToValueAtTime(140, now + 0.44);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.32, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.44);
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    noise.start(now);
  }

  function jokerSwap() {
    if (muted) return;
    init();
    if (!ctx) return;
    const now = ctx.currentTime;
    [392, 523.25, 440, 587.33, 493.88, 659.25, 783.99].forEach((f, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, now + i * 0.045);
      gain.gain.setValueAtTime(0.15, now + i * 0.045);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.045 + 0.14);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + i * 0.045);
      osc.stop(now + i * 0.045 + 0.15);
    });
  }

  function reverseOrder() {
    if (muted) return;
    init();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(740, now);
    osc.frequency.exponentialRampToValueAtTime(260, now + 0.14);
    osc.frequency.exponentialRampToValueAtTime(660, now + 0.28);
    gain.gain.setValueAtTime(0.18, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.31);
  }

  function pickupPile() {
    if (muted) return;
    init();
    if (!ctx) return;
    const now = ctx.currentTime;
    [311.13, 277.18, 233.08].forEach((f, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(f, now + i * 0.08);
      gain.gain.setValueAtTime(0.16, now + i * 0.08);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.08 + 0.16);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + i * 0.08);
      osc.stop(now + i * 0.08 + 0.17);
    });
  }

  function invalidError() {
    if (muted) return;
    init();
    if (!ctx) return;
    const now = ctx.currentTime;
    [155, 130].forEach((f, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(f, now + i * 0.09);
      gain.gain.setValueAtTime(0.14, now + i * 0.09);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.09 + 0.08);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + i * 0.09);
      osc.stop(now + i * 0.09 + 0.09);
    });
  }

  function gameOver() {
    if (muted) return;
    init();
    if (!ctx) return;
    const now = ctx.currentTime;
    [
      { f: 392.0, t: 0.0, d: 0.22 },
      { f: 369.99, t: 0.24, d: 0.22 },
      { f: 349.23, t: 0.48, d: 0.22 },
      { f: 329.63, t: 0.72, d: 0.55 }
    ].forEach(n => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(n.f, now + n.t);
      gain.gain.setValueAtTime(0.16, now + n.t);
      gain.gain.exponentialRampToValueAtTime(0.001, now + n.t + n.d);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + n.t);
      osc.stop(now + n.t + n.d + 0.02);
    });
  }

  // Fanfarra "trombone" exagerada para o botão GOMBRA!
  function gombra() {
    if (muted) return;
    init();
    if (!ctx) return;
    const now = ctx.currentTime;
    [
      { f: 196, t: 0.0, d: 0.16 },
      { f: 196, t: 0.18, d: 0.12 },
      { f: 261.63, t: 0.32, d: 0.16 },
      { f: 392, t: 0.5, d: 0.5 }
    ].forEach(n => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 1400;
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(n.f, now + n.t);
      osc.frequency.linearRampToValueAtTime(n.f * 1.03, now + n.t + n.d);
      gain.gain.setValueAtTime(0.0001, now + n.t);
      gain.gain.exponentialRampToValueAtTime(0.2, now + n.t + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, now + n.t + n.d);
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + n.t);
      osc.stop(now + n.t + n.d + 0.02);
    });
  }

  // Despertador "trrrim-trrrim" para o DORMIU?? (toca só no aparelho de quem demora)
  function alarm() {
    if (muted) return;
    init();
    if (!ctx) return;
    const now = ctx.currentTime;
    for (let burst = 0; burst < 3; burst++) {
      const start = now + burst * 0.42;
      for (let k = 0; k < 10; k++) {
        const t = start + k * 0.03;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.setValueAtTime(k % 2 ? 1568 : 1318.5, t);
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.12, t + 0.005);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.028);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.03);
      }
    }
  }

  // "Tum-tum" grave de coração quando o monte fica grande
  function heartbeat() {
    if (muted) return;
    init();
    if (!ctx) return;
    const now = ctx.currentTime;
    [0, 0.22, 0.9, 1.12].forEach((t, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(i % 2 ? 50 : 62, now + t);
      osc.frequency.exponentialRampToValueAtTime(35, now + t + 0.18);
      gain.gain.setValueAtTime(0.0001, now + t);
      gain.gain.exponentialRampToValueAtTime(i % 2 ? 0.35 : 0.5, now + t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.2);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + t);
      osc.stop(now + t + 0.22);
    });
  }

  function playByTag(tag) {
    switch (tag) {
      case 'BURN10': burn10(); break;
      case 'JOKER': jokerSwap(); break;
      case 'POWER2': power2(); break;
      case 'POWER7': power7(); break;
      case 'REVERSE': reverseOrder(); break;
      case 'PICKUP': pickupPile(); break;
      case 'GAMEOVER': gameOver(); break;
      case 'SLIDE': slide(); break;
      default: playCard(); break;
    }
  }

  return { init, toggleMute, updateMuteButtons, select, slide, power2, power7, invalidError, gombra, alarm, heartbeat, playByTag, isReady: () => !!ctx && ctx.state === 'running' };
})();

export { SoundEngine };
