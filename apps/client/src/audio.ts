import type { CardSymbol } from "@rps/game-core";

const AUDIO_SETTINGS_KEY = "rps-audio-settings-v1";
const MUSIC_URL = "/audio/claimed-by-the-void-loop.mp3";

interface AudioSettings {
  music: number;
  sfx: number;
  muted: boolean;
}

const DEFAULT_SETTINGS: AudioSettings = {
  music: 0.16,
  sfx: 0.55,
  muted: false
};

const SYMBOL_INDEX: Record<CardSymbol, number> = {
  rock: 0,
  paper: 1,
  scissors: 2
};

function clampVolume(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

function readSettings(): AudioSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(AUDIO_SETTINGS_KEY) ?? "null") as Partial<AudioSettings> | null;
    if (!saved) return { ...DEFAULT_SETTINGS };
    return {
      music: clampVolume(typeof saved.music === "number" ? saved.music : DEFAULT_SETTINGS.music),
      sfx: clampVolume(typeof saved.sfx === "number" ? saved.sfx : DEFAULT_SETTINGS.sfx),
      muted: typeof saved.muted === "boolean" ? saved.muted : DEFAULT_SETTINGS.muted
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export class GameAudio {
  private settings = readSettings();
  private context: AudioContext | null = null;
  private music: HTMLAudioElement | null = null;
  private unlocked = false;
  private panelOpen = false;

  constructor(private readonly controls: HTMLElement) {
    this.renderControls();
    document.addEventListener("pointerdown", this.unlockFromGesture, { capture: true });
    document.addEventListener("keydown", this.unlockFromGesture, { capture: true });
    document.addEventListener("click", this.playButtonClick, { capture: true });
    document.addEventListener("visibilitychange", () => {
      if (!this.music) return;
      if (document.hidden) this.music.pause();
      else if (this.unlocked && !this.settings.muted && this.settings.music > 0) void this.music.play().catch(() => undefined);
    });
  }

  playClash(left: CardSymbol, right: CardSymbol): void {
    const context = this.readyContext();
    if (!context || this.sfxLevel() <= 0) return;
    const now = context.currentTime + 0.015;
    const ordered = [left, right].sort((first, second) => SYMBOL_INDEX[first] - SYMBOL_INDEX[second]);
    const first = ordered[0]!;
    const second = ordered[1]!;
    const pairKey = `${first}:${second}`;
    const pairIndex = [
      "rock:rock",
      "rock:paper",
      "rock:scissors",
      "paper:paper",
      "paper:scissors",
      "scissors:scissors"
    ].indexOf(pairKey);

    this.playSymbolCue(first, now, 1.04);
    this.playSymbolCue(second, now + 0.085, 0.9);

    // A short signature tone makes all six unordered card pairings distinct.
    // Mirrored matchups such as Rock/Paper and Paper/Rock intentionally match.
    const signature = 230 + Math.max(pairIndex, 0) * 57;
    this.tone(signature, signature * 0.72, now + 0.155, 0.16, 0.12, "triangle");
  }

  playHeartTing(delayMs = 0, variation = 0): void {
    const context = this.readyContext();
    if (!context || this.sfxLevel() <= 0) return;
    const start = context.currentTime + Math.max(delayMs, 0) / 1_000;
    const frequency = 840 + (variation % 5) * 55;
    this.tone(frequency, frequency * 1.22, start, 0.16, 0.075, "sine");
  }

  playReveal(delayMs = 0): void {
    const context = this.readyContext();
    if (!context || this.sfxLevel() <= 0) return;
    const start = context.currentTime + Math.max(delayMs, 0) / 1_000;
    this.noise(start, 0.12, 1_400, "bandpass", 0.055);
    this.tone(310, 520, start + 0.025, 0.13, 0.05, "triangle");
  }

  playDraw(delayMs = 0): void {
    const context = this.readyContext();
    if (!context || this.sfxLevel() <= 0) return;
    const start = context.currentTime + Math.max(delayMs, 0) / 1_000;
    this.noise(start, 0.22, 1_050, "bandpass", 0.05);
    this.tone(260, 430, start + 0.12, 0.13, 0.045, "sine");
  }

  playCardPlace(): void {
    const context = this.readyContext();
    if (!context || this.sfxLevel() <= 0) return;
    const now = context.currentTime;
    this.noise(now, 0.09, 920, "lowpass", 0.07);
    this.tone(220, 165, now + 0.025, 0.1, 0.055, "triangle");
  }

  playDiscard(): void {
    const context = this.readyContext();
    if (!context || this.sfxLevel() <= 0) return;
    const now = context.currentTime;
    this.noise(now, 0.18, 780, "bandpass", 0.06);
    this.tone(360, 170, now + 0.03, 0.17, 0.045, "triangle");
  }

  playLock(): void {
    const context = this.readyContext();
    if (!context || this.sfxLevel() <= 0) return;
    const now = context.currentTime;
    this.tone(190, 145, now, 0.1, 0.09, "square");
    this.tone(380, 310, now + 0.065, 0.09, 0.055, "triangle");
  }

  playOutcome(kind: "win" | "loss" | "draw"): void {
    const context = this.readyContext();
    if (!context || this.sfxLevel() <= 0) return;
    const now = context.currentTime;
    const notes = kind === "win" ? [392, 523, 659] : kind === "loss" ? [330, 247, 196] : [330, 392, 330];
    notes.forEach((note, index) => this.tone(note, note, now + index * 0.13, 0.25, 0.08, "triangle"));
  }

  private readonly unlockFromGesture = (): void => {
    this.unlocked = true;
    const context = this.readyContext();
    if (context?.state === "suspended") void context.resume();
    this.ensureMusic();
    this.syncMusic();
  };

  private readonly playButtonClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest("button");
    if (!button || button.disabled || button.dataset.silentAudio !== undefined) return;
    const context = this.readyContext();
    if (!context || this.sfxLevel() <= 0) return;
    const now = context.currentTime;
    this.tone(520, 610, now, 0.055, 0.035, "sine");
  };

  private readyContext(): AudioContext | null {
    if (!this.unlocked) return null;
    this.context ??= new AudioContext();
    return this.context;
  }

  private ensureMusic(): void {
    if (this.music) return;
    const music = new Audio(MUSIC_URL);
    music.loop = true;
    music.preload = "none";
    this.music = music;
  }

  private syncMusic(): void {
    if (!this.music) return;
    this.music.volume = this.settings.muted ? 0 : this.settings.music;
    if (this.settings.muted || this.settings.music <= 0 || document.hidden) {
      this.music.pause();
      return;
    }
    if (this.unlocked) void this.music.play().catch(() => undefined);
  }

  private sfxLevel(): number {
    return this.settings.muted ? 0 : this.settings.sfx;
  }

  private tone(
    startFrequency: number,
    endFrequency: number,
    start: number,
    duration: number,
    gainAmount: number,
    type: OscillatorType
  ): void {
    const context = this.context;
    if (!context) return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(Math.max(startFrequency, 20), start);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(endFrequency, 20), start + duration);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(gainAmount * this.sfxLevel(), 0.0001), start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
  }

  private noise(
    start: number,
    duration: number,
    frequency: number,
    filterType: BiquadFilterType,
    gainAmount: number
  ): void {
    const context = this.context;
    if (!context) return;
    const frameCount = Math.max(Math.floor(context.sampleRate * duration), 1);
    const buffer = context.createBuffer(1, frameCount, context.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < frameCount; index += 1) channel[index] = Math.random() * 2 - 1;
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    source.buffer = buffer;
    filter.type = filterType;
    filter.frequency.setValueAtTime(frequency, start);
    filter.Q.setValueAtTime(2.2, start);
    gain.gain.setValueAtTime(Math.max(gainAmount * this.sfxLevel(), 0.0001), start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    source.connect(filter).connect(gain).connect(context.destination);
    source.start(start);
    source.stop(start + duration + 0.02);
  }

  private playSymbolCue(symbol: CardSymbol, start: number, pitch: number): void {
    if (symbol === "rock") {
      this.noise(start, 0.15, 170, "lowpass", 0.16);
      this.tone(145 * pitch, 62 * pitch, start, 0.18, 0.14, "sine");
      return;
    }
    if (symbol === "paper") {
      this.noise(start, 0.19, 1_650 * pitch, "bandpass", 0.1);
      this.tone(610 * pitch, 410 * pitch, start + 0.02, 0.13, 0.04, "sine");
      return;
    }
    this.tone(1_850 * pitch, 1_170 * pitch, start, 0.055, 0.085, "square");
    this.tone(2_350 * pitch, 1_480 * pitch, start + 0.065, 0.055, 0.075, "square");
  }

  private saveSettings(): void {
    try {
      localStorage.setItem(AUDIO_SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      // Audio still works when storage is unavailable (for example private mode).
    }
  }

  private renderControls(): void {
    const musicPercent = Math.round(this.settings.music * 100);
    const sfxPercent = Math.round(this.settings.sfx * 100);
    this.controls.innerHTML = `
      <button class="audio-toggle" type="button" aria-expanded="${this.panelOpen}" aria-controls="audio-panel" title="Audio settings" data-silent-audio>
        <span aria-hidden="true">${this.settings.muted ? "×" : "♫"}</span>
        <span class="sr-only">Audio settings</span>
      </button>
      <section id="audio-panel" class="audio-panel ${this.panelOpen ? "open" : ""}" aria-label="Audio settings">
        <div class="audio-panel-heading"><strong>AUDIO</strong><button type="button" data-audio-mute data-silent-audio>${this.settings.muted ? "UNMUTE" : "MUTE ALL"}</button></div>
        <label><span>MUSIC <b>${musicPercent}%</b></span><input type="range" min="0" max="100" value="${musicPercent}" data-audio-music aria-label="Music volume"></label>
        <label><span>SFX <b>${sfxPercent}%</b></span><input type="range" min="0" max="100" value="${sfxPercent}" data-audio-sfx aria-label="Sound effects volume"></label>
      </section>`;

    this.controls.querySelector<HTMLButtonElement>(".audio-toggle")?.addEventListener("click", () => {
      this.panelOpen = !this.panelOpen;
      this.renderControls();
    });
    this.controls.querySelector<HTMLButtonElement>("[data-audio-mute]")?.addEventListener("click", () => {
      this.settings.muted = !this.settings.muted;
      this.saveSettings();
      this.syncMusic();
      this.renderControls();
    });
    this.bindRange("[data-audio-music]", "music");
    this.bindRange("[data-audio-sfx]", "sfx");
  }

  private bindRange(selector: string, setting: "music" | "sfx"): void {
    this.controls.querySelector<HTMLInputElement>(selector)?.addEventListener("input", (event) => {
      const input = event.currentTarget as HTMLInputElement;
      this.settings[setting] = clampVolume(Number(input.value) / 100);
      this.settings.muted = false;
      input.closest("label")?.querySelector("b")?.replaceChildren(`${input.value}%`);
      this.saveSettings();
      this.syncMusic();
      const toggle = this.controls.querySelector<HTMLElement>(".audio-toggle > span");
      if (toggle) toggle.textContent = "♫";
      const mute = this.controls.querySelector<HTMLButtonElement>("[data-audio-mute]");
      if (mute) mute.textContent = "MUTE ALL";
    });
  }
}
