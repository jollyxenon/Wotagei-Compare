import { Capacitor, registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import type { ComparisonMode } from '../types/geometry.ts';
import type { SlowMotionRate, SoundSource } from '../types/timeline.ts';

export interface NativePickVideoResult {
  canceled: boolean;
  uri?: string;
  streamUrl?: string;
  name?: string;
  size?: number;
  width?: number;
  height?: number;
  duration?: number;
}

export interface NativeExtractAudioResult {
  hasAudio: boolean;
  /** true = 达到原生提取安全上限（10 分钟），PCM/BPM 仅基于截取片段 */
  truncated?: boolean;
  sampleRate: number;
  duration: number;
  pcmUrl?: string;
}

export interface NormalizedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface NativeVideoLayerLayout {
  uri: string;
  anchorTime: number;
  rate: number;
  spanStart: number;
  spanEnd: number;
  mirror: boolean;
  alpha: number;
  clipRect: NormalizedRect;
  mainRect: NormalizedRect;
  bgRect?: NormalizedRect;
  bgAlpha?: number;
}

export interface NativeExportRequest {
  mode: ComparisonMode;
  width: number;
  height: number;
  fps: number;
  exportStartTau: number;
  exportEndTau: number;
  slowMotionRate: SlowMotionRate;
  effectiveBpm: number;
  soundSource: SoundSource;
  video1: NativeVideoLayerLayout;
  video2: NativeVideoLayerLayout;
}

export interface NativeExportProgressEvent {
  currentFrame: number;
  totalFrames: number;
  percent: number;
  statusText: string;
}

export interface NativeExportResult {
  savedPath: string;
  width: number;
  height: number;
  durationSec: number;
}

export interface NativeReleaseAsset {
  name: string;
  browserDownloadUrl: string;
  size: number;
  contentType: string;
}

export interface NativeReleaseCheckResult {
  tagName: string;
  name: string;
  body: string;
  htmlUrl: string;
  publishedAt: string;
  assets: NativeReleaseAsset[];
}

export interface NativeUpdateDownloadProgressEvent {
  percent: number;
  downloadedBytes: number;
  totalBytes: number;
  statusText: string;
}

export interface NativeAppVersionResult {
  versionName: string;
  versionCode: number;
}

export interface NativeInstallApkResult {
  status: 'installer_launched' | 'permission_required' | 'cancelled';
  message?: string;
}

export interface NativeMediaPlugin {
  pickVideo(options: { channel: 1 | 2 }): Promise<NativePickVideoResult>;
  extractAudioAnalysis(options: { uri: string }): Promise<NativeExtractAudioResult>;
  exportVideo(options: NativeExportRequest): Promise<NativeExportResult>;
  cancelExport(): Promise<void>;
  getAppVersion(): Promise<NativeAppVersionResult>;
  checkLatestRelease(): Promise<NativeReleaseCheckResult>;
  downloadAndInstallApk(options: { url: string; version: string }): Promise<NativeInstallApkResult>;
  openExternalUrl(options: { url: string }): Promise<void>;
  addListener(
    eventName: 'exportProgress',
    listenerFunc: (event: NativeExportProgressEvent) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'updateDownloadProgress',
    listenerFunc: (event: NativeUpdateDownloadProgressEvent) => void
  ): Promise<PluginListenerHandle>;
}

export const NativeMedia = registerPlugin<NativeMediaPlugin>('NativeMedia');

/**
 * 判断当前是否运行于 Android 原生应用容器内
 */
export function isNativeAndroid(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}
