export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export interface SpatialAcousticProfile {
  roomDimensions: Vector3;
  reverbDecaySeconds: number;
  wetMix: number;
  earlyReflectionGain: number;
  sourcePosition: Vector3;
  listenerPosition: Vector3;
  occlusionCutoffHz: number;
  seed: number;
}

const clamp = (value: number, low: number, high: number) =>
  Math.min(Math.max(value, low), high);

export class AdaptiveAcousticSpaceEngine {
  private readonly context: AudioContext;
  private readonly input: GainNode;
  private readonly panner: PannerNode;
  private readonly occlusion: BiquadFilterNode;
  private readonly dry: GainNode;
  private readonly convolvers: [ConvolverNode, ConvolverNode];
  private readonly wet: [GainNode, GainNode];
  private activeIndex = 0;
  private profileKey = "";

  constructor(context: AudioContext) {
    this.context = context;
    this.input = context.createGain();
    this.occlusion = context.createBiquadFilter();
    this.occlusion.type = "lowpass";
    this.panner = new PannerNode(context, {
      panningModel: "HRTF",
      distanceModel: "inverse",
      refDistance: 1,
      maxDistance: 5000,
      rolloffFactor: 1.5,
    });
    this.dry = context.createGain();
    this.convolvers = [context.createConvolver(), context.createConvolver()];
    this.wet = [context.createGain(), context.createGain()];
    this.wet[0].gain.value = 0;
    this.wet[1].gain.value = 0;

    this.input.connect(this.occlusion).connect(this.panner);
    this.panner.connect(this.dry);
    this.panner.connect(this.convolvers[0]).connect(this.wet[0]);
    this.panner.connect(this.convolvers[1]).connect(this.wet[1]);
  }

  connectSource(source: AudioNode): void {
    source.connect(this.input);
  }

  connectOutput(destination: AudioNode): void {
    this.dry.connect(destination);
    this.wet[0].connect(destination);
    this.wet[1].connect(destination);
  }

  disconnect(): void {
    this.input.disconnect();
    this.dry.disconnect();
    this.convolvers.forEach((node) => node.disconnect());
    this.wet.forEach((node) => node.disconnect());
  }

  update(profile: SpatialAcousticProfile): void {
    const now = this.context.currentTime;
    const dimensions = {
      x: clamp(profile.roomDimensions.x, 1, 200),
      y: clamp(profile.roomDimensions.y, 1, 200),
      z: clamp(profile.roomDimensions.z, 1, 200),
    };
    const decay = clamp(profile.reverbDecaySeconds, 0.1, 15);
    const wetMix = clamp(profile.wetMix, 0, 1);
    const cutoff = clamp(
      profile.occlusionCutoffHz,
      20,
      Math.max(20, this.context.sampleRate / 2 - 100),
    );

    this.setVector(this.panner, profile.sourcePosition, now);
    this.setListener(profile.listenerPosition, now);
    this.occlusion.frequency.setTargetAtTime(cutoff, now, 0.03);
    this.dry.gain.setTargetAtTime(Math.cos(wetMix * Math.PI * 0.5), now, 0.04);

    const key = [
      decay.toFixed(2),
      dimensions.x.toFixed(1),
      dimensions.y.toFixed(1),
      dimensions.z.toFixed(1),
      Math.trunc(profile.seed),
    ].join(":");

    if (key !== this.profileKey) {
      this.crossfadeImpulse(decay, dimensions, wetMix, profile.seed);
      this.profileKey = key;
    } else {
      const activeWet = Math.sin(wetMix * Math.PI * 0.5);
      this.wet[this.activeIndex].gain.setTargetAtTime(activeWet, now, 0.04);
    }
  }

  private setVector(node: PannerNode, vector: Vector3, now: number): void {
    node.positionX.setTargetAtTime(vector.x, now, 0.05);
    node.positionY.setTargetAtTime(vector.y, now, 0.05);
    node.positionZ.setTargetAtTime(vector.z, now, 0.05);
  }

  private setListener(vector: Vector3, now: number): void {
    const listener = this.context.listener;
    listener.positionX.setTargetAtTime(vector.x, now, 0.05);
    listener.positionY.setTargetAtTime(vector.y, now, 0.05);
    listener.positionZ.setTargetAtTime(vector.z, now, 0.05);
  }

  private crossfadeImpulse(
    decay: number,
    dimensions: Vector3,
    wetMix: number,
    seed: number,
  ): void {
    const now = this.context.currentTime;
    const nextIndex = this.activeIndex === 0 ? 1 : 0;
    const nextWet = Math.sin(wetMix * Math.PI * 0.5);
    this.convolvers[nextIndex].buffer = this.createImpulse(decay, dimensions, seed);

    const incoming = this.wet[nextIndex].gain;
    const outgoing = this.wet[this.activeIndex].gain;
    incoming.cancelScheduledValues(now);
    outgoing.cancelScheduledValues(now);
    incoming.setValueAtTime(0, now);
    outgoing.setValueAtTime(outgoing.value, now);
    incoming.linearRampToValueAtTime(nextWet, now + 0.3);
    outgoing.linearRampToValueAtTime(0, now + 0.3);
    this.activeIndex = nextIndex;
  }

  private createImpulse(
    durationSeconds: number,
    dimensions: Vector3,
    initialSeed: number,
  ): AudioBuffer {
    const rate = this.context.sampleRate;
    const length = Math.max(1, Math.floor(rate * durationSeconds));
    const buffer = this.context.createBuffer(2, length, rate);
    const volume = dimensions.x * dimensions.y * dimensions.z;
    const roomScale = clamp(Math.cbrt(volume) / 10, 0.35, 4);
    let seed = (Math.trunc(initialSeed) ^ Math.trunc(volume)) >>> 0;

    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x100000000;
    };

    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const data = buffer.getChannelData(channel);
      for (let index = 0; index < length; index++) {
        const seconds = index / rate;
        const envelope = Math.exp((-6.91 * seconds) / (durationSeconds * roomScale));
        data[index] = (random() * 2 - 1) * envelope;
      }
    }
    return buffer;
  }
}
