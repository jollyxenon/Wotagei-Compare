/**
 * 音频波形提取与能量自相关 BPM 检测纯函数算法
 * 本文件只包含与 DOM 无关的纯计算，可被 Node 端 verify 脚本直接验证；
 * 依赖 window/FileReader 等浏览器环境的解码入口位于 audio-dom.ts。
 */

import { DEFAULT_BPM } from '../types/timeline.ts';

/**
 * 提取归一化音频波形峰值数据，供 UI Canvas 快速绘制
 * @param channelData 单声道 PCM 数据 (-1.0 ~ 1.0)
 * @param targetLength 提取的波形点数 (默认 1000)
 */
export function extractAudioWaveform(
  channelData: Float32Array,
  targetLength = 1000
): Float32Array {
  const result = new Float32Array(targetLength);
  if (channelData.length === 0) return result;

  const blockSize = Math.floor(channelData.length / targetLength);
  if (blockSize <= 0) {
    for (let i = 0; i < Math.min(channelData.length, targetLength); i++) {
      result[i] = Math.abs(channelData[i]);
    }
    return result;
  }

  for (let i = 0; i < targetLength; i++) {
    const start = i * blockSize;
    const end = Math.min(start + blockSize, channelData.length);
    let max = 0;
    for (let j = start; j < end; j++) {
      const val = Math.abs(channelData[j]);
      if (val > max) max = val;
    }
    result[i] = max;
  }

  return result;
}

/**
 * 基于 WOTA 艺常用节拍速度 (150 ~ 190 BPM) 的对数正态先验加权函数
 * 中心设在 168 BPM，标准差 sigma = 0.35
 */
export function calculateTempoPriorWeight(bpm: number): number {
  if (bpm <= 0) return 0;
  const centerBpm = 168;
  const sigma = 0.35;
  const logRatio = Math.log2(bpm / centerBpm);
  return Math.exp(-(logRatio * logRatio) / (2 * sigma * sigma));
}

/**
 * 按音频采样率自适应计算约 4ms (~250Hz) 的精细能量包络 Hop 步长
 */
export function getAudioHopSize(sampleRate: number): number {
  if (!sampleRate || sampleRate <= 0) return 176;
  return Math.max(32, Math.round(sampleRate / 250));
}

/**
 * 基于高分辨率能量起音包络、WOTA 速度先验与多拍谐波梳状自相关自动测算音轨 BPM
 * 适用于流行乐、电子乐与动漫歌曲 (WOTA 艺常用 120 ~ 220 BPM)
 * @param channelData 单声道 Float32 PCM 数据
 * @param sampleRate 采样率 (如 44100、48000 或原生流式降采样 16000)
 * @param maxScanSeconds 最大分析时长（秒，默认无限制；导入超长大音频时建议传 60）
 * @returns 测算出的整数 BPM
 */
export function detectBpmFromPcm(
  channelData: Float32Array,
  sampleRate: number,
  maxScanSeconds?: number
): number {
  const scanSamples =
    typeof maxScanSeconds === 'number' && maxScanSeconds > 0
      ? Math.min(channelData.length, Math.floor(maxScanSeconds * sampleRate))
      : channelData.length;

  const hopSize = getAudioHopSize(sampleRate);
  const winSize = Math.max(hopSize, Math.round(sampleRate / 100)); // ~10ms 重叠 RMS 窗

  if (!channelData || scanSamples < sampleRate || scanSamples < winSize + hopSize * 10) {
    // 音频过短不足 1 秒，返回默认典型占位 BPM
    return DEFAULT_BPM;
  }

  // 1. 提取高分辨率 (~250Hz / ~4ms) 局部 RMS 能量包络，避免粗网格量化阶跃
  const envelopeLength = Math.floor((scanSamples - winSize) / hopSize) + 1;
  const envelope = new Float32Array(envelopeLength);

  for (let i = 0; i < envelopeLength; i++) {
    const offset = i * hopSize;
    let sum = 0;
    for (let j = 0; j < winSize; j++) {
      const val = channelData[offset + j];
      sum += val * val;
    }
    envelope[i] = Math.sqrt(sum / winSize);
  }

  // 2. 一阶正差分起音包络并去均值，抑制直流背景拖尾
  const onsets = new Float32Array(envelopeLength);
  let onsetMean = 0;
  for (let i = 1; i < envelopeLength; i++) {
    const diff = envelope[i] - envelope[i - 1];
    const positive = diff > 0 ? diff : 0;
    onsets[i] = positive;
    onsetMean += positive;
  }
  onsetMean /= envelopeLength;
  for (let i = 0; i < envelopeLength; i++) {
    onsets[i] -= onsetMean;
  }

  // 3. 多拍周期谐波梳状自相关 (1T/2T/4T/8T/16T) + WOTA 速度先验评分
  const envelopeSampleRate = sampleRate / hopSize;
  const minBpm = 80;
  const maxBpm = 220;
  const minOverlapHops = Math.min(
    Math.floor(envelopeSampleRate * 1.5),
    Math.floor(envelopeLength * 0.45)
  );
  const maxSafeLag = envelopeLength - minOverlapHops;

  const acCache = new Map<number, number>();
  const evaluateIntLag = (lag: number): number => {
    if (lag < 1 || lag >= envelopeLength) return 0;
    const cached = acCache.get(lag);
    if (cached !== undefined) return cached;
    const count = envelopeLength - lag;
    if (count < minOverlapHops) return 0;
    let sum = 0;
    for (let i = 0; i < count; i++) {
      sum += onsets[i] * onsets[i + lag];
    }
    const corr = sum / count;
    acCache.set(lag, corr);
    return corr;
  };

  const evaluateContinuousLag = (lagFloat: number): number => {
    const l0 = Math.floor(lagFloat);
    if (l0 < 1 || l0 + 1 >= envelopeLength) return 0;
    const frac = lagFloat - l0;
    return (1 - frac) * evaluateIntLag(l0) + frac * evaluateIntLag(l0 + 1);
  };

  const combMultipliers = [1, 2, 4, 8, 16];
  const combWeights = [1.0, 0.9, 0.9, 0.85, 0.7];

  const scoreCandidateBpm = (bpm: number): number => {
    const beatPeriodHops = (60 * envelopeSampleRate) / bpm;
    let combSum = 0;
    let weightSum = 0;
    for (let m = 0; m < combMultipliers.length; m++) {
      const lagFloat = beatPeriodHops * combMultipliers[m];
      if (lagFloat >= maxSafeLag) break;
      combSum += evaluateContinuousLag(lagFloat) * combWeights[m];
      weightSum += combWeights[m];
    }
    if (weightSum <= 0) return -Infinity;
    return (combSum / weightSum) * calculateTempoPriorWeight(bpm);
  };

  // 3.1 全域粗扫描（步长 0.5 BPM）
  let bestBpm = DEFAULT_BPM;
  let bestScore = -Infinity;
  for (let bpm = minBpm; bpm <= maxBpm; bpm += 0.5) {
    const score = scoreCandidateBpm(bpm);
    if (score > bestScore) {
      bestScore = score;
      bestBpm = bpm;
    }
  }

  if (bestScore === -Infinity) return DEFAULT_BPM;

  // 4. 谐波共振校验：若粗峰落入 95~125 BPM (常见 1.5 拍亚谐波)，复核其 1.5 倍频
  if (bestBpm >= 95 && bestBpm <= 125) {
    const target15x = bestBpm * 1.5;
    let best15xBpm = target15x;
    let best15xScore = -Infinity;
    for (
      let bpm = Math.max(minBpm, target15x - 3);
      bpm <= Math.min(maxBpm, target15x + 3);
      bpm += 0.5
    ) {
      const score = scoreCandidateBpm(bpm);
      if (score > best15xScore) {
        best15xScore = score;
        best15xBpm = bpm;
      }
    }
    if (best15xScore >= bestScore * 0.45) {
      bestBpm = best15xBpm;
      bestScore = best15xScore;
    }
  }

  // 5. 二级与三级亚网格精密搜索（0.25 BPM -> 0.05 BPM）锁定真实整数速度
  let midBpm = bestBpm;
  let midScore = bestScore;
  for (
    let bpm = Math.max(minBpm, bestBpm - 1.5);
    bpm <= Math.min(maxBpm, bestBpm + 1.5);
    bpm += 0.25
  ) {
    const score = scoreCandidateBpm(bpm);
    if (score > midScore) {
      midScore = score;
      midBpm = bpm;
    }
  }

  let calculatedBpm = midBpm;
  let fineScore = midScore;
  for (
    let bpm = Math.max(minBpm, midBpm - 0.5);
    bpm <= Math.min(maxBpm, midBpm + 0.5);
    bpm += 0.05
  ) {
    const score = scoreCandidateBpm(bpm);
    if (score > fineScore) {
      fineScore = score;
      calculatedBpm = bpm;
    }
  }

  // 6. 倍频折叠兜底（去先验比较）：粗峰 < 100 BPM 时与 2 倍频候选比较
  // 「纯梳状自相关得分」（剔除 WOTA 速度先验权重）。若直接比较混合得分，
  // 168 中心先验在 95/190 处的权重差约 14 倍，会淹没原始自相关的判断，
  // 使真实慢速曲目（如 90 BPM 抒情曲）依然必被折叠成 180。
  // 去先验后：真实慢速曲目在 1T 与 2T 处自相关接近持平（严格 > 不折叠）；
  // 半频误检（真 168 被粗扫判为 84）的 2T 峰值通常高于 1T，正确折叠。
  if (calculatedBpm < 100) {
    const rawScore = (bpm: number) => {
      const prior = calculateTempoPriorWeight(bpm);
      return prior > 0 ? scoreCandidateBpm(bpm) / prior : scoreCandidateBpm(bpm);
    };
    const doubledBpm = Math.min(maxBpm, calculatedBpm * 2);
    if (rawScore(doubledBpm) > rawScore(calculatedBpm)) {
      calculatedBpm = doubledBpm;
    }
  } else if (calculatedBpm > 220) {
    calculatedBpm /= 2;
  }

  return Math.round(calculatedBpm);
}

/**
 * 基于指定时间窗口 [startSec, endSec] 的 PCM 切片测算局部 BPM
 * @param pcm 单声道 Float32 PCM 数据
 * @param sampleRate 采样率 (Hz)
 * @param startSec 起始时间戳 (秒)
 * @param endSec 结束时间戳 (秒)
 * @param fallbackBpm 切片过短（< 2.0s）时的保底/当前 BPM（默认 DEFAULT_BPM）
 */
export function detectBpmFromSlice(
  pcm: Float32Array,
  sampleRate: number,
  startSec: number,
  endSec: number,
  fallbackBpm = DEFAULT_BPM
): number {
  if (!pcm || pcm.length === 0 || sampleRate <= 0) return fallbackBpm;

  const validStart = Math.max(0, Math.min(startSec, endSec));
  const validEnd = Math.max(startSec, endSec);

  // 严格按 hopSize 整数倍将截取采样点对齐到全局 Hop 网格
  // 确保不管用户如何毫秒级微调起止点，局部切片内的鼓点瞬态（Transient）相对于块边界的相位绝对固定
  // 彻底根除鼓点冲击被切块边界削顶切分导致的能量泄漏与跳变
  const hopSize = getAudioHopSize(sampleRate);
  const alignedStart = Math.max(0, Math.floor((validStart * sampleRate) / hopSize) * hopSize);
  const alignedEnd = Math.min(pcm.length, Math.ceil((validEnd * sampleRate) / hopSize) * hopSize);

  // 截取区间不足 2.0 秒时返回 fallbackBpm，避免虚假推断
  if (alignedEnd - alignedStart < sampleRate * 2.0) {
    return fallbackBpm;
  }

  const slice = pcm.subarray(alignedStart, alignedEnd);
  // 切片计算严格闭环在区间内部，不设向后截断限制
  return detectBpmFromPcm(slice, sampleRate);
}

/**
 * Tap Tempo 连续点击屏幕测速器
 */
export class TapTempoTracker {
  private taps: number[] = [];
  private readonly maxTaps: number = 8;
  private readonly resetTimeoutMs: number = 2500;

  /**
   * 记录一次点击并返回当前估算的整数 BPM (点击次数不足时返回 null)
   */
  public tap(): number | null {
    const now = performance.now();

    if (this.taps.length > 0 && now - this.taps[this.taps.length - 1] > this.resetTimeoutMs) {
      // 距离上次点击超过 2.5 秒，开启新一轮测速
      this.taps = [now];
      return null;
    }

    this.taps.push(now);
    if (this.taps.length > this.maxTaps) {
      this.taps.shift();
    }

    if (this.taps.length < 2) {
      return null;
    }

    // 计算相邻点击间隔
    const intervals: number[] = [];
    for (let i = 1; i < this.taps.length; i++) {
      intervals.push(this.taps[i] - this.taps[i - 1]);
    }

    // 排序后剔除边缘极值
    if (intervals.length >= 4) {
      intervals.sort((a, b) => a - b);
      intervals.pop();
      intervals.shift();
    }

    const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    if (avgInterval <= 0) return null;

    const bpm = Math.round(60000 / avgInterval);
    return Math.max(40, Math.min(300, bpm));
  }

  public reset(): void {
    this.taps = [];
  }
}
