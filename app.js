// ===== Utilities =====
const qs = (selector) => document.querySelector(selector);
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
})[char]);

function formatTime(seconds) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  if (safeSeconds >= 3600) {
    const h = Math.floor(safeSeconds / 3600);
    const m = Math.floor((safeSeconds % 3600) / 60);
    const s = safeSeconds % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  const m = Math.floor(safeSeconds / 60);
  const s = safeSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function getRectOverlapRatio(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const overlapArea = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const baseArea = Math.max(1, Math.min(a.width * a.height, b.width * b.height));
  return overlapArea / baseArea;
}

// ===== Services =====
class AlarmService {
  constructor() {
    this.audioContext = null;
  }

  createHandle() {
    return {
      isAlarmPlaying: false,
      alarmOscillators: [],
      alarmRepeatTimeout: null,
    };
  }

  ensureAudioContext() {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
  }

  play(handle) {
    this.ensureAudioContext();
    handle.isAlarmPlaying = true;
    this.scheduleBeeps(handle);
  }

  scheduleBeeps(handle) {
    if (!this.audioContext || !handle.isAlarmPlaying) return;

    const now = this.audioContext.currentTime;
    const beep = (startTime, freq, duration) => {
      const osc = this.audioContext.createOscillator();
      const gain = this.audioContext.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, startTime);
      gain.gain.setValueAtTime(0, startTime);
      gain.gain.linearRampToValueAtTime(0.25, startTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
      osc.connect(gain);
      gain.connect(this.audioContext.destination);
      osc.start(startTime);
      osc.stop(startTime + duration);
      handle.alarmOscillators.push(osc);
    };

    [
      { delay: 0.0, freq: 880, duration: 0.15 },
      { delay: 0.2, freq: 880, duration: 0.15 },
      { delay: 0.6, freq: 880, duration: 0.15 },
      { delay: 0.8, freq: 880, duration: 0.15 },
      { delay: 1.2, freq: 1046, duration: 0.2 },
      { delay: 1.5, freq: 1046, duration: 0.2 },
    ].forEach(({ delay, freq, duration }) => beep(now + delay, freq, duration));

    handle.alarmRepeatTimeout = setTimeout(() => {
      if (handle.isAlarmPlaying) this.scheduleBeeps(handle);
    }, 2000);
  }

  stop(handle) {
    handle.isAlarmPlaying = false;
    if (handle.alarmRepeatTimeout) {
      clearTimeout(handle.alarmRepeatTimeout);
      handle.alarmRepeatTimeout = null;
    }
    handle.alarmOscillators.forEach((osc) => {
      try {
        osc.stop();
      } catch (error) {
        // Oscillators can already be stopped by their scheduled stop time.
      }
    });
    handle.alarmOscillators = [];
  }
}

class GameSlotStorage {
  constructor(lastKey, presetKey) {
    this.lastKey = lastKey;
    this.presetKey = presetKey;
  }

  buildPayload(slots, sourceSize) {
    return {
      sourceWidth: sourceSize.width || null,
      sourceHeight: sourceSize.height || null,
      slots: slots.map((slot) => ({
        id: slot.id,
        name: slot.name,
        maxSeconds: slot.maxSeconds,
        rect: slot.rect,
      })),
    };
  }

  saveLast(slots, sourceSize) {
    localStorage.setItem(this.lastKey, JSON.stringify(this.buildPayload(slots, sourceSize)));
  }

  loadLast() {
    return this.readJson(this.lastKey);
  }

  clearLast() {
    localStorage.removeItem(this.lastKey);
  }

  getPresets() {
    const presets = this.readJson(this.presetKey, {});
    return presets && typeof presets === 'object' && !Array.isArray(presets) ? presets : {};
  }

  savePresets(presets) {
    localStorage.setItem(this.presetKey, JSON.stringify(presets));
  }

  savePreset(name, slots, sourceSize) {
    const presets = this.getPresets();
    presets[name] = {
      ...this.buildPayload(slots, sourceSize),
      savedAt: new Date().toISOString(),
    };
    this.savePresets(presets);
  }

  deletePreset(name) {
    const presets = this.getPresets();
    delete presets[name];
    this.savePresets(presets);
  }

  readJson(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      localStorage.removeItem(key);
      return fallback;
    }
  }
}

// ===== Timer Cards =====
class TimerManager {
  constructor(elements, alarmService) {
    this.elements = elements;
    this.alarmService = alarmService;
    this.timers = {};
    this.counter = 0;
  }

  init() {
    this.elements.addButton.addEventListener('click', () => this.createTimer());
    this.createTimer();
  }

  get runningTimers() {
    return Object.values(this.timers).filter((timer) => timer.state === 'running');
  }

  createTimer() {
    this.counter += 1;
    const timer = {
      ...this.alarmService.createHandle(),
      id: `timer-${this.counter}`,
      number: this.counter,
      totalSeconds: 0,
      remainingSeconds: 0,
      interval: null,
      state: 'idle',
      enabled: true,
      repeat: false,
      autoRestart: false,
      alarmDuration: 3,
      restartDelay: 0,
      restartTimeout: null,
      alarmAutoStopTimeout: null,
    };

    this.timers[timer.id] = timer;
    this.renderTimerCard(timer);
    return timer;
  }

  renderTimerCard(timer) {
    const card = document.createElement('div');
    card.className = 'timer-card';
    card.id = timer.id;
    card.innerHTML = `
      <div class="card-glow"></div>

      <div class="timer-card-toolbar">
        <span class="timer-card-title">타이머 #${timer.number}</span>
        <div class="toolbar-actions">
          <div class="toggle-btn active" data-action="toggle" title="활성화/비활성화">
            <div class="toggle-knob"></div>
          </div>
          <button class="delete-btn" data-action="delete" title="삭제">x</button>
        </div>
      </div>

      <div class="timer-display">
        <span class="time-value" data-el="timeValue">00:00</span>
        <span class="time-label">남은 시간</span>
      </div>

      <div class="progress-bar-track">
        <div class="progress-bar-fill" data-el="progressBar"></div>
      </div>

      <div class="alarm-banner" data-el="alarmBanner">
        <div class="alarm-banner-left">
          <span class="alarm-bell">!</span>
          <div>
            <div class="alarm-banner-text">시간 종료!</div>
            <div class="alarm-banner-sub" data-el="alarmSubText">알람이 울리고 있습니다</div>
          </div>
        </div>
        <button class="btn-dismiss" data-action="dismiss">알람 끄기</button>
      </div>

      <div data-el="inputGroup">
        <div class="input-group">
          <div class="input-wrapper">
            <input type="number" class="seconds-input" data-el="secondsInput" placeholder="초 입력" min="1" max="86400">
            <span class="input-suffix">초</span>
          </div>
          <div class="preset-buttons">
            <button class="preset-btn" data-seconds="10">10초</button>
            <button class="preset-btn" data-seconds="30">30초</button>
            <button class="preset-btn" data-seconds="60">1분</button>
            <button class="preset-btn" data-seconds="180">3분</button>
            <button class="preset-btn" data-seconds="300">5분</button>
            <button class="preset-btn" data-seconds="600">10분</button>
          </div>
        </div>

        <div class="options-row">
          <label class="checkbox-wrapper">
            <input type="checkbox" data-el="repeatCheckbox">
            <span>반복</span>
          </label>
          <label class="checkbox-wrapper auto-restart">
            <input type="checkbox" data-el="autoRestartCheckbox">
            <span>자동 재시작</span>
          </label>
          <span class="option-tag repeat-tag hidden" data-el="repeatTag">반복</span>
          <span class="option-tag auto-tag hidden" data-el="autoTag">자동</span>
        </div>

        <div class="alarm-duration-row hidden" data-el="alarmDurationRow">
          <label class="duration-label">알람 시간</label>
          <div class="duration-input-wrapper">
            <input type="number" class="duration-input" data-el="alarmDurationInput" value="3" min="1" max="60">
            <span class="duration-suffix">초</span>
          </div>
          <div class="duration-presets">
            <button class="dur-preset" data-dur="1">1초</button>
            <button class="dur-preset" data-dur="3">3초</button>
            <button class="dur-preset" data-dur="5">5초</button>
            <button class="dur-preset" data-dur="10">10초</button>
          </div>
        </div>

        <div class="restart-delay-row hidden" data-el="restartDelayRow">
          <label class="duration-label">재시작 대기</label>
          <div class="duration-input-wrapper">
            <input type="number" class="duration-input" data-el="restartDelayInput" value="0" min="0" max="3600">
            <span class="duration-suffix">초</span>
          </div>
          <div class="duration-presets">
            <button class="delay-preset" data-delay="0">즉시</button>
            <button class="delay-preset" data-delay="5">5초</button>
            <button class="delay-preset" data-delay="10">10초</button>
            <button class="delay-preset" data-delay="30">30초</button>
          </div>
        </div>
      </div>

      <div class="controls">
        <button class="btn btn-start" data-action="start">시작</button>
        <button class="btn btn-pause hidden" data-action="pause">일시정지</button>
        <button class="btn btn-resume hidden" data-action="resume">재개</button>
        <button class="btn btn-adjust hidden" data-action="minusTime" title="-1초">-1초</button>
        <button class="btn btn-adjust hidden" data-action="plusTime" title="+1초">+1초</button>
        <button class="btn btn-reset hidden" data-action="reset">초기화</button>
      </div>
    `;

    this.elements.grid.appendChild(card);
    this.bindCard(card, timer);
  }

  bindCard(card, timer) {
    card.addEventListener('click', (event) => {
      const actionEl = event.target.closest('[data-action]');
      if (actionEl) {
        this.handleAction(timer.id, actionEl.dataset.action);
        return;
      }

      const presetBtn = event.target.closest('.preset-btn');
      if (presetBtn) {
        const input = this.getEl(timer.id, 'secondsInput');
        input.value = presetBtn.dataset.seconds;
        input.focus();
      }
    });

    this.getEl(timer.id, 'repeatCheckbox').addEventListener('change', (event) => {
      timer.repeat = event.target.checked;
      this.getEl(timer.id, 'repeatTag').classList.toggle('hidden', !timer.repeat);
      this.getEl(timer.id, 'alarmDurationRow').classList.toggle('hidden', !timer.repeat);
      if (!timer.repeat) {
        timer.autoRestart = false;
        this.getEl(timer.id, 'autoRestartCheckbox').checked = false;
        this.getEl(timer.id, 'autoTag').classList.add('hidden');
        this.getEl(timer.id, 'restartDelayRow').classList.add('hidden');
      }
    });

    this.getEl(timer.id, 'autoRestartCheckbox').addEventListener('change', (event) => {
      timer.autoRestart = event.target.checked;
      this.getEl(timer.id, 'autoTag').classList.toggle('hidden', !timer.autoRestart);
      this.getEl(timer.id, 'restartDelayRow').classList.toggle('hidden', !timer.autoRestart);
      if (timer.autoRestart && !timer.repeat) {
        timer.repeat = true;
        this.getEl(timer.id, 'repeatCheckbox').checked = true;
        this.getEl(timer.id, 'repeatTag').classList.remove('hidden');
        this.getEl(timer.id, 'alarmDurationRow').classList.remove('hidden');
      }
    });

    this.getEl(timer.id, 'alarmDurationInput').addEventListener('change', (event) => {
      timer.alarmDuration = clamp(parseInt(event.target.value, 10) || 3, 1, 60);
      event.target.value = timer.alarmDuration;
    });

    this.getEl(timer.id, 'restartDelayInput').addEventListener('change', (event) => {
      timer.restartDelay = clamp(parseInt(event.target.value, 10) || 0, 0, 3600);
      event.target.value = timer.restartDelay;
    });

    card.querySelectorAll('.dur-preset').forEach((button) => {
      button.addEventListener('click', () => {
        timer.alarmDuration = parseInt(button.dataset.dur, 10);
        this.getEl(timer.id, 'alarmDurationInput').value = timer.alarmDuration;
      });
    });

    card.querySelectorAll('.delay-preset').forEach((button) => {
      button.addEventListener('click', () => {
        timer.restartDelay = parseInt(button.dataset.delay, 10);
        this.getEl(timer.id, 'restartDelayInput').value = timer.restartDelay;
      });
    });

    this.getEl(timer.id, 'secondsInput').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.start(timer.id);
    });
  }

  handleAction(id, action) {
    const actions = {
      start: () => this.start(id),
      pause: () => this.pause(id),
      resume: () => this.resume(id),
      minusTime: () => this.adjustTime(id, -1),
      plusTime: () => this.adjustTime(id, 1),
      reset: () => this.reset(id),
      toggle: () => this.toggle(id),
      delete: () => this.delete(id),
      dismiss: () => this.dismissAlarm(id),
    };
    actions[action]?.();
  }

  getCard(id) {
    return document.getElementById(id);
  }

  getEl(id, name) {
    return this.getCard(id)?.querySelector(`[data-el="${name}"]`);
  }

  updateDisplay(id) {
    const timer = this.timers[id];
    if (!timer) return;

    const timeValue = this.getEl(id, 'timeValue');
    const progressBar = this.getEl(id, 'progressBar');
    if (!timeValue || !progressBar) return;

    timeValue.textContent = formatTime(timer.remainingSeconds);
    const progress = timer.totalSeconds > 0 ? timer.remainingSeconds / timer.totalSeconds : 1;
    progressBar.style.width = `${progress * 100}%`;

    timeValue.classList.remove('running', 'warning', 'danger');
    if (timer.state === 'running' || timer.state === 'paused') {
      if (progress > 0.25) {
        timeValue.classList.add('running');
        progressBar.style.background = 'var(--success)';
      } else if (progress > 0.1) {
        timeValue.classList.add('warning');
        progressBar.style.background = 'var(--warning)';
      } else {
        timeValue.classList.add('danger');
        progressBar.style.background = 'var(--danger)';
      }
    } else {
      progressBar.style.background = 'var(--accent)';
    }
  }

  setUIState(id, state) {
    const card = this.getCard(id);
    if (!card) return;

    card.querySelector('[data-action="start"]').classList.toggle('hidden', state !== 'idle');
    card.querySelector('[data-action="pause"]').classList.toggle('hidden', state !== 'running');
    card.querySelector('[data-action="resume"]').classList.toggle('hidden', state !== 'paused');
    card.querySelector('[data-action="reset"]').classList.toggle('hidden', state === 'idle' || state === 'alarming');
    card.querySelectorAll('.btn-adjust').forEach((button) => {
      button.classList.toggle('hidden', state !== 'running' && state !== 'paused');
    });

    this.getEl(id, 'inputGroup').classList.toggle('hidden', state !== 'idle');
    this.getEl(id, 'alarmBanner').classList.toggle('active', state === 'alarming');
    card.classList.toggle('timer-running', state === 'running');
    card.classList.toggle('timer-alarming', state === 'alarming');

    if (state === 'idle') {
      card.classList.remove('timer-running', 'timer-alarming');
      const timeValue = this.getEl(id, 'timeValue');
      const progressBar = this.getEl(id, 'progressBar');
      timeValue.textContent = '00:00';
      timeValue.classList.remove('running', 'warning', 'danger');
      progressBar.style.width = '100%';
      progressBar.style.background = 'var(--accent)';
    }
  }

  start(id) {
    const timer = this.timers[id];
    if (!timer || !timer.enabled) return;

    const input = this.getEl(id, 'secondsInput');
    const seconds = parseInt(input.value, 10);
    if (!seconds || seconds <= 0) {
      input.parentElement.classList.add('shake');
      setTimeout(() => input.parentElement.classList.remove('shake'), 500);
      return;
    }

    timer.totalSeconds = seconds;
    timer.remainingSeconds = seconds;
    timer.state = 'running';
    this.updateDisplay(id);
    this.setUIState(id, 'running');
    timer.interval = setInterval(() => this.tick(id), 1000);
  }

  tick(id) {
    const timer = this.timers[id];
    if (!timer) return;

    timer.remainingSeconds -= 1;
    this.updateDisplay(id);
    this.updatePageTitle();

    if (timer.remainingSeconds <= 0) {
      clearInterval(timer.interval);
      timer.interval = null;
      this.triggerAlarm(id);
    }
  }

  pause(id) {
    const timer = this.timers[id];
    if (!timer) return;
    clearInterval(timer.interval);
    timer.interval = null;
    this.stopAlarmState(id);
    timer.state = 'paused';
    this.setUIState(id, 'paused');
  }

  resume(id) {
    const timer = this.timers[id];
    if (!timer) return;
    timer.state = 'running';
    this.setUIState(id, 'running');
    timer.interval = setInterval(() => this.tick(id), 1000);
  }

  reset(id) {
    const timer = this.timers[id];
    if (!timer) return;
    clearInterval(timer.interval);
    timer.interval = null;
    this.stopAlarmState(id);
    timer.totalSeconds = 0;
    timer.remainingSeconds = 0;
    timer.state = 'idle';
    this.setUIState(id, 'idle');
    this.updatePageTitle();
  }

  adjustTime(id, seconds) {
    const timer = this.timers[id];
    if (!timer || (timer.state !== 'running' && timer.state !== 'paused')) return;
    timer.remainingSeconds = Math.max(0, timer.remainingSeconds + seconds);
    if (timer.remainingSeconds > timer.totalSeconds) timer.totalSeconds = timer.remainingSeconds;
    this.updateDisplay(id);
    this.updatePageTitle();
  }

  toggle(id) {
    const timer = this.timers[id];
    const card = this.getCard(id);
    const toggleBtn = card?.querySelector('[data-action="toggle"]');
    if (!timer || !card || !toggleBtn) return;

    timer.enabled = !timer.enabled;
    if (!timer.enabled && timer.state !== 'idle') this.reset(id);
    card.classList.toggle('disabled', !timer.enabled);
    toggleBtn.classList.toggle('active', timer.enabled);
  }

  delete(id) {
    const timer = this.timers[id];
    if (!timer) return;
    clearInterval(timer.interval);
    this.stopAlarmState(id);
    const card = this.getCard(id);
    card?.classList.add('removing');
    setTimeout(() => {
      card?.remove();
      delete this.timers[id];
      if (Object.keys(this.timers).length === 0) this.createTimer();
      this.updatePageTitle();
    }, 300);
  }

  triggerAlarm(id) {
    const timer = this.timers[id];
    if (!timer) return;
    const alarmMs = timer.alarmDuration * 1000;

    if (timer.autoRestart && timer.repeat) {
      this.handleAutoRestartAlarm(id, alarmMs);
      return;
    }

    timer.state = 'alarming';
    this.setUIState(id, 'alarming');
    this.getEl(id, 'alarmSubText').textContent = timer.repeat
      ? `알람 ${timer.alarmDuration}초 후 알람 끄기를 누르면 반복`
      : '알람이 울리고 있습니다';
    this.alarmService.play(timer);

    timer.alarmAutoStopTimeout = setTimeout(() => {
      if (timer.state !== 'alarming') return;
      this.alarmService.stop(timer);
      if (!timer.repeat) {
        timer.state = 'idle';
        this.setUIState(id, 'idle');
      }
    }, alarmMs);
  }

  handleAutoRestartAlarm(id, alarmMs) {
    const timer = this.timers[id];
    timer.remainingSeconds = timer.totalSeconds;
    this.updateDisplay(id);

    if (timer.restartDelay > 0) {
      timer.state = 'alarming';
      this.setUIState(id, 'alarming');
      this.getEl(id, 'alarmSubText').textContent = `${timer.restartDelay}초 후 자동 재시작`;
      this.alarmService.play(timer);
      timer.alarmAutoStopTimeout = setTimeout(() => this.alarmService.stop(timer), alarmMs);
      timer.restartTimeout = setTimeout(() => {
        if (timer.state !== 'alarming') return;
        timer.state = 'running';
        this.setUIState(id, 'running');
        timer.interval = setInterval(() => this.tick(id), 1000);
      }, timer.restartDelay * 1000);
      return;
    }

    timer.state = 'running';
    this.setUIState(id, 'running');
    timer.interval = setInterval(() => this.tick(id), 1000);
    this.getEl(id, 'alarmBanner').classList.add('active');
    this.getCard(id).classList.add('timer-alarming');
    this.alarmService.play(timer);
    timer.alarmAutoStopTimeout = setTimeout(() => {
      this.alarmService.stop(timer);
      this.getEl(id, 'alarmBanner').classList.remove('active');
      this.getCard(id).classList.remove('timer-alarming');
    }, alarmMs);
  }

  dismissAlarm(id) {
    const timer = this.timers[id];
    if (!timer) return;
    this.stopAlarmState(id);

    if (timer.restartTimeout) {
      timer.state = 'running';
      this.setUIState(id, 'running');
      timer.interval = setInterval(() => this.tick(id), 1000);
      return;
    }

    if (timer.state === 'running') return;

    if (timer.repeat) {
      timer.remainingSeconds = timer.totalSeconds;
      timer.state = 'running';
      this.updateDisplay(id);
      this.setUIState(id, 'running');
      timer.interval = setInterval(() => this.tick(id), 1000);
    } else {
      timer.state = 'idle';
      this.setUIState(id, 'idle');
    }
  }

  stopAlarmState(id) {
    const timer = this.timers[id];
    if (!timer) return;
    this.alarmService.stop(timer);
    if (timer.alarmAutoStopTimeout) clearTimeout(timer.alarmAutoStopTimeout);
    if (timer.restartTimeout) clearTimeout(timer.restartTimeout);
    timer.alarmAutoStopTimeout = null;
    timer.restartTimeout = null;
    this.getEl(id, 'alarmBanner')?.classList.remove('active');
    this.getCard(id)?.classList.remove('timer-alarming');
  }

  updatePageTitle() {
    document.title = this.runningTimers.length
      ? `${formatTime(this.runningTimers[0].remainingSeconds)} Multi Timer`
      : 'Multi Timer Alarm';
  }

  handleGlobalKey(event) {
    if (event.key === 'Enter') {
      Object.values(this.timers).forEach((timer) => {
        if (!timer.enabled) return;
        if (timer.state === 'idle') this.start(timer.id);
        if (timer.state === 'paused') this.resume(timer.id);
      });
    } else if (event.key === 'ArrowLeft') {
      Object.values(this.timers).forEach((timer) => {
        if (timer.enabled && timer.state === 'running') this.adjustTime(timer.id, -1);
      });
    } else if (event.key === 'ArrowRight') {
      Object.values(this.timers).forEach((timer) => {
        if (timer.enabled && timer.state === 'running') this.adjustTime(timer.id, 1);
      });
    }
  }
}

// ===== Screen Capture =====
class ScreenCaptureMode {
  constructor(elements) {
    this.elements = elements;
    this.stream = null;
    this.blob = null;
    this.objectUrl = null;
    this.startPoint = null;
    this.activePointerId = null;
  }

  init() {
    this.elements.openButton.addEventListener('click', () => this.start());
    this.elements.closeButton.addEventListener('click', () => this.stop());
    this.elements.resultCloseButton.addEventListener('click', () => this.closeResult());
    this.elements.downloadButton.addEventListener('click', () => this.download());
    this.elements.copyButton.addEventListener('click', () => this.copy());
    this.bindPointerEvents();
  }

  get isOpen() {
    return !this.elements.overlay.classList.contains('hidden');
  }

  async start() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      alert('이 브라우저에서는 화면 캡쳐 기능을 사용할 수 없습니다.');
      return;
    }

    try {
      this.stream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always' },
        audio: false,
      });
      this.elements.video.srcObject = this.stream;
      await this.elements.video.play();
      this.elements.overlay.classList.remove('hidden');
      this.elements.overlay.setAttribute('aria-hidden', 'false');
      this.elements.selection.classList.add('hidden');
      this.stream.getVideoTracks()[0].addEventListener('ended', () => this.stop(), { once: true });
    } catch (error) {
      if (error.name !== 'NotAllowedError') {
        alert('화면 캡쳐를 시작하지 못했습니다. 다시 시도해 주세요.');
      }
    }
  }

  stop() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.elements.video.pause();
    this.elements.video.srcObject = null;
    this.elements.overlay.classList.add('hidden');
    this.elements.overlay.setAttribute('aria-hidden', 'true');
    this.elements.selection.classList.add('hidden');
    this.startPoint = null;
    this.activePointerId = null;
  }

  bindPointerEvents() {
    this.elements.stage.addEventListener('pointerdown', (event) => {
      if (!this.stream) return;
      this.activePointerId = event.pointerId;
      this.elements.stage.setPointerCapture(event.pointerId);
      this.startPoint = this.clampPoint(event.clientX, event.clientY);
      this.updateSelection(this.startPoint, this.startPoint);
    });

    this.elements.stage.addEventListener('pointermove', (event) => {
      if (!this.startPoint || event.pointerId !== this.activePointerId) return;
      this.updateSelection(this.startPoint, this.clampPoint(event.clientX, event.clientY));
    });

    this.elements.stage.addEventListener('pointerup', (event) => {
      if (!this.startPoint || event.pointerId !== this.activePointerId) return;
      this.crop(this.startPoint, this.clampPoint(event.clientX, event.clientY));
      this.startPoint = null;
      this.activePointerId = null;
    });

    this.elements.stage.addEventListener('pointercancel', () => {
      this.startPoint = null;
      this.activePointerId = null;
      this.elements.selection.classList.add('hidden');
    });
  }

  getVideoRect() {
    const stageRect = this.elements.stage.getBoundingClientRect();
    const videoRatio = this.elements.video.videoWidth / this.elements.video.videoHeight;
    const stageRatio = stageRect.width / stageRect.height;
    if (stageRatio > videoRatio) {
      const width = stageRect.height * videoRatio;
      return {
        left: stageRect.left + (stageRect.width - width) / 2,
        top: stageRect.top,
        width,
        height: stageRect.height,
      };
    }

    const height = stageRect.width / videoRatio;
    return {
      left: stageRect.left,
      top: stageRect.top + (stageRect.height - height) / 2,
      width: stageRect.width,
      height,
    };
  }

  clampPoint(clientX, clientY) {
    const rect = this.getVideoRect();
    return {
      x: clamp(clientX, rect.left, rect.left + rect.width),
      y: clamp(clientY, rect.top, rect.top + rect.height),
    };
  }

  updateSelection(from, to) {
    const left = Math.min(from.x, to.x);
    const top = Math.min(from.y, to.y);
    this.elements.selection.style.left = `${left}px`;
    this.elements.selection.style.top = `${top}px`;
    this.elements.selection.style.width = `${Math.abs(to.x - from.x)}px`;
    this.elements.selection.style.height = `${Math.abs(to.y - from.y)}px`;
    this.elements.selection.classList.remove('hidden');
  }

  crop(from, to) {
    const videoRect = this.getVideoRect();
    const left = Math.min(from.x, to.x);
    const top = Math.min(from.y, to.y);
    const width = Math.abs(to.x - from.x);
    const height = Math.abs(to.y - from.y);
    if (width < 8 || height < 8) {
      this.elements.selection.classList.add('hidden');
      return;
    }

    const scaleX = this.elements.video.videoWidth / videoRect.width;
    const scaleY = this.elements.video.videoHeight / videoRect.height;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scaleX);
    canvas.height = Math.round(height * scaleY);
    canvas.getContext('2d').drawImage(
      this.elements.video,
      Math.round((left - videoRect.left) * scaleX),
      Math.round((top - videoRect.top) * scaleY),
      canvas.width,
      canvas.height,
      0,
      0,
      canvas.width,
      canvas.height
    );

    canvas.toBlob((blob) => {
      if (!blob) return;
      this.clearPreviousCapture();
      this.blob = blob;
      this.objectUrl = URL.createObjectURL(blob);
      this.elements.preview.src = this.objectUrl;
      this.elements.result.classList.remove('hidden');
      this.stop();
    }, 'image/png');
  }

  clearPreviousCapture() {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.blob = null;
    this.elements.preview.removeAttribute('src');
  }

  download() {
    if (!this.blob) return;
    const link = document.createElement('a');
    link.href = this.objectUrl;
    link.download = `capture-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    link.click();
  }

  async copy() {
    if (!this.blob || !navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
      alert('이 브라우저에서는 이미지 클립보드 복사를 사용할 수 없습니다.');
      return;
    }

    try {
      await navigator.clipboard.write([new ClipboardItem({ [this.blob.type]: this.blob })]);
      this.elements.copyButton.textContent = '복사됨';
      setTimeout(() => {
        this.elements.copyButton.textContent = '클립보드 복사';
      }, 1200);
    } catch (error) {
      alert('클립보드 복사 권한이 허용되지 않았습니다.');
    }
  }

  closeResult() {
    this.elements.result.classList.add('hidden');
    this.clearPreviousCapture();
  }
}

// ===== Game Cooldown Mode =====
class GameCooldownMode {
  constructor(elements, alarmService, storage) {
    this.elements = elements;
    this.alarmService = alarmService;
    this.storage = storage;
    this.stream = null;
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.recordingUrl = null;
    this.keepRecording = true;
    this.slots = [];
    this.slotCounter = 0;
    this.analysisInterval = null;
    this.countdownInterval = null;
    this.selectingSlot = false;
    this.selectionStartPoint = null;
    this.activePointerId = null;
    this.zoom = 2;
    this.ocrBusy = false;
    this.ocrWorker = null;
    this.ocrReady = false;
    this.analysisCanvas = document.createElement('canvas');
    this.analysisContext = this.analysisCanvas.getContext('2d', { willReadFrequently: true });
    this.ocrCanvas = document.createElement('canvas');
    this.ocrContext = this.ocrCanvas.getContext('2d', { willReadFrequently: true });
  }

  init() {
    this.elements.openButton.addEventListener('click', () => this.start());
    this.elements.closeButton.addEventListener('click', () => this.stop());
    this.elements.addSlotButton.addEventListener('click', () => this.beginSlotSelection());
    this.elements.zoomInput.addEventListener('change', () => this.applyZoom());
    this.elements.analyzeButton.addEventListener('click', () => this.toggleAnalysis());
    this.elements.recordButton.addEventListener('click', () => this.toggleRecording());
    this.elements.downloadRecordingButton.addEventListener('click', () => this.downloadRecording());
    this.elements.clearSavedButton.addEventListener('click', () => this.clearSavedSlots());
    this.elements.savePresetButton.addEventListener('click', () => this.saveCurrentPreset());
    this.elements.loadPresetButton.addEventListener('click', () => this.loadSelectedPreset());
    this.elements.deletePresetButton.addEventListener('click', () => this.deleteSelectedPreset());
    this.elements.presetSelect.addEventListener('change', () => {
      if (this.elements.presetSelect.value) this.elements.presetNameInput.value = this.elements.presetSelect.value;
    });
    this.elements.slotList.addEventListener('click', (event) => this.handleSlotListClick(event));
    this.bindSelectionEvents();
    window.addEventListener('resize', () => this.renderSlotOverlays());
  }

  get isOpen() {
    return !this.elements.overlay.classList.contains('hidden');
  }

  async start() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      alert('이 브라우저에서는 화면 캡쳐 기능을 사용할 수 없습니다.');
      return;
    }

    try {
      this.stream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always', frameRate: 30 },
        audio: false,
      });
      this.elements.video.srcObject = this.stream;
      await this.elements.video.play();
      this.elements.overlay.classList.remove('hidden');
      this.elements.overlay.setAttribute('aria-hidden', 'false');
      this.setStatus('스킬 이름을 입력한 뒤 스킬칸 등록을 누르고, 쿨타임 숫자가 뜨는 영역까지 드래그하세요.');
      this.renderPresetOptions();
      this.applyZoom();
      this.stream.getVideoTracks()[0].addEventListener('ended', () => this.stop(), { once: true });
      if (!this.loadLastSlots()) this.renderSlotOverlays();
    } catch (error) {
      if (error.name !== 'NotAllowedError') {
        alert('게임 화면 캡쳐를 시작하지 못했습니다. 다시 시도해 주세요.');
      }
    }
  }

  stop() {
    this.stopAnalysis();
    this.stopRecording(false);
    this.slots.forEach((slot) => this.clearSlotAlarm(slot));
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.elements.video.pause();
    this.elements.video.srcObject = null;
    this.elements.overlay.classList.add('hidden');
    this.elements.overlay.setAttribute('aria-hidden', 'true');
    this.selectingSlot = false;
    this.selectionStartPoint = null;
    this.activePointerId = null;
    this.elements.selection.classList.add('hidden');
    this.elements.stage.classList.remove('selecting');
    this.elements.addSlotButton.classList.remove('active');
    this.stopCountdown();
  }

  setStatus(message) {
    this.elements.status.textContent = message;
  }

  createSlotState({ id, name, maxSeconds, rect }) {
    return {
      id,
      name,
      maxSeconds,
      rect,
      remainingSeconds: 0,
      lastReadSeconds: 0,
      lastReadText: '',
      ignoredReadText: '',
      lastSeenAt: 0,
      lastOcrAt: 0,
      ocrPending: false,
      cooldownLocked: false,
      acceptedReads: 0,
      candidateSeconds: null,
      candidateCount: 0,
      alarmed: false,
      alarmHandle: this.alarmService.createHandle(),
    };
  }

  sourceSize() {
    return {
      width: this.elements.video.videoWidth,
      height: this.elements.video.videoHeight,
    };
  }

  saveLastSlots() {
    this.storage.saveLast(this.slots, this.sourceSize());
  }

  loadLastSlots() {
    const payload = this.storage.loadLast();
    return this.applySlotPayload(payload, payload ? `${payload.slots?.length || 0}개 스킬 범위를 불러왔습니다. 분석 시작을 누르면 저장된 범위로 읽습니다.` : '');
  }

  applySlotPayload(payload, statusMessage) {
    if (!payload || !Array.isArray(payload.slots)) return false;

    const sourceWidth = payload.sourceWidth || this.elements.video.videoWidth || 1;
    const sourceHeight = payload.sourceHeight || this.elements.video.videoHeight || 1;
    const scaleX = this.elements.video.videoWidth / sourceWidth;
    const scaleY = this.elements.video.videoHeight / sourceHeight;

    this.slots.forEach((slot) => this.alarmService.stop(slot.alarmHandle));
    this.slotCounter = 0;
    this.slots = payload.slots.map((slot, index) => {
      const idNumber = parseInt(String(slot.id || '').replace(/\D/g, ''), 10) || index + 1;
      this.slotCounter = Math.max(this.slotCounter, idNumber);
      return this.createSlotState({
        id: slot.id || `slot-${idNumber}`,
        name: slot.name || `스킬 ${index + 1}`,
        maxSeconds: clamp(parseInt(slot.maxSeconds, 10) || 60, 1, 6000),
        rect: {
          x: Math.round((slot.rect?.x || 0) * scaleX),
          y: Math.round((slot.rect?.y || 0) * scaleY),
          width: Math.max(1, Math.round((slot.rect?.width || 1) * scaleX)),
          height: Math.max(1, Math.round((slot.rect?.height || 1) * scaleY)),
        },
      });
    });

    this.saveLastSlots();
    this.renderSlotList();
    this.renderSlotOverlays();
    if (statusMessage) this.setStatus(statusMessage);
    return true;
  }

  renderPresetOptions() {
    const presets = this.storage.getPresets();
    const names = Object.keys(presets).sort((a, b) => a.localeCompare(b, 'ko'));
    const current = this.elements.presetSelect.value;
    this.elements.presetSelect.innerHTML = names.length
      ? names.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('')
      : '<option value="">저장된 프리셋 없음</option>';
    if (names.includes(current)) this.elements.presetSelect.value = current;
  }

  saveCurrentPreset() {
    const name = this.elements.presetNameInput.value.trim();
    if (!name) {
      this.setStatus('프리셋 이름을 입력하세요.');
      return;
    }
    this.storage.savePreset(name, this.slots, this.sourceSize());
    this.renderPresetOptions();
    this.elements.presetSelect.value = name;
    this.setStatus(`프리셋 "${name}" 저장 완료.`);
  }

  loadSelectedPreset() {
    const name = this.elements.presetSelect.value;
    const payload = this.storage.getPresets()[name];
    if (!name || !payload) {
      this.setStatus('불러올 프리셋이 없습니다.');
      this.renderPresetOptions();
      return;
    }
    this.elements.presetNameInput.value = name;
    this.applySlotPayload(payload, `프리셋 "${name}" 불러오기 완료. 분석 시작을 누르면 저장된 범위로 읽습니다.`);
  }

  deleteSelectedPreset() {
    const name = this.elements.presetSelect.value;
    if (!name) {
      this.setStatus('삭제할 프리셋이 없습니다.');
      return;
    }
    this.storage.deletePreset(name);
    this.renderPresetOptions();
    this.setStatus(`프리셋 "${name}" 삭제 완료.`);
  }

  clearSavedSlots() {
    this.storage.clearLast();
    this.slots.forEach((slot) => this.alarmService.stop(slot.alarmHandle));
    this.slots = [];
    this.slotCounter = 0;
    this.renderSlotList();
    this.renderSlotOverlays();
    this.setStatus('저장된 스킬 범위를 지웠습니다.');
  }

  applyZoom() {
    const prevScrollRatioX = this.elements.stage.scrollLeft / Math.max(1, this.elements.stage.scrollWidth - this.elements.stage.clientWidth);
    const prevScrollRatioY = this.elements.stage.scrollTop / Math.max(1, this.elements.stage.scrollHeight - this.elements.stage.clientHeight);
    this.zoom = clamp(parseFloat(this.elements.zoomInput.value) || 1, 1, 4);
    this.elements.zoomSurface.style.width = `${this.zoom * 100}%`;
    this.elements.zoomSurface.style.height = `${this.zoom * 100}%`;
    this.elements.stageHint.textContent = `${this.zoom}x 확대 중 · 숫자 부분만 드래그하세요`;
    requestAnimationFrame(() => {
      this.elements.stage.scrollLeft = prevScrollRatioX * Math.max(0, this.elements.stage.scrollWidth - this.elements.stage.clientWidth);
      this.elements.stage.scrollTop = prevScrollRatioY * Math.max(0, this.elements.stage.scrollHeight - this.elements.stage.clientHeight);
    });
    this.renderSlotOverlays();
  }

  bindSelectionEvents() {
    this.elements.stage.addEventListener('pointerdown', (event) => {
      if (!this.stream || !this.selectingSlot) return;
      this.activePointerId = event.pointerId;
      this.elements.stage.setPointerCapture(event.pointerId);
      this.selectionStartPoint = this.clampPointToVideo(event.clientX, event.clientY);
      this.updateSelection(this.selectionStartPoint, this.selectionStartPoint);
    });

    this.elements.stage.addEventListener('pointermove', (event) => {
      if (!this.selectionStartPoint || event.pointerId !== this.activePointerId) return;
      this.updateSelection(this.selectionStartPoint, this.clampPointToVideo(event.clientX, event.clientY));
    });

    this.elements.stage.addEventListener('pointerup', (event) => {
      if (!this.selectionStartPoint || event.pointerId !== this.activePointerId) return;
      this.createSkillSlot(this.pointRectToSourceRect(this.selectionStartPoint, this.clampPointToVideo(event.clientX, event.clientY)));
      this.endSelection();
    });

    this.elements.stage.addEventListener('pointercancel', () => this.endSelection());
  }

  beginSlotSelection() {
    if (!this.stream) {
      this.setStatus('먼저 게임 화면을 선택하세요.');
      return;
    }
    this.selectingSlot = true;
    this.elements.stage.classList.add('selecting');
    this.elements.addSlotButton.classList.add('active');
    this.setStatus('확대된 화면에서 쿨타임 숫자만 들어오게 드래그하세요. 기존 박스와 겹치면 선택 박스가 빨갛게 표시됩니다.');
  }

  endSelection() {
    this.selectionStartPoint = null;
    this.activePointerId = null;
    this.selectingSlot = false;
    this.elements.selection.classList.add('hidden');
    this.elements.stage.classList.remove('selecting');
    this.elements.addSlotButton.classList.remove('active');
  }

  getVideoDisplayRect() {
    const stageRect = this.elements.zoomSurface.getBoundingClientRect();
    const videoRatio = this.elements.video.videoWidth / this.elements.video.videoHeight;
    const stageRatio = stageRect.width / stageRect.height;
    if (!videoRatio) return { left: stageRect.left, top: stageRect.top, width: stageRect.width, height: stageRect.height };

    if (stageRatio > videoRatio) {
      const width = stageRect.height * videoRatio;
      return { left: stageRect.left + (stageRect.width - width) / 2, top: stageRect.top, width, height: stageRect.height };
    }

    const height = stageRect.width / videoRatio;
    return { left: stageRect.left, top: stageRect.top + (stageRect.height - height) / 2, width: stageRect.width, height };
  }

  clampPointToVideo(clientX, clientY) {
    const rect = this.getVideoDisplayRect();
    return {
      x: clamp(clientX, rect.left, rect.left + rect.width),
      y: clamp(clientY, rect.top, rect.top + rect.height),
    };
  }

  updateSelection(from, to) {
    const left = Math.min(from.x, to.x);
    const top = Math.min(from.y, to.y);
    const width = Math.abs(to.x - from.x);
    const height = Math.abs(to.y - from.y);
    const surfaceRect = this.elements.zoomSurface.getBoundingClientRect();
    const sourceRect = this.pointRectToSourceRect(from, to);
    const hasOverlap = this.slots.some((slot) => getRectOverlapRatio(sourceRect, slot.rect) > 0.18);
    this.elements.selection.style.left = `${left - surfaceRect.left}px`;
    this.elements.selection.style.top = `${top - surfaceRect.top}px`;
    this.elements.selection.style.width = `${width}px`;
    this.elements.selection.style.height = `${height}px`;
    this.elements.selection.classList.toggle('overlap', hasOverlap);
    this.elements.selection.innerHTML = `<span>${sourceRect.width} x ${sourceRect.height}${hasOverlap ? ' · 겹침' : ''}</span>`;
    this.elements.selection.classList.remove('hidden');
  }

  pointRectToSourceRect(from, to) {
    const videoRect = this.getVideoDisplayRect();
    const left = Math.min(from.x, to.x);
    const top = Math.min(from.y, to.y);
    const width = Math.abs(to.x - from.x);
    const height = Math.abs(to.y - from.y);
    const scaleX = this.elements.video.videoWidth / videoRect.width;
    const scaleY = this.elements.video.videoHeight / videoRect.height;
    return {
      x: Math.round((left - videoRect.left) * scaleX),
      y: Math.round((top - videoRect.top) * scaleY),
      width: Math.round(width * scaleX),
      height: Math.round(height * scaleY),
    };
  }

  createSkillSlot(sourceRect) {
    if (sourceRect.width < 8 || sourceRect.height < 8) {
      this.setStatus('영역이 너무 작습니다. 쿨타임 숫자가 들어오도록 다시 드래그하세요.');
      return;
    }

    const maxSeconds = clamp(parseInt(this.elements.maxSecondsInput.value, 10) || 60, 1, 6000);
    const name = this.elements.skillNameInput.value.trim() || `스킬 ${this.slotCounter + 1}`;
    const overlapSlot = this.slots.find((slot) => getRectOverlapRatio(sourceRect, slot.rect) > 0.18);
    this.slotCounter += 1;
    this.slots.push(this.createSlotState({
      id: `slot-${this.slotCounter}`,
      name,
      maxSeconds,
      rect: sourceRect,
    }));

    this.elements.skillNameInput.value = `스킬 ${this.slotCounter + 1}`;
    this.saveLastSlots();
    this.renderSlotList();
    this.renderSlotOverlays();
    this.setStatus(overlapSlot
      ? `${name} 등록 완료. 단, ${overlapSlot.name} 영역과 겹칩니다. OCR이 흔들리면 더 확대해서 다시 잡아주세요.`
      : `${name} 등록 완료. 분석 시작을 누르면 이 영역의 숫자를 읽어서 게임 모드 안에 표시합니다.`);
  }

  renderSlotList() {
    this.elements.slotList.innerHTML = '';
    this.slots.forEach((slot) => {
      const item = document.createElement('div');
      const isCooling = slot.remainingSeconds > 0;
      const progress = slot.lastReadSeconds > 0
        ? clamp((slot.remainingSeconds / slot.lastReadSeconds) * 100, 0, 100)
        : 0;
      const slotName = escapeHtml(slot.name);
      item.className = `skill-slot-item${slot.alarmed ? ' ready' : ''}`;
      item.innerHTML = `
        <div class="skill-slot-topline">
          <strong>${slotName}</strong>
          <span class="skill-slot-time ${slot.alarmed ? 'ready' : isCooling ? 'cooling' : ''}">
            ${slot.alarmed ? '준비됨' : isCooling ? formatTime(slot.remainingSeconds) : '대기'}
          </span>
        </div>
        <div class="skill-slot-bar">
          <div style="width: ${progress}%"></div>
        </div>
        <span>OCR: ${slot.lastReadText || '-'}${slot.ignoredReadText ? ` · 무시 ${slot.ignoredReadText}` : ''} · 최대 ${slot.maxSeconds}초</span>
        <button class="slot-alarm-btn ${slot.alarmHandle.isAlarmPlaying ? 'active' : ''} ${slot.alarmed || slot.alarmHandle.isAlarmPlaying ? '' : 'hidden'}" type="button" data-slot-alarm="${slot.id}">
          ${slot.alarmHandle.isAlarmPlaying ? '알람 끄기' : '준비 표시 해제'}
        </button>
        <button class="slot-remove-btn" type="button" data-slot-remove="${slot.id}">삭제</button>
      `;
      this.elements.slotList.appendChild(item);
    });
  }

  renderSlotOverlays() {
    this.elements.slotLayer.innerHTML = '';
    if (!this.elements.video.videoWidth || !this.elements.video.videoHeight) return;

    const videoRect = this.getVideoDisplayRect();
    const surfaceRect = this.elements.zoomSurface.getBoundingClientRect();
    const scaleX = videoRect.width / this.elements.video.videoWidth;
    const scaleY = videoRect.height / this.elements.video.videoHeight;
    this.slots.forEach((slot) => {
      const box = document.createElement('div');
      box.className = `game-slot-box${slot.remainingSeconds > 0 ? ' detected' : ''}`;
      box.style.left = `${videoRect.left - surfaceRect.left + slot.rect.x * scaleX}px`;
      box.style.top = `${videoRect.top - surfaceRect.top + slot.rect.y * scaleY}px`;
      box.style.width = `${slot.rect.width * scaleX}px`;
      box.style.height = `${slot.rect.height * scaleY}px`;
      box.innerHTML = `<span class="game-slot-label">${escapeHtml(slot.name)}</span>`;
      this.elements.slotLayer.appendChild(box);
    });
  }

  handleSlotListClick(event) {
    const alarmButton = event.target.closest('[data-slot-alarm]');
    if (alarmButton) {
      const slot = this.slots.find((item) => item.id === alarmButton.dataset.slotAlarm);
      if (slot) this.clearSlotAlarm(slot);
      return;
    }

    const removeButton = event.target.closest('[data-slot-remove]');
    if (!removeButton) return;

    const slot = this.slots.find((item) => item.id === removeButton.dataset.slotRemove);
    if (slot) this.alarmService.stop(slot.alarmHandle);
    this.slots = this.slots.filter((item) => item.id !== removeButton.dataset.slotRemove);
    this.saveLastSlots();
    this.renderSlotList();
    this.renderSlotOverlays();
  }

  triggerSlotAlarm(slot) {
    if (slot.alarmed) return;
    slot.alarmed = true;
    this.alarmService.play(slot.alarmHandle);
    this.setStatus(`${slot.name} 쿨타임 완료!`);
    setTimeout(() => {
      this.alarmService.stop(slot.alarmHandle);
      this.renderSlotList();
    }, 3000);
  }

  clearSlotAlarm(slot) {
    this.alarmService.stop(slot.alarmHandle);
    slot.alarmed = false;
    this.renderSlotList();
    this.renderSlotOverlays();
  }

  async ensureOcrWorker() {
    if (this.ocrReady && this.ocrWorker) return true;
    if (typeof Tesseract === 'undefined') return false;
    this.setStatus('OCR 엔진을 준비하는 중입니다. 처음 한 번만 조금 걸릴 수 있습니다.');
    this.ocrWorker = await Tesseract.createWorker('eng');
    await this.ocrWorker.setParameters({
      tessedit_char_whitelist: '0123456789:：mMsS분초 ',
      tessedit_pageseg_mode: '7',
      preserve_interword_spaces: '1',
    });
    this.ocrReady = true;
    return true;
  }

  async startAnalysis() {
    if (!this.stream || this.slots.length === 0) {
      this.setStatus('먼저 게임 화면을 선택하고 스킬칸을 하나 이상 등록하세요.');
      return;
    }

    try {
      if (!(await this.ensureOcrWorker())) {
        this.setStatus('OCR 엔진을 불러오지 못했습니다. 인터넷 연결 후 새로고침하거나 Tesseract 스크립트를 확인하세요.');
        return;
      }
    } catch (error) {
      this.setStatus('OCR 엔진 초기화에 실패했습니다. 인터넷 연결 후 새로고침해 주세요.');
      return;
    }

    if (this.analysisInterval) return;
    this.elements.analyzeButton.textContent = '분석 중지';
    this.elements.analyzeButton.classList.add('active');
    this.setStatus('OCR 분석 중입니다. 등록한 영역에 보이는 숫자를 읽어서 쿨타임을 갱신합니다.');
    this.startCountdown();
    this.analyzeFrame();
    this.analysisInterval = setInterval(() => this.analyzeFrame(), 250);
  }

  stopAnalysis() {
    if (this.analysisInterval) {
      clearInterval(this.analysisInterval);
      this.analysisInterval = null;
    }
    this.elements.analyzeButton.textContent = '분석 시작';
    this.elements.analyzeButton.classList.remove('active');
  }

  toggleAnalysis() {
    if (this.analysisInterval) {
      this.stopAnalysis();
      this.setStatus('분석을 중지했습니다.');
    } else {
      this.startAnalysis();
    }
  }

  analyzeFrame() {
    if (!this.elements.video.videoWidth || this.slots.length === 0 || this.ocrBusy) return;

    this.analysisCanvas.width = this.elements.video.videoWidth;
    this.analysisCanvas.height = this.elements.video.videoHeight;
    this.analysisContext.drawImage(this.elements.video, 0, 0);

    const now = Date.now();
    const ocrInterval = clamp(parseInt(this.elements.ocrIntervalInput.value, 10) || 900, 500, 3000);
    const slot = this.slots.find((item) => (
      !item.ocrPending
      && !item.cooldownLocked
      && now - item.lastOcrAt >= ocrInterval
    ));
    if (!slot) return;

    this.readCooldownNumber(slot);
    this.renderSlotOverlays();
  }

  buildOcrCanvas(slot) {
    const insetX = Math.round(slot.rect.width * 0.12);
    const insetY = Math.round(slot.rect.height * 0.14);
    const sourceX = Math.max(0, slot.rect.x + insetX);
    const sourceY = Math.max(0, slot.rect.y + insetY);
    const sourceWidth = Math.max(1, Math.min(this.analysisCanvas.width - sourceX, slot.rect.width - insetX * 2));
    const sourceHeight = Math.max(1, Math.min(this.analysisCanvas.height - sourceY, slot.rect.height - insetY * 2));
    const scale = 5;

    this.ocrCanvas.width = sourceWidth * scale;
    this.ocrCanvas.height = sourceHeight * scale;
    this.ocrContext.imageSmoothingEnabled = false;
    this.ocrContext.drawImage(
      this.analysisCanvas,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      this.ocrCanvas.width,
      this.ocrCanvas.height
    );

    const imageData = this.ocrContext.getImageData(0, 0, this.ocrCanvas.width, this.ocrCanvas.height);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const brightness = (r + g + b) / 3;
      const isCooldownDigit = brightness > 165 || (r > 150 && g > 120 && b < 95);
      const value = isCooldownDigit ? 255 : 0;
      data[i] = value;
      data[i + 1] = value;
      data[i + 2] = value;
      data[i + 3] = 255;
    }
    this.ocrContext.putImageData(imageData, 0, 0);
    return this.ocrCanvas;
  }

  parseCooldownText(rawText, maxSeconds) {
    return window.CooldownParser.parseCooldownText(rawText, maxSeconds);
  }

  expectedRemaining(slot, now = Date.now()) {
    if (!slot.lastSeenAt || slot.lastReadSeconds <= 0) return 0;
    const elapsed = Math.floor((now - slot.lastSeenAt) / 1000);
    return Math.max(0, slot.lastReadSeconds - elapsed);
  }

  isPlausibleRead(slot, seconds, now = Date.now()) {
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > slot.maxSeconds) return false;
    if (String(seconds).length > String(slot.maxSeconds).length) return false;
    const expected = this.expectedRemaining(slot, now);
    if (expected <= 0) return true;

    const nearExpected = Math.abs(seconds - expected) <= 3;
    const looksLikeNewCooldown = seconds >= Math.max(1, Math.floor(slot.maxSeconds * 0.7));
    const repeatedCorrection = slot.candidateSeconds === seconds && slot.candidateCount >= 1;
    return nearExpected || looksLikeNewCooldown || repeatedCorrection;
  }

  confirmRead(slot, seconds) {
    const expected = this.expectedRemaining(slot);
    if (expected > 0 && Math.abs(seconds - expected) <= 3) return true;

    if (slot.candidateSeconds === seconds) {
      slot.candidateCount += 1;
    } else {
      slot.candidateSeconds = seconds;
      slot.candidateCount = 1;
    }

    if (expected <= 0) {
      return window.CooldownParser.shouldConfirmInitialRead(seconds, slot.maxSeconds) || slot.candidateCount >= 2;
    }

    if (seconds >= Math.max(1, Math.floor(slot.maxSeconds * 0.7))) return true;
    return slot.candidateCount >= 2;
  }

  acceptRead(slot, seconds, displayText) {
    slot.lastReadText = escapeHtml(displayText || String(seconds));
    slot.ignoredReadText = '';
    slot.remainingSeconds = seconds;
    slot.lastReadSeconds = seconds;
    slot.lastSeenAt = Date.now();
    slot.cooldownLocked = true;
    slot.acceptedReads += 1;
    slot.candidateSeconds = null;
    slot.candidateCount = 0;
    slot.alarmed = false;
    this.alarmService.stop(slot.alarmHandle);
    this.setStatus(`${slot.name} 숫자 감지: ${seconds}초`);
  }

  async readCooldownNumber(slot) {
    slot.ocrPending = true;
    slot.lastOcrAt = Date.now();
    this.ocrBusy = true;
    try {
      const result = await this.ocrWorker.recognize(this.buildOcrCanvas(slot));
      const rawText = result.data.text || '';
      const displayText = rawText.trim().replace(/\s+/g, ' ');
      const seconds = this.parseCooldownText(rawText, slot.maxSeconds);

      if (seconds !== null && this.isPlausibleRead(slot, seconds)) {
        if (this.confirmRead(slot, seconds)) {
          this.acceptRead(slot, seconds, displayText);
        } else {
          slot.ignoredReadText = escapeHtml(`${displayText || seconds} 확인중`);
        }
      } else if (displayText) {
        slot.ignoredReadText = escapeHtml(displayText);
        slot.candidateSeconds = null;
        slot.candidateCount = 0;
      } else if (slot.remainingSeconds <= 0) {
        slot.lastReadSeconds = 0;
        slot.ignoredReadText = '';
      }
    } catch (error) {
      this.setStatus('OCR 읽기 중 오류가 났습니다. 영역을 숫자에 더 가깝게 다시 잡아보세요.');
    } finally {
      slot.ocrPending = false;
      this.ocrBusy = false;
      this.renderSlotList();
      this.renderSlotOverlays();
    }
  }

  startCountdown() {
    if (this.countdownInterval) return;
    this.countdownInterval = setInterval(() => {
      const now = Date.now();
      let changed = false;
      this.slots.forEach((slot) => {
        if (slot.remainingSeconds <= 0 || !slot.lastSeenAt) return;
        const nextRemaining = Math.max(0, slot.lastReadSeconds - Math.floor((now - slot.lastSeenAt) / 1000));
        if (nextRemaining !== slot.remainingSeconds) {
          slot.remainingSeconds = nextRemaining;
          changed = true;
        }
        if (slot.remainingSeconds === 0) {
          slot.lastReadSeconds = 0;
          slot.lastSeenAt = 0;
          slot.cooldownLocked = false;
          slot.candidateSeconds = null;
          slot.candidateCount = 0;
          this.triggerSlotAlarm(slot);
        }
      });
      if (changed) {
        this.renderSlotList();
        this.renderSlotOverlays();
      }
    }, 250);
  }

  stopCountdown() {
    if (!this.countdownInterval) return;
    clearInterval(this.countdownInterval);
    this.countdownInterval = null;
  }

  startRecording() {
    if (!this.stream) {
      this.setStatus('먼저 게임 화면을 선택하세요.');
      return;
    }
    if (typeof MediaRecorder === 'undefined') {
      this.setStatus('이 브라우저에서는 화면 녹화를 사용할 수 없습니다.');
      return;
    }
    if (this.recordingUrl) URL.revokeObjectURL(this.recordingUrl);
    this.recordedChunks = [];
    this.keepRecording = true;
    const options = MediaRecorder.isTypeSupported('video/webm') ? { mimeType: 'video/webm' } : undefined;
    this.mediaRecorder = new MediaRecorder(this.stream, options);
    this.mediaRecorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) this.recordedChunks.push(event.data);
    });
    this.mediaRecorder.addEventListener('stop', () => {
      if (!this.keepRecording) return;
      const blob = new Blob(this.recordedChunks, { type: 'video/webm' });
      this.recordingUrl = URL.createObjectURL(blob);
      this.elements.downloadRecordingButton.classList.remove('hidden');
      this.setStatus('녹화가 준비되었습니다. 녹화 저장을 누르면 WebM 파일로 저장됩니다.');
    });
    this.mediaRecorder.start();
    this.elements.recordButton.textContent = '녹화 중지';
    this.elements.recordButton.classList.add('active');
    this.setStatus('녹화 중입니다.');
  }

  stopRecording(keepRecording = true) {
    this.keepRecording = keepRecording;
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') this.mediaRecorder.stop();
    if (!keepRecording) {
      this.recordedChunks = [];
      this.elements.downloadRecordingButton.classList.add('hidden');
    }
    this.mediaRecorder = null;
    this.elements.recordButton.textContent = '녹화 시작';
    this.elements.recordButton.classList.remove('active');
  }

  toggleRecording() {
    if (this.mediaRecorder?.state === 'recording') {
      this.stopRecording(true);
    } else {
      this.startRecording();
    }
  }

  downloadRecording() {
    if (!this.recordingUrl) return;
    const link = document.createElement('a');
    link.href = this.recordingUrl;
    link.download = `maple-cooldown-recording-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`;
    link.click();
  }
}

// ===== App Composition =====
class App {
  constructor() {
    this.alarmService = new AlarmService();
    this.timerManager = new TimerManager({
      grid: qs('#timersGrid'),
      addButton: qs('#addTimerBtn'),
    }, this.alarmService);
    this.captureMode = new ScreenCaptureMode({
      openButton: qs('#captureModeBtn'),
      overlay: qs('#captureOverlay'),
      stage: qs('#captureStage'),
      video: qs('#captureVideo'),
      selection: qs('#captureSelection'),
      closeButton: qs('#captureCloseBtn'),
      result: qs('#captureResult'),
      preview: qs('#capturePreview'),
      resultCloseButton: qs('#captureResultClose'),
      downloadButton: qs('#captureDownloadBtn'),
      copyButton: qs('#captureCopyBtn'),
    });
    this.gameMode = new GameCooldownMode({
      openButton: qs('#gameModeBtn'),
      overlay: qs('#gameOverlay'),
      closeButton: qs('#gameCloseBtn'),
      stage: qs('#gameStage'),
      zoomSurface: qs('#gameZoomSurface'),
      video: qs('#gameVideo'),
      slotLayer: qs('#gameSlotLayer'),
      selection: qs('#gameSelection'),
      stageHint: qs('#gameStageHint'),
      skillNameInput: qs('#skillNameInput'),
      maxSecondsInput: qs('#skillCooldownInput'),
      ocrIntervalInput: qs('#cooldownSensitivityInput'),
      zoomInput: qs('#gameZoomInput'),
      addSlotButton: qs('#addSkillSlotBtn'),
      analyzeButton: qs('#analyzeToggleBtn'),
      recordButton: qs('#recordToggleBtn'),
      downloadRecordingButton: qs('#downloadRecordingBtn'),
      clearSavedButton: qs('#clearSavedSlotsBtn'),
      presetNameInput: qs('#presetNameInput'),
      presetSelect: qs('#presetSelect'),
      savePresetButton: qs('#savePresetBtn'),
      loadPresetButton: qs('#loadPresetBtn'),
      deletePresetButton: qs('#deletePresetBtn'),
      status: qs('#gameStatus'),
      slotList: qs('#skillSlotList'),
    }, this.alarmService, new GameSlotStorage(
      'timerweb.gameCooldownSlots.v1',
      'timerweb.gameCooldownPresets.v1'
    ));
  }

  init() {
    this.timerManager.init();
    this.captureMode.init();
    this.gameMode.init();
    document.addEventListener('keydown', (event) => this.handleKeydown(event));
  }

  handleKeydown(event) {
    if (event.key === 'Escape') {
      if (this.captureMode.isOpen) this.captureMode.stop();
      if (!qs('#captureResult').classList.contains('hidden')) this.captureMode.closeResult();
      if (this.gameMode.isOpen) this.gameMode.stop();
      return;
    }

    if (this.captureMode.isOpen || this.gameMode.isOpen) return;
    this.timerManager.handleGlobalKey(event);
  }
}

new App().init();
