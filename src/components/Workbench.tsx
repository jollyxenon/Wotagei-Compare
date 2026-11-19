import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import {
  Play,
  Pause,
  Crosshair,
  RotateCcw,
  Layers,
  Columns2,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  X,
} from 'lucide-react';
import type {
  ComparisonMode,
  ViewportTransform,
} from '../types/geometry.ts';
import type {
  BpmAlignStrategy,
  SlowMotionRate,
  SoundSource,
  TimeInterval,
} from '../types/timeline.ts';
import { DEFAULT_BPM } from '../types/timeline.ts';
import { calculateTriLineAlignment, AlignmentTransform } from '../core/geometry.ts';
import {
  calculateUnifiedTimeline,
  isTauInVideoRange,
  UnifiedTimelineResult,
} from '../core/timeline.ts';
import { renderComparisonFrame, ComparisonRenderState } from '../core/renderer.ts';
import { SynthesizedMetronome } from '../core/metronome.ts';
import { DualVideoSyncEngine } from '../core/sync-engine.ts';
import type { LoadedVideoItem } from '../types/media.ts';
import type { WizardStep } from '../types/wizard.ts';
import type { StepPreset } from '../types/preferences.ts';
import { ExportPage } from './ExportPage.tsx';

export interface WorkbenchProps {
  video1: LoadedVideoItem;
  video2: LoadedVideoItem;
  initialMode: ComparisonMode;
  bpmStrategy: BpmAlignStrategy;
  customBpm: number;
  soundSource?: SoundSource;
  slowMotionRate?: SlowMotionRate;
  stepPreset?: StepPreset;
  customStepSec?: number;
  isExport?: boolean;
  isToolbarExpanded?: boolean;
  loopRange?: TimeInterval | null;
  onLoopRangeChange?: (range: TimeInterval | null) => void;
  onToggleToolbar?: () => void;
  onNavigate?: (step: WizardStep) => void;
  onBpmStrategyChange?: (strategy: BpmAlignStrategy, customBpm?: number) => void;
  onModeChange?: (mode: ComparisonMode) => void;
  onSoundSourceChange?: (source: SoundSource) => void;
  onSlowMotionRateChange?: (rate: SlowMotionRate) => void;
  onStepPresetChange?: (preset: StepPreset) => void;
  onCustomStepSecChange?: (sec: number) => void;
  onMirrorChange?: (videoIndex: 1 | 2, mirror: boolean) => void;
}

const SLOW_MOTION_RATES: SlowMotionRate[] = [0.1, 0.15, 0.2, 0.3, 0.5, 0.75, 1.0];

/** 专业标准水平左右镜像矢量图标 (沿垂直对称轴翻转) */
export const HorizontalFlipIcon: React.FC<{ size?: number }> = ({ size = 12 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="m3 7 5 5-5 5V7z" />
    <path d="m21 7-5 5 5 5V7z" />
    <path d="M12 20v2" />
    <path d="M12 14v2" />
    <path d="M12 8v2" />
    <path d="M12 2v2" />
  </svg>
);

/**
 * 步骤 06：同台对比播放与慢放监看工作台
 */
export const Workbench: React.FC<WorkbenchProps> = ({
  video1,
  video2,
  initialMode,
  bpmStrategy,
  customBpm,
  soundSource: soundSourceProp,
  slowMotionRate: slowMotionRateProp,
  stepPreset: stepPresetProp,
  customStepSec: customStepSecProp,
  isExport = false,
  isToolbarExpanded = false,
  loopRange,
  onLoopRangeChange,
  onToggleToolbar,
  onNavigate,
  onBpmStrategyChange,
  onModeChange,
  onSoundSourceChange,
  onSlowMotionRateChange,
  onStepPresetChange,
  onCustomStepSecChange,
  onMirrorChange,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef1 = useRef<HTMLVideoElement>(null);
  const videoRef2 = useRef<HTMLVideoElement>(null);
  const engineRef = useRef<DualVideoSyncEngine | null>(null);
  const fallbackCanvasRef1 = useRef<HTMLCanvasElement | null>(null);
  const fallbackCanvasRef2 = useRef<HTMLCanvasElement | null>(null);
  const fallbackMetaRef = useRef<{
    1: { url: string; time: number; has: boolean };
    2: { url: string; time: number; has: boolean };
  }>({
    1: { url: '', time: -1, has: false },
    2: { url: '', time: -1, has: false },
  });

  const [mode, setMode] = useState<ComparisonMode>(initialMode);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [internalSlowMotionRate, setInternalSlowMotionRate] = useState<SlowMotionRate>(1.0);
  const [internalSoundSource, setInternalSoundSource] = useState<SoundSource>('metronome');
  const [relativeOpacity, setRelativeOpacity] = useState<number>(0);
  const [openPopup, setOpenPopup] = useState<'step' | 'rate' | 'bpm' | null>(null);
  const [internalStepPreset, setInternalStepPreset] = useState<StepPreset>('frame');
  const [internalCustomStepSec, setInternalCustomStepSec] = useState<number>(0.033);

  const slowMotionRate = slowMotionRateProp ?? internalSlowMotionRate;
  const soundSource = soundSourceProp ?? internalSoundSource;
  const stepPreset = stepPresetProp ?? internalStepPreset;
  const customStepSec = customStepSecProp ?? internalCustomStepSec;

  const [customStepInputText, setCustomStepInputText] = useState<string>(() =>
    (customStepSecProp ?? 0.033).toFixed(3)
  );
  const isEditingCustomStepRef = useRef<boolean>(false);
  const [internalLoopRange, setInternalLoopRange] = useState<TimeInterval | null>(null);

  useEffect(() => {
    setMode(initialMode);
  }, [initialMode]);

  useEffect(() => {
    if (!isEditingCustomStepRef.current) {
      setCustomStepInputText(customStepSec.toFixed(3));
    }
  }, [customStepSec]);

  const updateSoundSource = (next: SoundSource) => {
    setInternalSoundSource(next);
    onSoundSourceChange?.(next);
  };

  const updateStepPreset = (next: StepPreset) => {
    setInternalStepPreset(next);
    onStepPresetChange?.(next);
  };

  const updateCustomStepSec = (next: number) => {
    setInternalCustomStepSec(next);
    onCustomStepSecChange?.(next);
  };

  const commitCustomStepInput = () => {
    isEditingCustomStepRef.current = false;
    const val = parseFloat(customStepInputText);
    const clamped = !isNaN(val) ? Math.max(0.005, val) : customStepSec;
    updateCustomStepSec(clamped);
    setCustomStepInputText(clamped.toFixed(3));
  };

  const activeLoopRange = loopRange !== undefined ? loopRange : internalLoopRange;
  const updateLoopRange = (next: TimeInterval | null) => {
    if (onLoopRangeChange) {
      onLoopRangeChange(next);
    } else {
      setInternalLoopRange(next);
    }
  };

  const [mirror1, setMirror1] = useState<boolean>(video1.geometry.mirror);
  const [mirror2, setMirror2] = useState<boolean>(video2.geometry.mirror);

  const [viewport, setViewport] = useState<ViewportTransform>({
    scale: 1,
    offsetX: 0,
    offsetY: 0,
  });

  const [isExportPageOpen, setIsExportPageOpen] = useState<boolean>(false);

  const a1 = typeof video1.audioInfo?.anchorTime === 'number' ? video1.audioInfo.anchorTime : 1.0;
  const a2 = typeof video2.audioInfo?.anchorTime === 'number' ? video2.audioInfo.anchorTime : 1.0;

  // 计算双通道统一时间轴映射
  const timeline = useMemo(() => {
    return calculateUnifiedTimeline(
      {
        duration: video1.duration,
        bpm: video1.audioInfo?.userBpm || DEFAULT_BPM,
        anchorTime: a1,
        trimRange: video1.audioInfo?.trimRange,
      },
      {
        duration: video2.duration,
        bpm: video2.audioInfo?.userBpm || DEFAULT_BPM,
        anchorTime: a2,
        trimRange: video2.audioInfo?.trimRange,
      },
      bpmStrategy,
      customBpm
    );
  }, [video1, video2, bpmStrategy, customBpm, a1, a2]);

  const [tau, setTau] = useState<number>(timeline.intersectInterval.start);
  const tauRef = useRef<number>(timeline.intersectInterval.start);
  tauRef.current = tau;

  // 计算三线正交空间变换矩阵
  const triLineTransform: AlignmentTransform | undefined = useMemo(() => {
    if (!video1.geometry.triLine || !video2.geometry.triLine) return undefined;
    return calculateTriLineAlignment(
      video1.geometry.triLine,
      { width: video1.width, height: video1.height },
      video2.geometry.triLine,
      { width: video2.width, height: video2.height }
    );
  }, [video1, video2]);

  const metronomeRef = useRef<SynthesizedMetronome>(new SynthesizedMetronome());
  const soundSourceRef = useRef<SoundSource>(soundSource);
  soundSourceRef.current = soundSource;
  const timelineRef = useRef<UnifiedTimelineResult>(timeline);
  timelineRef.current = timeline;

  // 卸载时释放节拍器底层 AudioContext：浏览器/WebView 对并发 AudioContext 存在
  // 硬上限（约 6 个），此前缺失该清理会在多次导航往返后令节拍器永久静音且无任何报错。
  useEffect(() => {
    return () => {
      metronomeRef.current.dispose();
    };
  }, []);

  // 初始化与连接 DualVideoSyncEngine
  useEffect(() => {
    const v1 = videoRef1.current;
    const v2 = videoRef2.current;

    const engine = new DualVideoSyncEngine(v1, v2, {
      timeline,
      anchor1: a1,
      anchor2: a2,
      soundSource,
      slowMotionRate,
      loopInterval: activeLoopRange ?? timeline.intersectInterval,
      onTauUpdate: (nextTau, isEnginePlaying) => {
        setTau(nextTau);
        tauRef.current = nextTau;
        const activePlaying = isEnginePlaying ?? engineRef.current?.getIsPlaying() ?? false;
        if (soundSourceRef.current === 'metronome' && activePlaying) {
          metronomeRef.current.update(nextTau, timelineRef.current.effectiveBpm, true);
        }
      },
      onPlayingChange: (playing) => {
        setIsPlaying(playing);
      },
    });

    engineRef.current = engine;

    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  // 点击弹出层外区域或按下 Esc 时关闭当前弹出菜单
  useEffect(() => {
    if (!openPopup) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target instanceof Element && e.target.closest('[data-wb-popup]'))) {
        setOpenPopup(null);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpenPopup(null);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [openPopup]);

  // 交集边界变化时对已有 A-B 循环区间进行裁剪保护（窄于 0.1s 则重置）
  useEffect(() => {
    if (!activeLoopRange) return;
    const iStart = timeline.intersectInterval.start;
    const iEnd = timeline.intersectInterval.end;
    const clampedStart = Math.max(iStart, Math.min(iEnd, activeLoopRange.start));
    const clampedEnd = Math.min(iEnd, Math.max(iStart, activeLoopRange.end));
    if (clampedEnd - clampedStart < 0.1) {
      updateLoopRange(null);
    } else if (clampedStart !== activeLoopRange.start || clampedEnd !== activeLoopRange.end) {
      updateLoopRange({ start: clampedStart, end: clampedEnd });
    }
  }, [timeline.intersectInterval.start, timeline.intersectInterval.end]);

  // 当时间轴参数、声音源、慢放倍率或 A-B 循环区间变化时更新引擎配置
  useEffect(() => {
    engineRef.current?.updateConfig({
      timeline,
      anchor1: a1,
      anchor2: a2,
      soundSource,
      slowMotionRate,
      loopInterval: activeLoopRange ?? timeline.intersectInterval,
    });
  }, [timeline, a1, a2, soundSource, slowMotionRate, activeLoopRange]);

  const isExportActive = isExportPageOpen || isExport;

  // 当进入导出页时，暂停对比台主引擎与节拍器，避免后台声音与硬件解码冲突
  useEffect(() => {
    if (isExportActive) {
      engineRef.current?.pause();
      setIsPlaying(false);
      metronomeRef.current.reset(tauRef.current, timeline.effectiveBpm);
    }
  }, [isExportActive, timeline.effectiveBpm]);

  /**
   * 将当前已就绪的视频帧抓取至离屏备用画布，防止寻道期间画布闪烁黑屏
   */
  const captureVideoToFallbackCanvas = (
    video: HTMLVideoElement,
    canvasRef: React.MutableRefObject<HTMLCanvasElement | null>,
    width: number,
    height: number
  ): boolean => {
    if (width <= 0 || height <= 0 || video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) {
      return false;
    }
    let c = canvasRef.current;
    if (!c) {
      c = document.createElement('canvas');
      canvasRef.current = c;
    }
    if (c.width !== width) c.width = width;
    if (c.height !== height) c.height = height;
    const fctx = c.getContext('2d');
    if (!fctx) return false;
    try {
      fctx.drawImage(video, 0, 0, width, height);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * 同步更新指定通道的最近已就绪帧快照
   */
  const snapshotChannelFrame = (
    key: 1 | 2,
    video: HTMLVideoElement | null,
    url: string,
    width: number,
    height: number,
    canvasRef: React.MutableRefObject<HTMLCanvasElement | null>
  ) => {
    if (!video || video.seeking || video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) {
      return;
    }
    const entry = fallbackMetaRef.current[key];
    if (entry.has && entry.url === url && Math.abs(entry.time - video.currentTime) <= 0.001) {
      return;
    }
    if (captureVideoToFallbackCanvas(video, canvasRef, width, height)) {
      entry.has = true;
      entry.url = url;
      entry.time = video.currentTime;
    }
  };

  /**
   * 在发起暂停、寻道或步进前瞬间锁存当前双通道展示画面，确保寻道过程零闪黑
   */
  const captureReadySnapshots = useCallback(() => {
    snapshotChannelFrame(1, videoRef1.current, video1.url, video1.width, video1.height, fallbackCanvasRef1);
    snapshotChannelFrame(2, videoRef2.current, video2.url, video2.width, video2.height, fallbackCanvasRef2);
  }, [video1.url, video1.width, video1.height, video2.url, video2.width, video2.height]);

  /**
   * 解析供对比画布绘制的视频帧源：全速播放态零拷贝直通，非播放态及寻道未就绪时使用缓存帧占位
   */
  const resolveRenderSource = (
    key: 1 | 2,
    video: HTMLVideoElement,
    url: string,
    width: number,
    height: number,
    active: boolean,
    isEnginePlaying: boolean,
    canvasRef: React.MutableRefObject<HTMLCanvasElement | null>
  ): HTMLVideoElement | HTMLCanvasElement => {
    const entry = fallbackMetaRef.current[key];
    const ready =
      !video.seeking &&
      video.readyState >= 2 &&
      video.videoWidth > 0 &&
      video.videoHeight > 0;

    if (active && ready && (!isEnginePlaying || !entry.has || entry.url !== url)) {
      snapshotChannelFrame(key, video, url, width, height, canvasRef);
    }

    if (active && !ready && entry.has && entry.url === url && canvasRef.current) {
      return canvasRef.current;
    }
    return video;
  };

  // 当视频 ref 挂载或从导出页切回对比台时，自动重新绑定控制权、恢复倍速静音配置并定位至当前 tau
  useEffect(() => {
    const v1 = videoRef1.current;
    const v2 = videoRef2.current;
    if (!v1 || !v2 || isExportActive) return;

    const meta = fallbackMetaRef.current;
    if (meta[1].url !== video1.url) {
      meta[1] = { url: video1.url, has: false, time: -1 };
    }
    if (meta[2].url !== video2.url) {
      meta[2] = { url: video2.url, has: false, time: -1 };
    }

    captureReadySnapshots();
    engineRef.current?.attachVideos(v1, v2);
    engineRef.current?.updateConfig({
      timeline,
      anchor1: a1,
      anchor2: a2,
      soundSource,
      slowMotionRate,
    });
    engineRef.current?.seekToTau(tauRef.current, undefined, false);
  }, [isExportActive, video1.url, video2.url]);

  /**
   * 同步定位两路视频至统一时间轴位置
   */
  const seekToTau = useCallback(
    (targetTau: number, onComplete?: () => void) => {
      captureReadySnapshots();
      const clampedTau = Math.max(
        timeline.intersectInterval.start,
        Math.min(timeline.intersectInterval.end, targetTau)
      );
      setTau(clampedTau);
      tauRef.current = clampedTau;
      metronomeRef.current.reset(clampedTau, timeline.effectiveBpm);
      engineRef.current?.seekToTau(clampedTau, onComplete);
    },
    [timeline, captureReadySnapshots]
  );

  /**
   * 切换播放与暂停状态 (统一经过会合屏障联合起播)
   * 双视频有效区间无真实重叠时禁止起播
   */
  const togglePlay = () => {
    captureReadySnapshots();
    if (isPlaying) {
      engineRef.current?.pause();
    } else if (timeline.hasOverlap) {
      metronomeRef.current.reset(tauRef.current, timeline.effectiveBpm);
      engineRef.current?.playFrom(tauRef.current);
    }
  };

  /**
   * 切换七档慢放倍率
   */
  const handleRateChange = (rate: SlowMotionRate) => {
    setInternalSlowMotionRate(rate);
    onSlowMotionRateChange?.(rate);
    engineRef.current?.updateConfig({ slowMotionRate: rate });
  };

  /**
   * 从锚点前 1s 快速起播 (原子会合屏障，初相位差严格为 0)
   */
  const playFromPreRoll = () => {
    if (!timeline.hasOverlap) return;
    const activeBounds = activeLoopRange ?? timeline.intersectInterval;
    const targetTau = Math.max(activeBounds.start, Math.min(activeBounds.end, -1.0));
    metronomeRef.current.reset(targetTau, timeline.effectiveBpm);
    engineRef.current?.playFrom(targetTau);
  };

  const effectiveStepSeconds = useMemo(() => {
    const beatSec = 60 / Math.max(1, timeline.effectiveBpm);
    switch (stepPreset) {
      case 'frame':
        return 1 / 30;
      case '50ms':
        return 0.05;
      case '100ms':
        return 0.1;
      case 'beat-quarter':
        return beatSec / 4;
      case 'beat-half':
        return beatSec / 2;
      case 'custom':
        return Math.max(0.005, customStepSec);
    }
  }, [stepPreset, customStepSec, timeline.effectiveBpm]);

  const activeStepLabel = useMemo(() => {
    switch (stepPreset) {
      case 'frame':
        return '1帧';
      case '50ms':
        return '0.05s';
      case '100ms':
        return '0.10s';
      case 'beat-quarter':
        return '1/4拍';
      case 'beat-half':
        return '1/2拍';
      case 'custom':
        return `${Math.max(0.005, customStepSec).toFixed(3)}s`;
    }
  }, [stepPreset, customStepSec]);

  /**
   * 立即暂停并沿用 tauRef 同步累加微调步进量，保障快速连点不丢帧
   */
  const stepTau = (direction: -1 | 1) => {
    captureReadySnapshots();
    const activeBounds = activeLoopRange ?? timeline.intersectInterval;
    if (engineRef.current?.getIntendedPlaying() || isPlaying) {
      engineRef.current?.pause();
      setIsPlaying(false);
    }
    const nextTau = Math.max(
      activeBounds.start,
      Math.min(activeBounds.end, tauRef.current + direction * effectiveStepSeconds)
    );
    setTau(nextTau);
    tauRef.current = nextTau;
    metronomeRef.current.reset(nextTau, timeline.effectiveBpm);
    engineRef.current?.seekToTau(nextTau, undefined, false);
  };

  /**
   * 设当前时刻为局部循环起点 A（保障最小宽度 0.1s）
   */
  const handleSetLoopA = () => {
    const iStart = timeline.intersectInterval.start;
    const iEnd = timeline.intersectInterval.end;
    if (iEnd - iStart < 0.1) return;
    const cur = Math.max(iStart, Math.min(iEnd, tauRef.current));
    const existingEnd = activeLoopRange ? activeLoopRange.end : iEnd;
    const nextEnd = cur <= existingEnd - 0.1 ? existingEnd : iEnd;
    const nextStart = Math.max(iStart, Math.min(nextEnd - 0.1, cur));
    const next = { start: nextStart, end: nextEnd };
    updateLoopRange(next);
    if (tauRef.current < next.start || tauRef.current > next.end) {
      seekToTau(Math.max(next.start, Math.min(next.end, tauRef.current)));
    }
  };

  /**
   * 设当前时刻为局部循环终点 B（保障最小宽度 0.1s）
   */
  const handleSetLoopB = () => {
    const iStart = timeline.intersectInterval.start;
    const iEnd = timeline.intersectInterval.end;
    if (iEnd - iStart < 0.1) return;
    const cur = Math.max(iStart, Math.min(iEnd, tauRef.current));
    const existingStart = activeLoopRange ? activeLoopRange.start : iStart;
    const nextStart = cur >= existingStart + 0.1 ? existingStart : iStart;
    const nextEnd = Math.min(iEnd, Math.max(nextStart + 0.1, cur));
    const next = { start: nextStart, end: nextEnd };
    updateLoopRange(next);
    if (tauRef.current < next.start || tauRef.current > next.end) {
      seekToTau(Math.max(next.start, Math.min(next.end, tauRef.current)));
    }
  };

  const handleClearLoop = () => {
    updateLoopRange(null);
  };

  /**
   * 切换对比显示模式
   */
  const handleModeChange = (targetMode: ComparisonMode) => {
    setMode(targetMode);
    onModeChange?.(targetMode);
  };

  /**
   * 切换单侧视频水平镜像
   */
  const toggleMirror = (index: 1 | 2) => {
    if (index === 1) {
      const next = !mirror1;
      setMirror1(next);
      onMirrorChange?.(1, next);
    } else {
      const next = !mirror2;
      setMirror2(next);
      onMirrorChange?.(2, next);
    }
  };

  // Canvas 2D 纯渲染循环 (时钟与调速由 DualVideoSyncEngine 统一驱动)
  useEffect(() => {
    let animId: number;

    const renderLoop = () => {
      if (!isExportActive) {
        const canvas = canvasRef.current;
        const v1 = videoRef1.current;
        const v2 = videoRef2.current;

        if (canvas && v1 && v2) {
          const ctx = canvas.getContext('2d');
          if (ctx) {
            try {
              const currentTau = tauRef.current;
              const v1Active = isTauInVideoRange(currentTau, timeline.span1);
              const v2Active = isTauInVideoRange(currentTau, timeline.span2);
              const isEnginePlaying = engineRef.current?.getIsPlaying() ?? false;

              const source1 = resolveRenderSource(
                1,
                v1,
                video1.url,
                video1.width,
                video1.height,
                v1Active,
                isEnginePlaying,
                fallbackCanvasRef1
              );
              const source2 = resolveRenderSource(
                2,
                v2,
                video2.url,
                video2.width,
                video2.height,
                v2Active,
                isEnginePlaying,
                fallbackCanvasRef2
              );

              const renderState: ComparisonRenderState = {
                mode,
                video1: source1,
                video1Size: { width: video1.width, height: video1.height },
                video1Active: v1Active,
                mirror1,
                triLine1: video1.geometry.triLine,
                video2: source2,
                video2Size: { width: video2.width, height: video2.height },
                video2Active: v2Active,
                mirror2,
                triLine2: video2.geometry.triLine,
                triLineTransform,
                relativeOpacity,
                viewport,
                canvasWidth: canvas.width,
                canvasHeight: canvas.height,
              };

              renderComparisonFrame(ctx, renderState);
            } catch {
              // 容灾捕获：任何渲染帧瞬时异常绝不中断 RAF 主循环
            }
          }
        }
      }

      animId = requestAnimationFrame(renderLoop);
    };

    animId = requestAnimationFrame(renderLoop);
    return () => cancelAnimationFrame(animId);
    // 依赖按渲染循环实际读取的字段收窄：避免 App 层 audioInfo 等无关状态
    // 更新引发的视频对象整体身份变化导致引擎循环被无谓重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isExportActive,
    mode,
    mirror1,
    mirror2,
    triLineTransform,
    relativeOpacity,
    viewport,
    timeline,
    video1.url,
    video1.width,
    video1.height,
    video1.geometry.triLine,
    video2.url,
    video2.width,
    video2.height,
    video2.geometry.triLine,
  ]);

  // 叠加视口单指平移与双指捏合缩放
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const lastDistRef = useRef<number | null>(null);

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size === 2) {
      const pts = Array.from(pointersRef.current.values());
      lastDistRef.current = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pointersRef.current.has(e.pointerId)) return;
    const oldPos = pointersRef.current.get(e.pointerId)!;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (mode !== 'overlay') return;

    if (pointersRef.current.size === 1) {
      const dx = e.clientX - oldPos.x;
      const dy = e.clientY - oldPos.y;
      setViewport((prev) => ({
        ...prev,
        offsetX: prev.offsetX + dx,
        offsetY: prev.offsetY + dy,
      }));
    } else if (pointersRef.current.size === 2) {
      const pts = Array.from(pointersRef.current.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (lastDistRef.current && lastDistRef.current > 0) {
        const factor = dist / lastDistRef.current;
        setViewport((prev) => ({
          ...prev,
          scale: Math.max(0.5, Math.min(4.0, prev.scale * factor)),
        }));
      }
      lastDistRef.current = dist;
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) {
      lastDistRef.current = null;
    }
  };

  const isViewportModified =
    mode === 'overlay' &&
    (viewport.scale !== 1 || viewport.offsetX !== 0 || viewport.offsetY !== 0);

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        position: 'relative',
        backgroundColor: 'var(--bg-canvas)',
      }}
    >
      {/* 共享底层视频解码节点：始终挂载于可见容器下（不放在 display:none 内部），供对比台与导出页共同复用，总并发解码器严格控制在 2 路 */}
      <video
        ref={videoRef1}
        src={video1.url}
        crossOrigin="anonymous"
        playsInline
        preload="auto"
        muted
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '1px',
          height: '1px',
          opacity: 0.01,
          pointerEvents: 'none',
          zIndex: -9999,
        }}
      />
      <video
        ref={videoRef2}
        src={video2.url}
        crossOrigin="anonymous"
        playsInline
        preload="auto"
        muted
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '1px',
          height: '1px',
          opacity: 0.01,
          pointerEvents: 'none',
          zIndex: -9999,
        }}
      />

      {/* 对比台视图：导出激活时仅隐藏界面容器，视频解码节点由导出台无缝接管 */}
      <div
        style={{
          flex: 1,
          display: isExportActive ? 'none' : 'flex',
          flexDirection: 'column',
          minHeight: 0,
          backgroundColor: 'var(--bg-canvas)',
        }}
      >
        {/* 顶部工作台参数栏（可折叠，默认收起） */}
      {isToolbarExpanded && (
        <div className="toolbar-row">
          {/* 左：对比模式切换与视口复位（分区在前、叠加在后） */}
          <div className="control-group fx-row-4">
            <div className="seg-group">
              <button
                type="button"
                onClick={() => handleModeChange('split-screen')}
                className={`seg-btn ${mode === 'split-screen' ? 'active' : ''}`}
                style={{ padding: '0 6px' }}
              >
                <Columns2 size={12} />
                <span>分区</span>
              </button>
              <button
                type="button"
                onClick={() => handleModeChange('overlay')}
                className={`seg-btn ${mode === 'overlay' ? 'active' : ''}`}
                style={{ padding: '0 6px' }}
              >
                <Layers size={12} />
                <span>叠加</span>
              </button>
            </div>

            {isViewportModified && (
              <button
                type="button"
                onClick={() => setViewport({ scale: 1, offsetX: 0, offsetY: 0 })}
                className="btn"
                style={{ padding: '0 6px' }}
              >
                <RotateCcw size={12} />
                <span className="mono-num">{viewport.scale.toFixed(1)}x</span>
              </button>
            )}
          </div>

          {/* 中：声音输出源与双通道独立镜像 */}
          <div className="control-group fx-row-4">
            <div className="seg-group">
              {(
                [
                  { id: 'metronome', label: '节拍器' },
                  { id: 'video1', label: '视频1' },
                  { id: 'video2', label: '视频2' },
                  { id: 'mute', label: '静音' },
                ] as { id: SoundSource; label: string }[]
              ).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    updateSoundSource(item.id);
                    if (item.id === 'metronome') {
                      metronomeRef.current.reset(tauRef.current, timeline.effectiveBpm);
                    }
                  }}
                  className={`seg-btn ${soundSource === item.id ? 'active' : ''}`}
                  style={{ padding: '0 6px' }}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <div className="divider-v" />

            <button
              type="button"
              onClick={() => toggleMirror(1)}
              className={`btn ${mirror1 ? 'btn-active' : ''}`}
              style={{ padding: '0 6px' }}
              title="视频1 水平镜像"
            >
              <HorizontalFlipIcon size={12} />
              <span>视频1</span>
            </button>
            <button
              type="button"
              onClick={() => toggleMirror(2)}
              className={`btn ${mirror2 ? 'btn-active' : ''}`}
              style={{ padding: '0 6px' }}
              title="视频2 水平镜像"
            >
              <HorizontalFlipIcon size={12} />
              <span>视频2</span>
            </button>
          </div>
        </div>
      )}

      {/* 第一栏正中央外侧的长梯形展开/收起拉手按钮 */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'flex-start',
          position: 'relative',
          height: 0,
          zIndex: 35,
        }}
      >
        <button
          type="button"
          onClick={onToggleToolbar}
          title={isToolbarExpanded ? '收起对比工具栏' : '展开对比工具栏'}
          className="workbench-drawer-handle"
          style={{
            height: '20px',
            width: '116px',
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-strong)',
            borderTop: 'none',
            borderRadius: '0 0 8px 8px',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            padding: 0,
            color: 'var(--text-primary)',
            boxShadow: '0 3px 8px rgba(0,0,0,0.55)',
            clipPath: isToolbarExpanded
              ? 'polygon(10% 100%, 90% 100%, 100% 0, 0 0)'
              : 'polygon(0 0, 100% 0, 90% 100%, 10% 100%)',
            transition: 'background-color 0.15s, color 0.15s',
          }}
        >
          <span style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.5px' }}>
            {isToolbarExpanded ? '收起' : '更多'}
          </span>
        </button>
      </div>

      {/* 中部单画布渲染视口 */}
      <div className="workbench-stage">
        <canvas
          ref={canvasRef}
          width={1920}
          height={1080}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          style={{
            maxWidth: '100%',
            maxHeight: '100%',
            objectFit: 'contain',
            touchAction: 'none',
            cursor: mode === 'overlay' ? 'grab' : 'default',
          }}
        />
      </div>

      {/* 底部时间轴与慢放控制台 */}
      <div className="bottom-bar">
        {/* 第一行：统一时间轴滑块与 A-B 局部循环设点 */}
        <div className="control-group fx-row-8">
          <span className="mono-num" style={{ minWidth: '58px' }}>
            {tau >= 0 ? `+${tau.toFixed(2)}s` : `${tau.toFixed(2)}s`}
          </span>

          <div className="workbench-slider-wrap" style={{ position: 'relative', flex: 1, display: 'flex', alignItems: 'center' }}>
            {activeLoopRange && (() => {
              const span = Math.max(0.01, timeline.intersectInterval.end - timeline.intersectInterval.start);
              const leftPct = Math.max(0, Math.min(100, ((activeLoopRange.start - timeline.intersectInterval.start) / span) * 100));
              const rightPct = Math.max(leftPct, Math.min(100, ((activeLoopRange.end - timeline.intersectInterval.start) / span) * 100));
              return (
                <>
                  <div
                    className="ab-loop-highlight"
                    style={{
                      left: `${leftPct}%`,
                      width: `${Math.max(0, rightPct - leftPct)}%`,
                    }}
                    aria-hidden="true"
                  />
                  <div
                    className="ab-loop-marker ab-loop-marker-a"
                    style={{ left: `${leftPct}%` }}
                    aria-hidden="true"
                  />
                  <div
                    className="ab-loop-marker ab-loop-marker-b"
                    style={{ left: `${rightPct}%` }}
                    aria-hidden="true"
                  />
                </>
              );
            })()}
            <input
              type="range"
              className="slider"
              min={timeline.intersectInterval.start}
              max={timeline.intersectInterval.end}
              step="0.01"
              value={tau}
              onChange={(e) => seekToTau(parseFloat(e.target.value))}
              style={{ width: '100%', position: 'relative', zIndex: 2 }}
            />
          </div>

          <div className="control-group fx-row-4" style={{ flexShrink: 0 }}>
            <button
              type="button"
              onClick={handleSetLoopA}
              className={`btn btn-loop-a ${activeLoopRange ? 'active' : ''}`}
              style={{ height: '22px', padding: '0 6px', fontSize: '11px', minWidth: '24px' }}
              title="将当前时刻设为局部循环起点 A"
            >
              A
            </button>
            <button
              type="button"
              onClick={handleSetLoopB}
              className={`btn btn-loop-b ${activeLoopRange ? 'active' : ''}`}
              style={{ height: '22px', padding: '0 6px', fontSize: '11px', minWidth: '24px' }}
              title="将当前时刻设为局部循环终点 B"
            >
              B
            </button>
            {activeLoopRange && (
              <button
                type="button"
                onClick={handleClearLoop}
                className="btn"
                style={{ height: '22px', width: '22px', padding: 0 }}
                title="清除 A-B 循环区间"
                aria-label="清除 A-B 循环"
              >
                <X size={11} />
              </button>
            )}
          </div>

          <span className="mono-muted workbench-range-readout" style={{ minWidth: '94px', textAlign: 'right', fontSize: '11px' }}>
            {!timeline.hasOverlap
              ? '无重叠区间'
              : activeLoopRange
              ? `${activeLoopRange.start.toFixed(1)}~${activeLoopRange.end.toFixed(1)}s`
              : `${timeline.intersectInterval.start.toFixed(1)}s~+${timeline.intersectInterval.end.toFixed(1)}s`}
          </span>
        </div>

        {/* 第二行：锚点/播控、多粒度步进、折叠倍速、叠加透明度、BPM 菜单 */}
        <div
          className="workbench-controls-row fx-row-6"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <div className="control-group fx-row-4" style={{ flexShrink: 0 }}>
            <button
              type="button"
              onClick={playFromPreRoll}
              className="btn"
              style={{ padding: '0 7px' }}
              disabled={!timeline.hasOverlap}
              title={timeline.hasOverlap ? '从锚点前 1 秒起播' : '双视频有效区间无重叠，无法播放'}
            >
              <Crosshair size={12} />
              <span>锚点前 1s</span>
            </button>

            <button
              type="button"
              onClick={togglePlay}
              className="btn btn-accent"
              style={{ padding: '0 8px' }}
              disabled={!timeline.hasOverlap}
              title={timeline.hasOverlap ? undefined : '双视频有效区间无重叠，无法播放'}
            >
              {isPlaying ? <Pause size={13} /> : <Play size={13} />}
              <span>{isPlaying ? '暂停' : '播放'}</span>
            </button>
          </div>

          <div className="control-group fx-row-6" style={{ flexShrink: 0 }}>
            {/* 步进按钮组 + 向上步长菜单 */}
            <div style={{ position: 'relative' }} data-wb-popup="step">
              <div className="seg-group">
                <button
                  type="button"
                  onClick={() => stepTau(-1)}
                  className="seg-btn"
                  style={{ padding: '0 6px' }}
                  title={`后退 ${activeStepLabel}`}
                  aria-label="后退步进"
                >
                  <ChevronLeft size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => setOpenPopup((prev) => (prev === 'step' ? null : 'step'))}
                  className={`seg-btn ${openPopup === 'step' ? 'active' : ''}`}
                  style={{ padding: '0 6px', fontSize: '11px' }}
                  title="选择步进粒度"
                >
                  <span className="mono-num">{activeStepLabel}</span>
                  <ChevronUp
                    size={11}
                    style={{
                      transform: openPopup === 'step' ? 'rotate(180deg)' : 'none',
                      transition: 'transform 0.15s ease',
                    }}
                  />
                </button>
                <button
                  type="button"
                  onClick={() => stepTau(1)}
                  className="seg-btn"
                  style={{ padding: '0 6px' }}
                  title={`前进 ${activeStepLabel}`}
                  aria-label="前进步进"
                >
                  <ChevronRight size={13} />
                </button>
              </div>

              {openPopup === 'step' && (
                <div
                  className="fx-col-6 workbench-popup-menu"
                  style={{ left: '50%', transform: 'translateX(-50%)' }}
                >
                  <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)' }}>
                    步进粒度
                  </div>
                  <div className="seg-group">
                    {(
                      [
                        { id: 'frame', label: '1帧(0.033s)' },
                        { id: '50ms', label: '0.05s' },
                        { id: '100ms', label: '0.10s' },
                        { id: 'beat-quarter', label: '1/4拍' },
                        { id: 'beat-half', label: '1/2拍' },
                        { id: 'custom', label: '自定义' },
                      ] as { id: StepPreset; label: string }[]
                    ).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => {
                          updateStepPreset(opt.id);
                          if (opt.id !== 'custom') {
                            setOpenPopup(null);
                          }
                        }}
                        className={`seg-btn ${stepPreset === opt.id ? 'active' : ''}`}
                        style={{ padding: '0 6px', fontSize: '11px' }}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>

                  {stepPreset === 'custom' && (
                    <div className="fx-row-6" style={{ display: 'flex', alignItems: 'center' }}>
                      <span className="mono-muted" style={{ fontSize: '11px' }}>秒数:</span>
                      <input
                        type="number"
                        step="0.001"
                        min="0.005"
                        className="num-input"
                        value={customStepInputText}
                        onFocus={() => {
                          isEditingCustomStepRef.current = true;
                        }}
                        onChange={(e) => {
                          setCustomStepInputText(e.target.value);
                          const val = parseFloat(e.target.value);
                          if (!isNaN(val) && val >= 0.005) {
                            updateCustomStepSec(val);
                          }
                        }}
                        onBlur={commitCustomStepInput}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            commitCustomStepInput();
                            e.currentTarget.blur();
                          }
                        }}
                        style={{ width: '64px', height: '22px', fontSize: '11px' }}
                      />
                      <span className="mono-muted" style={{ fontSize: '11px' }}>s</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 折叠倍速向上菜单 */}
            <div style={{ position: 'relative' }} data-wb-popup="rate">
              <button
                type="button"
                onClick={() => setOpenPopup((prev) => (prev === 'rate' ? null : 'rate'))}
                className={`btn ${openPopup === 'rate' ? 'btn-active' : ''}`}
                style={{ padding: '0 7px', fontSize: '11px', height: '24px' }}
                title="选择慢放倍速"
              >
                <span className="mono-num">{slowMotionRate}x</span>
                <ChevronUp
                  size={11}
                  style={{
                    transform: openPopup === 'rate' ? 'rotate(180deg)' : 'none',
                    transition: 'transform 0.15s ease',
                  }}
                />
              </button>

              {openPopup === 'rate' && (
                <div
                  className="fx-col-6 workbench-popup-menu"
                  style={{ left: 0 }}
                >
                  <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)' }}>
                    播放倍速
                  </div>
                  <div className="seg-group">
                    {SLOW_MOTION_RATES.map((rate) => (
                      <button
                        key={rate}
                        type="button"
                        onClick={() => {
                          handleRateChange(rate);
                          setOpenPopup(null);
                        }}
                        className={`seg-btn mono-num ${slowMotionRate === rate ? 'active' : ''}`}
                        style={{ padding: '0 6px', fontSize: '11px' }}
                      >
                        {rate}x
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="control-group fx-row-4" style={{ flexShrink: 0 }}>
            {mode === 'overlay' && (
              <div className="control-group fx-row-4">
                <span className="mono-muted" style={{ color: 'var(--ch1)', fontSize: '11px' }}>
                  视频1
                </span>
                <input
                  type="range"
                  className="slider workbench-opacity-slider"
                  min="-1"
                  max="1"
                  step="0.05"
                  value={relativeOpacity}
                  onChange={(e) => setRelativeOpacity(parseFloat(e.target.value))}
                  style={{ width: '56px' }}
                />
                <span className="mono-muted" style={{ color: 'var(--ch2)', fontSize: '11px' }}>
                  视频2
                </span>
                <span className="mono-num" style={{ minWidth: '32px', textAlign: 'right', fontSize: '11px' }}>
                  {relativeOpacity > 0 ? `+${relativeOpacity.toFixed(2)}` : relativeOpacity.toFixed(2)}
                </span>
              </div>
            )}

            {/* 可向上展开的 BPM 对齐策略菜单 */}
            <div style={{ position: 'relative' }} data-wb-popup="bpm">
              <button
                type="button"
                onClick={() => setOpenPopup((prev) => (prev === 'bpm' ? null : 'bpm'))}
                className={`tag-badge workbench-sync-badge ${openPopup === 'bpm' ? 'ch1' : ''}`}
                style={{ cursor: 'pointer', fontSize: '11px', height: '24px' }}
                title="点击选择 BPM 对齐策略"
              >
                <ChevronUp
                  size={12}
                  style={{
                    transform: openPopup === 'bpm' ? 'rotate(180deg)' : 'none',
                    transition: 'transform 0.15s ease',
                  }}
                />
                <span>SYNC {Math.round(timeline.effectiveBpm)}<span className="workbench-bpm-unit"> BPM</span></span>
              </button>

              {openPopup === 'bpm' && (
                <div
                  className="fx-col-6 workbench-popup-menu"
                  style={{ right: 0 }}
                >
                  <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)' }}>
                    BPM 对齐策略
                  </div>
                  <div className="seg-group">
                    <button
                      type="button"
                      onClick={() => {
                        onBpmStrategyChange?.('none', customBpm);
                        setOpenPopup(null);
                      }}
                      className={`seg-btn ${bpmStrategy === 'none' ? 'active' : ''}`}
                      style={{ padding: '0 6px', fontSize: '11px' }}
                    >
                      原速
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        onBpmStrategyChange?.('left', customBpm);
                        setOpenPopup(null);
                      }}
                      className={`seg-btn ${bpmStrategy === 'left' ? 'active' : ''}`}
                      style={{ padding: '0 6px', fontSize: '11px' }}
                    >
                      随 视频1 ({video1.audioInfo?.userBpm || DEFAULT_BPM})
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        onBpmStrategyChange?.('right', customBpm);
                        setOpenPopup(null);
                      }}
                      className={`seg-btn ${bpmStrategy === 'right' ? 'active' : ''}`}
                      style={{ padding: '0 6px', fontSize: '11px' }}
                    >
                      随 视频2 ({video2.audioInfo?.userBpm || DEFAULT_BPM})
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        onBpmStrategyChange?.('custom', customBpm);
                      }}
                      className={`seg-btn ${bpmStrategy === 'custom' ? 'active' : ''}`}
                      style={{ padding: '0 6px', fontSize: '11px' }}
                    >
                      手动
                    </button>
                  </div>

                  {bpmStrategy === 'custom' && (
                    <div className="fx-row-6" style={{ display: 'flex', alignItems: 'center', marginTop: '2px' }}>
                      <span className="mono-muted" style={{ fontSize: '11px' }}>目标 BPM:</span>
                      <input
                        type="number"
                        className="num-input"
                        value={customBpm}
                        onChange={(e) => {
                          const val = Math.max(1, parseInt(e.target.value, 10) || DEFAULT_BPM);
                          onBpmStrategyChange?.('custom', val);
                        }}
                        style={{ width: '56px', height: '22px', fontSize: '11px' }}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      </div>

      {/* 独立导出片段视图：复用对比台的共享视频解码节点，避免重复创建 4 路视频导致老机黑屏 */}
      {isExportActive && (
        <ExportPage
          video1={video1}
          video2={video2}
          sharedVideo1Ref={videoRef1}
          sharedVideo2Ref={videoRef2}
          timeline={timeline}
          initialMode={mode}
          initialMirror1={mirror1}
          initialMirror2={mirror2}
          triLineTransform={triLineTransform}
          initialViewport={viewport}
          initialOpacity={relativeOpacity}
          initialRate={slowMotionRate}
          initialSoundSource={soundSource}
          currentPlayTau={tau}
          initialLoopRange={activeLoopRange}
          onBack={() => {
            if (onNavigate) {
              onNavigate('workbench');
            } else {
              setIsExportPageOpen(false);
            }
          }}
        />
      )}
    </div>
  );
};
