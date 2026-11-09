const FREQUENCIES = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const PRESETS = {
  Normal: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  Rock: [5, 4, 3, 1, -1, 0, 2, 3, 4, 5],
  Pop: [-1, 2, 4, 5, 3, 0, -1, -1, 2, 3],
  Classical: [4, 3, 2, 1, -1, -1, 0, 2, 3, 4],
  Jazz: [4, 3, 1, 2, -2, -2, 0, 2, 4, 5],
  Electronic: [5, 4, 1, 0, -2, 2, 1, 2, 4, 5],
  'Bass Boost': [8, 7, 5, 2, 0, 0, 0, 0, 0, 0]
};

export class AudioEngine {
  constructor(audio) {
    this.audio = audio;
    this.context = null;
    this.filters = [];
    this.analyser = null;
    this.enabled = false;
    this.bands = [...PRESETS.Normal];
    this.bass = 0;
    this.treble = 0;
  }

  async initialize() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) throw new Error('Web Audio is not supported in this browser.');
    if (!this.context) {
      this.context = new AudioContext();
      this.source = this.context.createMediaElementSource(this.audio);
      this.filters = FREQUENCIES.map((frequency, index) => {
        const filter = this.context.createBiquadFilter();
        filter.type = index === 0 ? 'lowshelf' : index === FREQUENCIES.length - 1 ? 'highshelf' : 'peaking';
        filter.frequency.value = frequency;
        filter.Q.value = index === 0 || index === FREQUENCIES.length - 1 ? 0.7 : 1;
        return filter;
      });
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 128;
      this.source.connect(this.filters[0]);
      this.filters.slice(1).forEach((filter, index) => this.filters[index].connect(filter));
      this.filters.at(-1).connect(this.analyser);
      this.analyser.connect(this.context.destination);
    }
    await this.context.resume();
    this.enabled = true;
  }

  applyPreset(name, bands = PRESETS[name]) {
    if (!bands || !this.filters.length) return;
    this.bands = bands.map(value => Math.max(-12, Math.min(12, value ?? 0)));
    this.applyGains();
  }

  setBand(index, gain) {
    if (this.filters[index]) {
      this.bands[index] = Number(gain);
      this.applyGains();
    }
  }

  setBass(enabled) {
    this.bass = enabled ? 5 : 0;
    this.applyGains();
  }

  setTreble(enabled) {
    this.treble = enabled ? 3 : 0;
    this.applyGains();
  }

  applyGains() {
    this.filters.forEach((filter, index) => {
      filter.gain.value = this.bands[index] + (index === 0 ? this.bass : 0) + (index === 9 ? this.treble : 0);
    });
  }

  getFrequencies() {
    if (!this.analyser) return null;
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(data);
    return data;
  }
  static get presets() { return PRESETS; }
  static get frequencies() { return FREQUENCIES; }
}
