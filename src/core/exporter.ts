/**
 * 所见即所得离线逐帧视频导出与音频混流引擎
 * Android 原生端：通过 NativeMediaPlugin 调用 MediaCodec + OpenGL ES + MediaMuxer GPU 零拷贝离线硬编码 MP4
 * 现代 Web 浏览器端：基于 WebCodecs (VideoEncoder/AudioEncoder) 与 mp4-muxer 执行确定性时间戳离线编码 MP4
 * 注意：纯 Web 通道对宿主有 WebCodecs 硬性要求，无 MediaRecorder 实时录制降级路径
 * （历史上曾有该降级，后随架构演进移除）；不支持时直接抛错并提示改用原生客户端。
 */

import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import type { PluginListenerHandle } from '@capacitor/core';
import type {
  ComparisonMode,
  ViewportTransform,
} from '../types/geometry.ts';
import type {
  SlowMotionRate,
  SoundSource,
} from '../types/timeline.ts';
import type { LoadedVideoItem } from '../types/media.ts';
import type { AlignmentTransform } from './geometry.ts';
import type { UnifiedTimelineResult } from './timeline.ts';
import { mapTauToSourceTime, isTauInVideoRange } from './timeline.ts';
import {
  renderComparisonFrame,
  computeNativeExportLayout,
} from './renderer.ts';
import type { ComparisonRenderState } from './renderer.ts';
import { isDownbeatIndex } from './metronome.ts';
import { getPcm } from './pcmStore.ts';
import { NativeMedia, isNativeAndroid } from './nativeMedia.ts';

export interface ExportProgressInfo {
  currentFrame: number;
  totalFrames: number;
  percent: number;
  statusText: string;
}

export interface ExporterConfig {
  video1: LoadedVideoItem;
  video2: LoadedVideoItem;
  sharedVideo1?: HTMLVideoElement | null;
  sharedVideo2?: HTMLVideoElement | null;
  timeline: UnifiedTimelineResult;
  mode: ComparisonMode;
  mirror1: boolean;
  mirror2: boolean;
  triLineTransform?: AlignmentTransform;
  viewport: ViewportTransform;
  relativeOpacity: number;
  slowMotionRate: SlowMotionRate;
  soundSource: SoundSource;
  fps?: number;
  width?: number;
  height?: number;
  onProgress: (info: ExportProgressInfo) => void;
}

/**
 * 探测当前运行宿主是否支持原生 WebCodecs 硬件加速编码
 */
export function isWebCodecsSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as unknown as { VideoEncoder?: unknown }).VideoEncoder !== 'undefined' &&
    typeof (window as unknown as { VideoFrame?: unknown }).VideoFrame !== 'undefined'
  );
}

/**
 * 按导出分辨率选择匹配的视频码率（bps）
 */
function selectVideoBitrate(width: number, height: number): number {
  return width * height >= 1920 * 1080 ? 8_000_000 : 5_000_000;
}

/**
 * 寻找宿主环境支持的最佳 H.264 视频编码配置
 */
async function selectSupportedVideoCodec(width: number, height: number, fps: number): Promise<string> {
  const candidates = [
    'avc1.42001f', // Baseline Profile Level 3.1
    'avc1.4d002a', // Main Profile Level 4.2
    'avc1.64002a', // High Profile Level 4.2
  ];

  for (const codec of candidates) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec,
        width,
        height,
        bitrate: selectVideoBitrate(width, height),
        framerate: fps,
      });
      if (support.supported) {
        return codec;
      }
    } catch {
      // 尝试下一个候选配置
    }
  }

  return 'avc1.42001f';
}

/**
 * 探测宿主环境是否支持 AAC 音频编码
 */
async function isAacAudioSupported(sampleRate: number): Promise<boolean> {
  if (typeof (window as unknown as { AudioEncoder?: unknown }).AudioEncoder === 'undefined') {
    return false;
  }
  try {
    const support = await AudioEncoder.isConfigSupported({
      codec: 'mp4a.40.2',
      sampleRate,
      numberOfChannels: 1,
      bitrate: 128_000,
    });
    return !!support.supported;
  } catch {
    return false;
  }
}

/**
 * 离线合成节拍器音轨数据 (OfflineAudioContext，纯 Web 端 WebCodecs 使用)
 */
export async function synthesizeMetronomeBuffer(
  exportStart: number,
  exportEnd: number,
  outputDurationSec: number,
  effectiveBpm: number,
  slowMotionRate: number,
  sampleRate: number
): Promise<AudioBuffer> {
  const totalSamples = Math.max(1, Math.round(outputDurationSec * sampleRate));
  const offlineCtx = new OfflineAudioContext(1, totalSamples, sampleRate);

  const compressor = offlineCtx.createDynamicsCompressor();
  compressor.threshold.setValueAtTime(-1.5, 0);
  compressor.knee.setValueAtTime(3, 0);
  compressor.ratio.setValueAtTime(12, 0);
  compressor.attack.setValueAtTime(0.001, 0);
  compressor.release.setValueAtTime(0.04, 0);
  compressor.connect(offlineCtx.destination);

  const beatIntervalTau = 60 / effectiveBpm;
  const kStart = Math.ceil(exportStart / beatIntervalTau - 1e-5);
  const kEnd = Math.floor(exportEnd / beatIntervalTau + 1e-5);

  for (let k = kStart; k <= kEnd; k++) {
    const tauBeat = k * beatIntervalTau;
    const outTime = (tauBeat - exportStart) / slowMotionRate;

    if (outTime >= 0 && outTime < outputDurationSec) {
      const isDownbeat = isDownbeatIndex(k);

      if (isDownbeat) {
        const oscHigh = offlineCtx.createOscillator();
        const oscLow = offlineCtx.createOscillator();
        const gainNode = offlineCtx.createGain();

        oscHigh.type = 'triangle';
        oscHigh.frequency.setValueAtTime(1600, outTime);

        oscLow.type = 'sine';
        oscLow.frequency.setValueAtTime(800, outTime);

        gainNode.gain.setValueAtTime(1.1, outTime);
        gainNode.gain.setValueAtTime(1.1, outTime + 0.010);
        gainNode.gain.exponentialRampToValueAtTime(0.001, outTime + 0.065);

        oscHigh.connect(gainNode);
        oscLow.connect(gainNode);
        gainNode.connect(compressor);

        oscHigh.start(outTime);
        oscLow.start(outTime);
        oscHigh.stop(outTime + 0.075);
        oscLow.stop(outTime + 0.075);
      } else {
        const osc = offlineCtx.createOscillator();
        const gainNode = offlineCtx.createGain();

        osc.type = 'triangle';
        osc.frequency.setValueAtTime(1000, outTime);

        gainNode.gain.setValueAtTime(0.9, outTime);
        gainNode.gain.setValueAtTime(0.9, outTime + 0.006);
        gainNode.gain.exponentialRampToValueAtTime(0.001, outTime + 0.050);

        osc.connect(gainNode);
        gainNode.connect(compressor);

        osc.start(outTime);
        osc.stop(outTime + 0.060);
      }
    }
  }

  return await offlineCtx.startRendering();
}

/**
 * 从源视频 PCM 数据中截取对应时间段并按慢放倍率生成变速离线音轨 (纯 Web 端 WebCodecs 使用)
 */
function createSourceAudioBuffer(
  sourceRawPcm: Float32Array,
  sourceSampleRate: number,
  exportStart: number,
  outputDurationSec: number,
  slowMotionRate: number,
  anchorTime: number,
  rate: number,
  targetSampleRate: number
): AudioBuffer {
  const totalSamples = Math.max(1, Math.round(outputDurationSec * targetSampleRate));
  let audioBuffer: AudioBuffer;
  if (typeof AudioBuffer === 'function') {
    audioBuffer = new AudioBuffer({
      length: totalSamples,
      numberOfChannels: 1,
      sampleRate: targetSampleRate,
    });
  } else {
    const offline = new OfflineAudioContext(1, totalSamples, targetSampleRate);
    audioBuffer = offline.createBuffer(1, totalSamples, targetSampleRate);
  }
  const outChannel = audioBuffer.getChannelData(0);

  const sourceLength = sourceRawPcm.length;

  for (let i = 0; i < totalSamples; i++) {
    const outTime = i / targetSampleRate;
    const currentTau = exportStart + outTime * slowMotionRate;
    const sourceTime = mapTauToSourceTime(currentTau, anchorTime, rate);

    if (sourceTime >= 0) {
      const sourceIndex = sourceTime * sourceSampleRate;
      const indexFloor = Math.floor(sourceIndex);
      const frac = sourceIndex - indexFloor;

      if (indexFloor >= 0 && indexFloor < sourceLength - 1) {
        outChannel[i] = sourceRawPcm[indexFloor] * (1 - frac) + sourceRawPcm[indexFloor + 1] * frac;
      } else if (indexFloor >= 0 && indexFloor < sourceLength) {
        outChannel[i] = sourceRawPcm[indexFloor];
      } else {
        outChannel[i] = 0;
      }
    } else {
      outChannel[i] = 0;
    }
  }

  return audioBuffer;
}

export class VideoExporter {
  private config: ExporterConfig;
  private isCancelled: boolean = false;

  constructor(config: ExporterConfig) {
    this.config = config;
  }

  /**
   * 取消正在执行的离线导出任务
   */
  public cancel(): void {
    this.isCancelled = true;
    if (isNativeAndroid()) {
      NativeMedia.cancelExport().catch(() => {});
    }
  }

  /**
   * 导出视频主入口：
   * - Android 原生端统一调用原生 MediaCodec + OpenGL ES + MediaMuxer GPU 零拷贝离线硬编码 MP4
   * - 纯 Web 浏览器端走 WebCodecs 离线编码 MP4
   */
  public async export(): Promise<{ blob?: Blob; savedPath?: string; fileExtension: 'mp4' }> {
    if (isNativeAndroid()) {
      return this.exportViaNativePlugin();
    }
    if (isWebCodecsSupported()) {
      return this.exportViaWebCodecs();
    }
    throw new Error('当前浏览器不支持 WebCodecs 离线导出，请使用最新版 Chrome 或 Android 原生应用。');
  }

  /**
   * Android 原生全机型 GPU 零拷贝离线 MP4 导出通道
   */
  private async exportViaNativePlugin(): Promise<{
    blob?: Blob;
    savedPath: string;
    fileExtension: 'mp4';
  }> {
    const {
      video1,
      video2,
      timeline,
      mode,
      mirror1,
      mirror2,
      triLineTransform,
      viewport,
      relativeOpacity,
      slowMotionRate,
      soundSource,
      fps = 30,
      width = 1280,
      height = 720,
      onProgress,
    } = this.config;

    if (!video1.nativeUri || !video2.nativeUri) {
      throw new Error('缺少原生视频 URI，请重新在导入步骤选择视频');
    }

    const exportWidth = width % 2 === 0 ? width : width - 1;
    const exportHeight = height % 2 === 0 ? height : height - 1;
    const exportStart = timeline.intersectInterval.start;
    const exportEnd = timeline.intersectInterval.end;
    const exportDuration = Math.max(0.1, exportEnd - exportStart);
    const outputDurationSec = exportDuration / slowMotionRate;
    const totalFrames = Math.max(1, Math.round(outputDurationSec * fps));

    const a1 = typeof video1.audioInfo?.anchorTime === 'number' ? video1.audioInfo.anchorTime : 1.0;
    const a2 = typeof video2.audioInfo?.anchorTime === 'number' ? video2.audioInfo.anchorTime : 1.0;

    const layout = computeNativeExportLayout({
      mode,
      canvasWidth: exportWidth,
      canvasHeight: exportHeight,
      video1Uri: video1.nativeUri,
      video1Size: { width: video1.width, height: video1.height },
      anchor1: a1,
      rate1: timeline.rate1,
      span1Start: timeline.span1.start,
      span1End: timeline.span1.end,
      mirror1,
      triLine1: video1.geometry.triLine,
      video2Uri: video2.nativeUri,
      video2Size: { width: video2.width, height: video2.height },
      anchor2: a2,
      rate2: timeline.rate2,
      span2Start: timeline.span2.start,
      span2End: timeline.span2.end,
      mirror2,
      triLine2: video2.geometry.triLine,
      triLineTransform,
      relativeOpacity,
      viewport,
    });

    onProgress({
      currentFrame: 0,
      totalFrames,
      percent: 0,
      statusText: '正在启动原生硬件合成管线...',
    });

    let listenerHandle: PluginListenerHandle | null = null;
    try {
      listenerHandle = await NativeMedia.addListener('exportProgress', (ev) => {
        if (!this.isCancelled) {
          onProgress({
            currentFrame: ev.currentFrame,
            totalFrames: ev.totalFrames,
            percent: ev.percent,
            statusText: ev.statusText,
          });
        }
      });

      if (this.isCancelled) {
        throw new Error('用户已取消导出');
      }

      const res = await NativeMedia.exportVideo({
        mode,
        width: exportWidth,
        height: exportHeight,
        fps,
        exportStartTau: exportStart,
        exportEndTau: exportEnd,
        slowMotionRate,
        effectiveBpm: timeline.effectiveBpm,
        soundSource,
        video1: layout.video1,
        video2: layout.video2,
      });

      if (this.isCancelled) {
        throw new Error('用户已取消导出');
      }

      onProgress({
        currentFrame: totalFrames,
        totalFrames,
        percent: 100,
        statusText: '导出完成！',
      });

      return {
        savedPath: res.savedPath,
        fileExtension: 'mp4',
      };
    } finally {
      if (listenerHandle) {
        listenerHandle.remove().catch(() => {});
      }
    }
  }

  /**
   * 纯 Web 浏览器端确定性时间戳离线逐帧渲染与 WebCodecs 硬件加速 MP4 编码
   */
  private async exportViaWebCodecs(): Promise<{
    blob: Blob;
    savedPath?: string;
    fileExtension: 'mp4';
  }> {
    const {
      video1,
      video2,
      timeline,
      mode,
      mirror1,
      mirror2,
      triLineTransform,
      viewport,
      relativeOpacity,
      slowMotionRate,
      soundSource,
      fps = 30,
      width = 1280,
      height = 720,
      onProgress,
    } = this.config;

    const exportWidth = width % 2 === 0 ? width : width - 1;
    const exportHeight = height % 2 === 0 ? height : height - 1;

    const exportStart = timeline.intersectInterval.start;
    const exportEnd = timeline.intersectInterval.end;
    const exportDuration = Math.max(0.1, exportEnd - exportStart);
    const outputDurationSec = exportDuration / slowMotionRate;
    const totalFrames = Math.max(1, Math.round(outputDurationSec * fps));

    onProgress({
      currentFrame: 0,
      totalFrames,
      percent: 0,
      statusText: '正在准备确定性时间戳与硬件编码管道...',
    });

    const canvas = document.createElement('canvas');
    canvas.width = exportWidth;
    canvas.height = exportHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('无法创建 Canvas 2D 绘图上下文');

    const audioSampleRate = 44100;
    let audioBuffer: AudioBuffer | null = null;
    const isAacSupported = await isAacAudioSupported(audioSampleRate);

    if (soundSource !== 'mute' && isAacSupported) {
      onProgress({
        currentFrame: 0,
        totalFrames,
        percent: 0,
        statusText: '正在离线渲染伴奏音轨与声画同步数据...',
      });

      if (soundSource === 'metronome') {
        audioBuffer = await synthesizeMetronomeBuffer(
          exportStart,
          exportEnd,
          outputDurationSec,
          timeline.effectiveBpm,
          slowMotionRate,
          audioSampleRate
        );
      } else {
        const targetVideo = soundSource === 'video1' ? video1 : video2;
        const anchor =
          typeof targetVideo.audioInfo?.anchorTime === 'number'
            ? targetVideo.audioInfo.anchorTime
            : 1.0;
        const rate = soundSource === 'video1' ? timeline.rate1 : timeline.rate2;
        const rawPcm = getPcm(targetVideo.url);

        if (rawPcm && rawPcm.length > 0) {
          audioBuffer = createSourceAudioBuffer(
            rawPcm,
            targetVideo.audioInfo?.sampleRate || 44100,
            exportStart,
            outputDurationSec,
            slowMotionRate,
            anchor,
            rate,
            audioSampleRate
          );
        }
      }
    }

    const selectedVideoCodec = await selectSupportedVideoCodec(exportWidth, exportHeight, fps);

    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: {
        codec: 'avc',
        width: exportWidth,
        height: exportHeight,
        frameRate: fps,
      },
      audio:
        audioBuffer && isAacSupported
          ? {
              codec: 'aac',
              numberOfChannels: 1,
              sampleRate: audioSampleRate,
            }
          : undefined,
      fastStart: 'in-memory',
      firstTimestampBehavior: 'strict',
    });

    let videoEncoderError: Error | null = null;
    const videoEncoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => {
        videoEncoderError = e as Error;
        console.error('VideoEncoder 异常', e);
      },
    });

    videoEncoder.configure({
      codec: selectedVideoCodec,
      width: exportWidth,
      height: exportHeight,
      bitrate: selectVideoBitrate(exportWidth, exportHeight),
      framerate: fps,
    });

    let audioEncoder: AudioEncoder | null = null;
    if (audioBuffer && isAacSupported) {
      audioEncoder = new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error: (e) => console.error('AudioEncoder 异常', e),
      });

      audioEncoder.configure({
        codec: 'mp4a.40.2',
        sampleRate: audioSampleRate,
        numberOfChannels: 1,
        bitrate: 128_000,
      });

      const channelData = audioBuffer.getChannelData(0);
      const totalAudioFrames = channelData.length;
      const audioChunkSize = 1024;

      for (let offset = 0; offset < totalAudioFrames; offset += audioChunkSize) {
        if (this.isCancelled) {
          audioEncoder.close();
          videoEncoder.close();
          throw new Error('用户已取消导出');
        }

        const chunkLen = Math.min(audioChunkSize, totalAudioFrames - offset);
        const subPcm = channelData.subarray(offset, offset + chunkLen);
        const audioTimestampMicros = Math.round((offset / audioSampleRate) * 1_000_000);

        const audioData = new AudioData({
          format: 'f32',
          sampleRate: audioSampleRate,
          numberOfFrames: chunkLen,
          numberOfChannels: 1,
          timestamp: audioTimestampMicros,
          data: subPcm,
        });

        audioEncoder.encode(audioData);
        audioData.close();
      }

      await audioEncoder.flush();
      audioEncoder.close();
    }

    const offVideo1 = document.createElement('video');
    offVideo1.src = video1.url;
    offVideo1.muted = true;
    offVideo1.preload = 'auto';

    const offVideo2 = document.createElement('video');
    offVideo2.src = video2.url;
    offVideo2.muted = true;
    offVideo2.preload = 'auto';

    await Promise.all([
      new Promise<void>((r) => {
        offVideo1.onloadeddata = () => r();
        offVideo1.load();
      }),
      new Promise<void>((r) => {
        offVideo2.onloadeddata = () => r();
        offVideo2.load();
      }),
    ]);

    // 带超时的寻道：老旧/损坏媒体源可能永不触发 seeked 事件，
    // 若不设硬上限，整个导出循环将永久卡死且无法取消。
    const SEEK_TIMEOUT_MS = 5000;
    const seekVideo = (v: HTMLVideoElement, targetTime: number): Promise<void> => {
      return new Promise((resolve, reject) => {
        const clamped = Math.max(0, Math.min(v.duration || targetTime, targetTime));
        if (Math.abs(v.currentTime - clamped) < 0.01) {
          resolve();
          return;
        }
        let settled = false;
        const finish = (err?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          v.removeEventListener('seeked', onSeeked);
          v.removeEventListener('error', onError);
          if (err) reject(err);
          else resolve();
        };
        const timer = setTimeout(() => {
          finish(new Error(`视频寻道超时 (${SEEK_TIMEOUT_MS}ms)，媒体源可能已损坏或解码器停滞`));
        }, SEEK_TIMEOUT_MS);
        const onSeeked = () => finish();
        const onError = () => finish(new Error('导出寻道过程中发生媒体解码错误'));
        v.addEventListener('seeked', onSeeked);
        v.addEventListener('error', onError);
        try {
          v.currentTime = clamped;
        } catch (e) {
          finish(e instanceof Error ? e : new Error(String(e)));
        }
      });
    };

    const a1 = typeof video1.audioInfo?.anchorTime === 'number' ? video1.audioInfo.anchorTime : 1.0;
    const a2 = typeof video2.audioInfo?.anchorTime === 'number' ? video2.audioInfo.anchorTime : 1.0;

    const frameDurationMicros = Math.round((1 / fps) * 1_000_000);

    // 逐帧循环任何一步失败（含寻道超时）都必须释放离屏视频节点，避免解码器句柄泄漏
    try {
      for (let frame = 0; frame < totalFrames; frame++) {
      if (this.isCancelled) {
        videoEncoder.close();
        throw new Error('用户已取消导出');
      }
      if (videoEncoderError) {
        videoEncoder.close();
        throw videoEncoderError;
      }

      const currentTau = exportStart + (frame / fps) * slowMotionRate;
      const t1 = mapTauToSourceTime(currentTau, a1, timeline.rate1);
      const t2 = mapTauToSourceTime(currentTau, a2, timeline.rate2);

      const v1Active = isTauInVideoRange(currentTau, timeline.span1);
      const v2Active = isTauInVideoRange(currentTau, timeline.span2);

      const seeks: Promise<void>[] = [];
      if (v1Active) seeks.push(seekVideo(offVideo1, t1));
      if (v2Active) seeks.push(seekVideo(offVideo2, t2));
      if (seeks.length > 0) {
        await Promise.all(seeks);
      }

      const renderState: ComparisonRenderState = {
        mode,
        video1: offVideo1,
        video1Size: { width: video1.width, height: video1.height },
        video1Active: v1Active,
        mirror1,
        triLine1: video1.geometry.triLine,
        video2: offVideo2,
        video2Size: { width: video2.width, height: video2.height },
        video2Active: v2Active,
        mirror2,
        triLine2: video2.geometry.triLine,
        triLineTransform,
        relativeOpacity,
        viewport,
        canvasWidth: exportWidth,
        canvasHeight: exportHeight,
      };

      renderComparisonFrame(ctx, renderState);

      const timestampMicros = Math.round((frame / fps) * 1_000_000);
      const videoFrame = new VideoFrame(canvas, {
        timestamp: timestampMicros,
        duration: frameDurationMicros,
      });

      const isKeyFrame = frame % (fps * 2) === 0;
      videoEncoder.encode(videoFrame, { keyFrame: isKeyFrame });
      videoFrame.close();

      if (frame % 10 === 0 || frame === totalFrames - 1) {
        const percent = Math.round(((frame + 1) / totalFrames) * 100);
        onProgress({
          currentFrame: frame + 1,
          totalFrames,
          percent,
          statusText: `正在离线合成逐帧画面 (${frame + 1}/${totalFrames} 帧)...`,
        });
        await new Promise((r) => setTimeout(r, 0));
      }
      }
    } finally {
      // 无论成功、取消还是寻道超时失败，都立即释放离屏视频解码节点
      offVideo1.removeAttribute('src');
      offVideo1.load();
      offVideo2.removeAttribute('src');
      offVideo2.load();
    }

    await videoEncoder.flush();
    videoEncoder.close();

    muxer.finalize();
    const finalBuffer = muxer.target.buffer;
    const finalBlob = new Blob([finalBuffer], { type: 'video/mp4' });

    onProgress({
      currentFrame: totalFrames,
      totalFrames,
      percent: 100,
      statusText: '导出完成！',
    });

    return { blob: finalBlob, fileExtension: 'mp4' };
  }
}
