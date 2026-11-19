/**
 * 依赖浏览器 DOM / fetch / WebAudio 的音频解码入口层
 * 与纯函数层 audio.ts 分离，保持核心算法可脱离浏览器验证。
 * 所有解码结果显式携带 hasAudioTrack / audioDegraded 标记：
 * 降级（文件超限、解码失败等）时 duration 返回 0 表示未知，
 * 由调用方优先采用视频元数据探测结果，UI 层可据 audioDegraded
 * 向用户明示“BPM 为占位值”，不再静默伪造数据。
 */

import { DEFAULT_BPM } from '../types/timeline.ts';
import { detectBpmFromPcm, extractAudioWaveform } from './audio.ts';

/** 音频解码结果统一契约 */
export interface DecodedAudioResult {
  hasAudioTrack: boolean;
  audioDegraded: boolean;
  duration: number; // 秒；0 表示未知（降级或解析失败），调用方应回退到视频元数据时长
  sampleRate: number;
  detectedBpm: number;
  waveform: Float32Array;
  rawChannelData: Float32Array; // 解码得到的单声道 PCM（降级时为空数组）
}

/** 构造显式标记的降级结果 */
function degradedAudioResult(reason: 'oversize' | 'decode-error'): DecodedAudioResult {
  // 不再伪造 duration=60 等假时长：0 = 未知，交由调用方用真实元数据兜底
  void reason;
  return {
    hasAudioTrack: false,
    audioDegraded: true,
    duration: 0,
    sampleRate: 44100,
    detectedBpm: DEFAULT_BPM,
    waveform: new Float32Array(1000).fill(0.2),
    rawChannelData: new Float32Array(0),
  };
}

/**
 * 跨老旧与现代内核安全读取文件的 ArrayBuffer (优先使用 file.arrayBuffer，老旧内核回退至 FileReader)
 */
export function readFileAsArrayBuffer(file: Blob | File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') {
    return file.arrayBuffer();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
      } else {
        reject(new Error('FileReader 读取二进制失败'));
      }
    };
    reader.onerror = () => reject(reader.error || new Error('FileReader 发生读取错误'));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * 跨老旧与现代内核安全解码音频数据 (兼容现代 Promise 与老旧 WebKit/Chromium 回调模式)
 */
export function safeDecodeAudioData(
  audioCtx: AudioContext,
  arrayBuffer: ArrayBuffer
): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    let hasResolved = false;
    const onSuccess = (buf: AudioBuffer) => {
      if (!hasResolved) {
        hasResolved = true;
        resolve(buf);
      }
    };
    const onError = (err: unknown) => {
      if (!hasResolved) {
        hasResolved = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };

    try {
      const res = audioCtx.decodeAudioData(arrayBuffer, onSuccess, onError);
      if (res && typeof res.then === 'function') {
        res.then(onSuccess).catch(onError);
      }
    } catch (e) {
      onError(e);
    }
  });
}

/**
 * 从本地视频/音频 File 对象中解码出单声道 PCM 数据并执行分析
 * 文件超过防 OOM 体积阈值时返回显式降级结果（audioDegraded = true）
 */
export async function decodeAudioFromFile(file: File): Promise<DecodedAudioResult> {
  // 防 OOM 熔断保护：移动端 WebView 限制 80MB 防止沙箱内存溢出；桌面端浏览器放宽至 512MB
  const isMobileUa =
    typeof navigator !== 'undefined' &&
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const maxAudioDecodeBytes = (isMobileUa ? 80 : 512) * 1024 * 1024;
  if (file.size > maxAudioDecodeBytes) {
    return degradedAudioResult('oversize');
  }

  let audioCtx: AudioContext | null = null;
  try {
    const arrayBuffer = await readFileAsArrayBuffer(file);
    // 借助浏览器 AudioContext 解码容器中的音频流
    const AudioCtxConstructor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    audioCtx = new AudioCtxConstructor();
    const audioBuffer = await safeDecodeAudioData(audioCtx, arrayBuffer);

    const duration = audioBuffer.duration;
    const sampleRate = audioBuffer.sampleRate;

    // 合并为单声道 Float32Array（仅保留前两个声道，多声道容器罕见且不增强节奏信息）
    const numChannels = audioBuffer.numberOfChannels;
    const length = audioBuffer.length;
    const monoData = new Float32Array(length);

    if (numChannels === 1) {
      monoData.set(audioBuffer.getChannelData(0));
    } else {
      const ch0 = audioBuffer.getChannelData(0);
      const ch1 = audioBuffer.getChannelData(1);
      for (let i = 0; i < length; i++) {
        monoData[i] = (ch0[i] + ch1[i]) / 2;
      }
    }

    // 初次导入默认对前 60 秒音频进行先验自相关分析，兼顾整曲速度与加载流畅度
    const detectedBpm = detectBpmFromPcm(monoData, sampleRate, 60);
    const waveform = extractAudioWaveform(monoData, 1000);

    return {
      hasAudioTrack: true,
      audioDegraded: false,
      duration,
      sampleRate,
      detectedBpm,
      waveform,
      rawChannelData: monoData,
    };
  } catch {
    return degradedAudioResult('decode-error');
  } finally {
    // 读取/构造器本身也可能抛出，统一在 finally 中判空关闭
    if (audioCtx) {
      await audioCtx.close().catch(() => {});
    }
  }
}

/**
 * 从 Android 原生本地流式代理拉取降采样后的 Int16 小端 PCM 数据并完成波形与 BPM 分析
 */
export async function decodeAudioFromNativePcmUrl(
  pcmUrl: string,
  sampleRate: number,
  durationSec: number
): Promise<DecodedAudioResult> {
  const response = await fetch(pcmUrl);
  if (!response.ok) {
    throw new Error('原生音频 PCM 读取失败: HTTP ' + response.status);
  }
  const buffer = await response.arrayBuffer();
  const int16 = new Int16Array(buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768.0;
  }

  const effectiveRate = sampleRate > 0 ? sampleRate : 16000;
  const effectiveDuration = durationSec > 0 ? durationSec : float32.length / effectiveRate;
  const detectedBpm = detectBpmFromPcm(float32, effectiveRate, 60);
  const waveform = extractAudioWaveform(float32, 1000);

  return {
    hasAudioTrack: true,
    audioDegraded: false,
    duration: effectiveDuration,
    sampleRate: effectiveRate,
    detectedBpm,
    waveform,
    rawChannelData: float32,
  };
}
