import React, { useRef, useState, useEffect, useMemo } from 'react';
import {
  Play,
  Pause,
  Crosshair,
  Volume2,
  Activity,
  Minus,
  Plus,
} from 'lucide-react';
import type {
  TriLineModelType,
  TwoHorizontalOneVertical,
  TwoVerticalOneHorizontal,
  VideoGeometryConfig,
} from '../types/geometry.ts';
import type { VideoAudioInfo, TimeInterval } from '../types/timeline.ts';
import { DEFAULT_BPM } from '../types/timeline.ts';
import type { LoadedVideoItem } from '../types/media.ts';
import { TapTempoTracker, detectBpmFromSlice } from '../core/audio.ts';
import { getPcm, hasPcm } from '../core/pcmStore.ts';
import { SynthesizedMetronome } from '../core/metronome.ts';

interface CalibrationStepProps {
  videoItem: LoadedVideoItem;
  videoIndex: 1 | 2;
  model: TriLineModelType;
  onSpatialChange: (updatedGeometry: VideoGeometryConfig) => void;
  onSpatialTouched: () => void;
  onAudioChange: (updatedAudio: VideoAudioInfo) => void;
  onAudioAnchorTouched: () => void;
}

/**
 * 单视频空间与时间同屏一体标定视图（视频1 / 视频2），共享同一视频节点同步标定三线与对拍锚点
 */
export const CalibrationStep: React.FC<CalibrationStepProps> = ({
  videoItem,
  videoIndex,
  model,
  onSpatialChange,
  onSpatialTouched,
  onAudioChange,
  onAudioAnchorTouched,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const waveformContainerRef = useRef<HTMLDivElement>(null);

  // 空间标定状态
  const [mirror, setMirror] = useState<boolean>(videoItem.geometry.mirror);
  const [twoHOneV, setTwoHOneV] = useState<TwoHorizontalOneVertical>(videoItem.geometry.triLine.twoHOneV);
  const [twoVOneH, setTwoVOneH] = useState<TwoVerticalOneHorizontal>(videoItem.geometry.triLine.twoVOneH);
  const [draggingTarget, setDraggingTarget] = useState<string | null>(null);
  const [stageSize, setStageSize] = useState<{ width: number; height: number }>({
    width: 960,
    height: 480,
  });

  // 音频与时间标定状态（useMemo 避免每次渲染重建对象导致的波形 Canvas 无谓全量重绘）
  const initialAudio: VideoAudioInfo = useMemo(() => {
    return videoItem.audioInfo || {
      duration: videoItem.duration,
      sampleRate: 16000,
      hasAudioTrack: false,
      audioDegraded: true,
      detectedBpm: DEFAULT_BPM,
      userBpm: DEFAULT_BPM,
      anchorTime: Math.min(1.0, Math.max(0.25, videoItem.duration / 4)),
      waveform: new Float32Array(1000).fill(0.25),
      trimRange: { start: 0, end: videoItem.duration > 0 ? videoItem.duration : 1 },
    };
  }, [videoItem.audioInfo, videoItem.duration]);
  const totalDuration =
    videoItem.duration > 0 ? videoItem.duration : initialAudio.duration || 1;

  const [trimStart, setTrimStart] = useState<number>(initialAudio.trimRange?.start ?? 0);
  const [trimEnd, setTrimEnd] = useState<number>(initialAudio.trimRange?.end ?? totalDuration);
  const [draggingHandle, setDraggingHandle] = useState<'start' | 'end' | null>(null);
  const [bpm, setBpm] = useState<number>(initialAudio.userBpm || DEFAULT_BPM);
  const [anchorTime, setAnchorTime] = useState<number>(
    typeof initialAudio.anchorTime === 'number' ? initialAudio.anchorTime : 1.0
  );
  const [anchorInputText, setAnchorInputText] = useState<string>(
    (typeof initialAudio.anchorTime === 'number' ? initialAudio.anchorTime : 1.0).toFixed(3)
  );

  // 共用播放进度状态
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);

  const trimStartRef = useRef<number>(trimStart);
  const trimEndRef = useRef<number>(trimEnd);
  const debounceBpmTimerRef = useRef<number | null>(null);
  const tapTrackerRef = useRef<TapTempoTracker>(new TapTempoTracker());
  const [tapActive, setTapActive] = useState<boolean>(false);
  const [isScrubbingWaveform, setIsScrubbingWaveform] = useState<boolean>(false);
  const AUDITION_VIDEO_VOLUME = 0.3;
  const metronomeRef = useRef<SynthesizedMetronome | null>(null);
  const auditionRestoreTimerRef = useRef<number | null>(null);
  const auditionVolumeRafRef = useRef<number | null>(null);
  const auditionPendingRef = useRef<{
    armed: boolean;
    anchor: number;
    observedPreAnchor: boolean;
  }>({ armed: false, anchor: 1.0, observedPreAnchor: false });

  const getMetronome = () => {
    if (!metronomeRef.current) {
      metronomeRef.current = new SynthesizedMetronome();
    }
    return metronomeRef.current;
  };

  const restoreVideoVolume = (immediate: boolean = true) => {
    if (auditionRestoreTimerRef.current) {
      window.clearTimeout(auditionRestoreTimerRef.current);
      auditionRestoreTimerRef.current = null;
    }
    if (auditionVolumeRafRef.current) {
      cancelAnimationFrame(auditionVolumeRafRef.current);
      auditionVolumeRafRef.current = null;
    }
    const video = videoRef.current;
    if (!video) return;
    if (immediate) {
      video.volume = 1.0;
      return;
    }
    const startVol = video.volume;
    const startTs = performance.now();
    const durationMs = 180;
    const step = (now: number) => {
      const targetVideo = videoRef.current;
      if (!targetVideo) {
        auditionVolumeRafRef.current = null;
        return;
      }
      const progress = Math.min(1, (now - startTs) / durationMs);
      targetVideo.volume = startVol + (1.0 - startVol) * progress;
      if (progress < 1) {
        auditionVolumeRafRef.current = requestAnimationFrame(step);
      } else {
        auditionVolumeRafRef.current = null;
      }
    };
    auditionVolumeRafRef.current = requestAnimationFrame(step);
  };

  const clearAuditionArm = () => {
    auditionPendingRef.current = { armed: false, anchor: 0, observedPreAnchor: false };
    restoreVideoVolume(true);
  };
  // 真实音轨 = 显式 hasAudioTrack 标记且 PCM 注册表内确实存在可重算数据
  const hasRealAudio = Boolean(
    videoItem.audioInfo &&
      videoItem.audioInfo.hasAudioTrack &&
      !videoItem.audioInfo.audioDegraded &&
      hasPcm(videoItem.url)
  );
  const syncedHasAudioRef = useRef<boolean>(hasRealAudio);
  const userEditedRef = useRef<{ bpm: boolean; trim: boolean; anchor: boolean }>({
    bpm: false,
    trim: false,
    anchor: false,
  });
  const userSeekedRef = useRef<boolean>(false);

  trimStartRef.current = trimStart;
  trimEndRef.current = trimEnd;

  // 同步外部几何配置变更（例如顶部按钮点击“镜像”或切换三线模型）
  useEffect(() => {
    setMirror(videoItem.geometry.mirror);
    setTwoHOneV(videoItem.geometry.triLine.twoHOneV);
    setTwoVOneH(videoItem.geometry.triLine.twoVOneH);
  }, [videoItem.geometry]);

  // 卸载清理定时器与试听节拍器
  useEffect(() => {
    return () => {
      if (debounceBpmTimerRef.current) {
        window.clearTimeout(debounceBpmTimerRef.current);
      }
      clearAuditionArm();
      if (metronomeRef.current) {
        metronomeRef.current.dispose();
        metronomeRef.current = null;
      }
    };
  }, []);

  // 切换视频通道或导入新视频源时同步恢复该视频的音频与找帧初始化
  useEffect(() => {
    clearAuditionArm();
    const audio = videoItem.audioInfo;
    const dur = videoItem.duration > 0 ? videoItem.duration : audio?.duration || 1;
    const nextBpm = audio?.userBpm || DEFAULT_BPM;
    const nextTrimStart = audio?.trimRange?.start ?? 0;
    const nextTrimEnd = audio?.trimRange?.end ?? dur;
    const rawAnchor = typeof audio?.anchorTime === 'number' ? audio.anchorTime : 1.0;
    const nextAnchor = Math.max(nextTrimStart, Math.min(nextTrimEnd, rawAnchor));

    syncedHasAudioRef.current = Boolean(
      audio && audio.hasAudioTrack && !audio.audioDegraded && hasPcm(videoItem.url)
    );
    userEditedRef.current = { bpm: false, trim: false, anchor: false };
    userSeekedRef.current = false;

    setBpm(nextBpm);
    setAnchorTime(nextAnchor);
    setAnchorInputText(nextAnchor.toFixed(3));
    setTrimStart(nextTrimStart);
    setTrimEnd(nextTrimEnd);
    setIsPlaying(false);

    const video = videoRef.current;
    if (!video) {
      setCurrentTime(nextAnchor);
      return;
    }

    if (!video.paused) {
      video.pause();
    }

    const seekOnReady = () => {
      if (video.readyState < 1) return;
      const safeDur = video.duration > 0 ? video.duration : nextTrimEnd;
      const clamped = Math.max(0, Math.min(safeDur, nextAnchor));
      // 避免老旧 Android WebView 在 0.00s 显示灰色播放占位图标
      const target = clamped > 0 ? clamped : Math.min(0.01, (safeDur || 1) / 2);
      if (target > 0) {
        video.currentTime = target;
        setCurrentTime(target);
      }
    };

    const onTimeUpdate = () => setCurrentTime(video.currentTime);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => {
      clearAuditionArm();
      setIsPlaying(false);
    };

    video.addEventListener('loadedmetadata', seekOnReady);
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);

    if (video.readyState >= 1) {
      seekOnReady();
    } else {
      setCurrentTime(nextAnchor);
    }

    return () => {
      video.removeEventListener('loadedmetadata', seekOnReady);
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
    };
  }, [videoItem.url, videoIndex]);

  // 监听异步元信息与音轨解码到达：若用户提前进入标定页，解码完成后无感刷新波形、时长与真实 BPM
  useEffect(() => {
    const audio = videoItem.audioInfo;
    const dur = videoItem.duration > 0 ? videoItem.duration : audio?.duration || 1;
    const realAudioArrived = Boolean(
      audio && audio.hasAudioTrack && !audio.audioDegraded && hasPcm(videoItem.url)
    );

    if (!realAudioArrived) {
      if (!userEditedRef.current.trim) {
        setTrimStart(0);
        setTrimEnd(dur);
      }
      return;
    }

    if (audio && !syncedHasAudioRef.current) {
      syncedHasAudioRef.current = true;
      const nextTrim: TimeInterval = userEditedRef.current.trim
        ? {
            start: trimStartRef.current,
            end: Math.min(dur, Math.max(trimStartRef.current + 0.5, trimEndRef.current)),
          }
        : {
            start: audio.trimRange?.start ?? 0,
            end: audio.trimRange?.end ?? dur,
          };
      const nextBpm = userEditedRef.current.bpm ? bpm : (audio.userBpm || DEFAULT_BPM);
      const rawAnchor = userEditedRef.current.anchor
        ? anchorTime
        : (typeof audio.anchorTime === 'number' ? audio.anchorTime : 1.0);
      const clampedAnchor = Math.max(nextTrim.start, Math.min(nextTrim.end, rawAnchor));

      setBpm(nextBpm);
      setTrimStart(nextTrim.start);
      setTrimEnd(nextTrim.end);
      setAnchorTime(clampedAnchor);
      setAnchorInputText(clampedAnchor.toFixed(3));

      if (userEditedRef.current.bpm || userEditedRef.current.trim || userEditedRef.current.anchor) {
        onAudioChange({
          ...audio,
          duration: dur,
          userBpm: nextBpm,
          anchorTime: clampedAnchor,
          trimRange: nextTrim,
        });
      } else if (!userSeekedRef.current) {
        const video = videoRef.current;
        if (video && video.readyState >= 1 && video.paused) {
          const safeDur = video.duration > 0 ? video.duration : nextTrim.end;
          const clamped = Math.max(0, Math.min(safeDur, clampedAnchor));
          const target = clamped > 0 ? clamped : Math.min(0.01, (safeDur || 1) / 2);
          if (target > 0) {
            video.currentTime = target;
            setCurrentTime(target);
          }
        }
      }
    }
  }, [videoItem.audioInfo, videoItem.duration]);

  // 监听舞台容器尺寸以计算视频精确内接矩形
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setStageSize({ width: rect.width, height: rect.height });
      }
    };
    updateSize();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(updateSize);
      observer.observe(el);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', updateSize);
    return () => window.removeEventListener('resize', updateSize);
  }, []);

  // 60fps 更新当前播放游标并在 [trimStart, trimEnd] 内闭环循环
  useEffect(() => {
    let animId: number;
    const updateLoop = () => {
      const video = videoRef.current;
      if (video && !video.paused) {
        const nowTime = video.currentTime;
        const pending = auditionPendingRef.current;
        if (pending.armed && !video.seeking && video.readyState >= 2) {
          if (!pending.observedPreAnchor) {
            if (nowTime < pending.anchor) {
              pending.observedPreAnchor = true;
            }
          } else if (nowTime >= pending.anchor) {
            pending.armed = false;
            pending.observedPreAnchor = false;
            getMetronome().playClick(true);
            // 重拍响后短暂停留避让再平滑恢复视频原声，确保不与原曲抢占系统混音动态范围
            if (auditionRestoreTimerRef.current) {
              window.clearTimeout(auditionRestoreTimerRef.current);
            }
            auditionRestoreTimerRef.current = window.setTimeout(() => {
              auditionRestoreTimerRef.current = null;
              restoreVideoVolume(false);
            }, 200);
          }
        }

        if (nowTime >= trimEnd) {
          clearAuditionArm();
          video.currentTime = trimStart;
          setCurrentTime(trimStart);
        } else {
          setCurrentTime(nowTime);
        }
      }
      animId = requestAnimationFrame(updateLoop);
    };
    animId = requestAnimationFrame(updateLoop);
    return () => cancelAnimationFrame(animId);
  }, [trimStart, trimEnd]);

  // 绘制音频波形、节拍刻度、对拍锚点线与实时播放游标
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    const midY = height / 2;
    const waveform = initialAudio.waveform;

    ctx.clearRect(0, 0, width, height);

    // 1. 中心零电平基准线
    ctx.strokeStyle = 'rgba(63, 63, 70, 0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(width, midY);
    ctx.stroke();

    // 2. 对称音频包络波形
    if (waveform && waveform.length > 0) {
      ctx.fillStyle = videoIndex === 1 ? '#38bdf8' : '#10b981';
      const barWidth = width / waveform.length;
      for (let i = 0; i < waveform.length; i++) {
        const amp = waveform[i] * (height / 2) * 0.86;
        const x = i * barWidth;
        ctx.fillRect(x, midY - amp, Math.max(1, barWidth - 0.5), amp * 2);
      }
    }

    // 3. 基于锚点与 BPM 生成的节拍刻度
    if (bpm > 0 && totalDuration > 0) {
      const beatInterval = 60 / bpm;
      const totalBeats = Math.floor(totalDuration / beatInterval);
      const step = totalBeats > 120 ? 4 : 1;

      for (let t = anchorTime % beatInterval; t <= totalDuration; t += beatInterval) {
        if (t < 0) continue;
        const beatNum = Math.round((t - anchorTime) / beatInterval);
        if (beatNum % step !== 0) continue;

        const isDownbeat = beatNum % 4 === 0;
        const x = (t / totalDuration) * width;

        ctx.strokeStyle = isDownbeat
          ? 'rgba(244, 244, 245, 0.16)'
          : 'rgba(244, 244, 245, 0.05)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();

        const tickH = isDownbeat ? 9 : 4;
        ctx.strokeStyle = isDownbeat ? '#f59e0b' : 'rgba(244, 244, 245, 0.35)';
        ctx.lineWidth = isDownbeat ? 1.5 : 1;

        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, tickH);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(x, height);
        ctx.lineTo(x, height - tickH);
        ctx.stroke();
      }
    }

    // 4. 对拍锚点标记线
    const anchorX = (anchorTime / totalDuration) * width;
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(anchorX, 0);
    ctx.lineTo(anchorX, height);
    ctx.stroke();

    ctx.fillStyle = '#f59e0b';
    ctx.beginPath();
    ctx.moveTo(anchorX - 5, 0);
    ctx.lineTo(anchorX + 5, 0);
    ctx.lineTo(anchorX, 8);
    ctx.closePath();
    ctx.fill();

    // 5. 当前时间游标线
    const currentX = (currentTime / totalDuration) * width;
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(currentX, 0);
    ctx.lineTo(currentX, height);
    ctx.stroke();
  }, [initialAudio, anchorTime, currentTime, bpm, totalDuration, videoIndex]);

  // ---- 空间三线标尺交互 ----

  const commitGeometry = (
    nextMirror: boolean,
    nextTwoHOneV: TwoHorizontalOneVertical,
    nextTwoVOneH: TwoVerticalOneHorizontal
  ) => {
    setMirror(nextMirror);
    setTwoHOneV(nextTwoHOneV);
    setTwoVOneH(nextTwoVOneH);
    onSpatialChange({
      mirror: nextMirror,
      triLine: {
        model,
        twoHOneV: nextTwoHOneV,
        twoVOneH: nextTwoVOneH,
      },
    });
  };

  const handleLinePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingTarget || !frameRef.current) return;
    const rect = frameRef.current.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const normX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const normY = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));

    let nextTwoHOneV = twoHOneV;
    let nextTwoVOneH = twoVOneH;

    if (model === 'two-horizontal-one-vertical') {
      if (draggingTarget === 'yA') {
        nextTwoHOneV = { ...twoHOneV, yA: Math.min(normY, twoHOneV.yB - 0.03) };
      } else if (draggingTarget === 'yB') {
        nextTwoHOneV = { ...twoHOneV, yB: Math.max(normY, twoHOneV.yA + 0.03) };
      } else if (draggingTarget === 'x0') {
        nextTwoHOneV = { ...twoHOneV, x0: normX };
      }
    } else {
      if (draggingTarget === 'xA') {
        nextTwoVOneH = { ...twoVOneH, xA: Math.min(normX, twoVOneH.xB - 0.03) };
      } else if (draggingTarget === 'xB') {
        nextTwoVOneH = { ...twoVOneH, xB: Math.max(normX, twoVOneH.xA + 0.03) };
      } else if (draggingTarget === 'y0') {
        nextTwoVOneH = { ...twoVOneH, y0: normY };
      }
    }

    onSpatialTouched();
    commitGeometry(mirror, nextTwoHOneV, nextTwoVOneH);
  };

  const handleLinePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingTarget) return;
    try {
      const target = e.target as HTMLElement;
      if (target && typeof target.releasePointerCapture === 'function') {
        target.releasePointerCapture(e.pointerId);
      }
    } catch {}
    setDraggingTarget(null);
  };

  const startDragLine = (targetKey: string, e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {}
    setDraggingTarget(targetKey);
  };

  // ---- 找帧播放控制 ----

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    clearAuditionArm();
    userSeekedRef.current = true;
    video.preservesPitch = true;
    video.playbackRate = 1.0;
    if (video.paused) {
      if (video.currentTime < trimStart || video.currentTime >= trimEnd - 0.05) {
        video.currentTime = trimStart;
        setCurrentTime(trimStart);
      }
      video.play().catch(() => {});
      setIsPlaying(true);
    } else {
      video.pause();
      setIsPlaying(false);
    }
  };

  // ---- 音频波形、锚点与截取区间交互 ----

  const commitAudioState = (
    nextBpm: number,
    nextAnchor: number,
    nextTrim?: TimeInterval,
    syncAnchorText: boolean = true
  ) => {
    const activeTrim = nextTrim || { start: trimStart, end: trimEnd };
    const clampedAnchor = Math.max(activeTrim.start, Math.min(activeTrim.end, nextAnchor));

    setBpm(nextBpm);
    setAnchorTime(clampedAnchor);
    if (syncAnchorText) {
      setAnchorInputText(clampedAnchor.toFixed(3));
    }
    if (nextTrim) {
      setTrimStart(nextTrim.start);
      setTrimEnd(nextTrim.end);
    }
    onAudioChange({
      ...initialAudio,
      duration: totalDuration,
      userBpm: nextBpm,
      anchorTime: clampedAnchor,
      trimRange: activeTrim,
    });
  };

  const recalculateBpmForTrim = (tStart: number, tEnd: number) => {
    const pcm = getPcm(videoItem.url);
    const sampleRate = videoItem.audioInfo?.sampleRate || 44100;
    let computedBpm = bpm;
    if (pcm && pcm.length > 0 && sampleRate > 0) {
      const detected = detectBpmFromSlice(pcm, sampleRate, tStart, tEnd, bpm);
      if (detected > 0) {
        computedBpm = detected;
      }
    }
    const clampedAnchor = Math.max(tStart, Math.min(tEnd, anchorTime));
    commitAudioState(computedBpm, clampedAnchor, { start: tStart, end: tEnd });
  };

  const seekByClientX = (clientX: number) => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;

    userSeekedRef.current = true;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const targetTime = ratio * totalDuration;

    video.currentTime = targetTime;
    setCurrentTime(targetTime);
  };

  const commitAnchorInput = () => {
    const parsed = parseFloat(anchorInputText);
    if (!isNaN(parsed)) {
      const clamped = Math.max(trimStart, Math.min(trimEnd, parsed));
      const formatted = clamped.toFixed(3);
      const aligned = Math.max(trimStart, Math.min(trimEnd, parseFloat(formatted)));
      setAnchorInputText(aligned.toFixed(3));
      userEditedRef.current.anchor = true;
      commitAudioState(bpm, aligned);
    } else {
      setAnchorInputText(anchorTime.toFixed(3));
    }
  };

  const handleWaveformPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    clearAuditionArm();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
    const video = videoRef.current;
    if (video && !video.paused) {
      video.pause();
      setIsPlaying(false);
    }
    setIsScrubbingWaveform(true);
    seekByClientX(e.clientX);
  };

  const handleWaveformPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isScrubbingWaveform) return;
    seekByClientX(e.clientX);
  };

  const handleWaveformPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isScrubbingWaveform) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}
    setIsScrubbingWaveform(false);
  };

  const setAsAnchor = () => {
    clearAuditionArm();
    const video = videoRef.current;
    const t = video ? video.currentTime : currentTime;
    const clamped = Math.max(trimStart, Math.min(trimEnd, t));
    userEditedRef.current.anchor = true;
    commitAudioState(bpm, clamped);
    onAudioAnchorTouched();
  };

  const jumpToAnchor = () => {
    const video = videoRef.current;
    if (!video) return;

    // 在用户交互手势内预热节拍器音频上下文；试听期间适度压低原片伴奏音量以保留足够动态余量
    restoreVideoVolume(true);
    video.volume = AUDITION_VIDEO_VOLUME;
    getMetronome().unlock();
    const preRoll = Math.max(0, anchorTime - 0.6);
    auditionPendingRef.current = {
      armed: true,
      anchor: anchorTime,
      observedPreAnchor: preRoll >= anchorTime - 0.02,
    };

    video.currentTime = preRoll;
    setCurrentTime(preRoll);
    video.preservesPitch = true;
    video.playbackRate = 1.0;
    video.play().catch(() => {
      clearAuditionArm();
    });
    setIsPlaying(true);
  };

  const handleTap = () => {
    setTapActive(true);
    const detected = tapTrackerRef.current.tap();
    if (detected) {
      userEditedRef.current.bpm = true;
      commitAudioState(detected, anchorTime);
    }
    setTimeout(() => setTapActive(false), 180);
  };

  const handleTrimPointerDown = (handle: 'start' | 'end', e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    clearAuditionArm();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    userEditedRef.current.trim = true;
    userSeekedRef.current = true;
    setDraggingHandle(handle);

    const video = videoRef.current;
    if (video && !video.paused) {
      video.pause();
      setIsPlaying(false);
    }
  };

  const handleTrimPointerMove = (e: React.PointerEvent) => {
    if (!draggingHandle || !waveformContainerRef.current) return;
    const rect = waveformContainerRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const targetTime = ratio * totalDuration;
    const video = videoRef.current;

    let nextStart = trimStartRef.current;
    let nextEnd = trimEndRef.current;

    if (draggingHandle === 'start') {
      nextStart = Math.max(0, Math.min(trimEndRef.current - 0.5, targetTime));
      setTrimStart(nextStart);
      trimStartRef.current = nextStart;
      if (video) video.currentTime = nextStart;
      setCurrentTime(nextStart);
    } else if (draggingHandle === 'end') {
      nextEnd = Math.min(totalDuration, Math.max(trimStartRef.current + 0.5, targetTime));
      setTrimEnd(nextEnd);
      trimEndRef.current = nextEnd;
      if (video) video.currentTime = nextEnd;
      setCurrentTime(nextEnd);
    }

    const clampedAnchor = Math.max(nextStart, Math.min(nextEnd, anchorTime));
    commitAudioState(bpm, clampedAnchor, { start: nextStart, end: nextEnd });

    if (debounceBpmTimerRef.current) {
      window.clearTimeout(debounceBpmTimerRef.current);
    }
    debounceBpmTimerRef.current = window.setTimeout(() => {
      recalculateBpmForTrim(trimStartRef.current, trimEndRef.current);
    }, 200);
  };

  const handleTrimPointerUp = (e: React.PointerEvent) => {
    if (!draggingHandle) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
    setDraggingHandle(null);

    if (debounceBpmTimerRef.current) {
      window.clearTimeout(debounceBpmTimerRef.current);
      debounceBpmTimerRef.current = null;
    }
    recalculateBpmForTrim(trimStartRef.current, trimEndRef.current);
  };

  // 计算当前舞台内接视频精确画幅
  const vW = Math.max(1, videoItem.width);
  const vH = Math.max(1, videoItem.height);
  const fitScale = Math.min(stageSize.width / vW, stageSize.height / vH);
  const frameWidth = Math.max(1, Math.floor(vW * fitScale));
  const frameHeight = Math.max(1, Math.floor(vH * fitScale));

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        backgroundColor: 'var(--bg-canvas)',
      }}
      onPointerMove={handleLinePointerMove}
      onPointerUp={handleLinePointerUp}
      onPointerCancel={handleLinePointerUp}
    >
      {/* 中部共享视频舞台：三线标尺常驻叠放于视频画幅上，与底部波形面板同屏协作 */}
      <div ref={stageRef} className="calib-stage">
        <div
          ref={frameRef}
          className="calib-frame"
          style={{ width: `${frameWidth}px`, height: `${frameHeight}px` }}
        >
          {/* 仅对视频画面本身应用镜像翻转，标尺标签保持标准正向 */}
          <div
            style={{
              width: '100%',
              height: '100%',
              transform: mirror ? 'scaleX(-1)' : 'none',
              pointerEvents: 'none',
            }}
          >
            <video
              ref={videoRef}
              src={videoItem.url}
              crossOrigin="anonymous"
              preload="auto"
              style={{
                width: '100%',
                height: '100%',
                display: 'block',
                pointerEvents: 'none',
              }}
              playsInline
            />
          </div>

          {model === 'two-horizontal-one-vertical' ? (
            <>
                <div
                  className="calib-line-h"
                  style={
                    {
                      top: `${twoHOneV.yA * 100}%`,
                      '--line-color': '#f59e0b',
                    } as React.CSSProperties
                  }
                  onPointerDown={(e) => startDragLine('yA', e)}
                >
                  <span
                    className="calib-tag"
                    style={
                      {
                        left: '10px',
                        top: '12px',
                        '--line-color': '#f59e0b',
                      } as React.CSSProperties
                    }
                  >
                    头顶
                  </span>
                </div>

                <div
                  className="calib-line-h"
                  style={
                    {
                      top: `${twoHOneV.yB * 100}%`,
                      '--line-color': '#10b981',
                    } as React.CSSProperties
                  }
                  onPointerDown={(e) => startDragLine('yB', e)}
                >
                  <span
                    className="calib-tag"
                    style={
                      {
                        right: '10px',
                        bottom: '12px',
                        '--line-color': '#10b981',
                      } as React.CSSProperties
                    }
                  >
                    脚底
                  </span>
                </div>

                <div
                  className="calib-line-v"
                  style={
                    {
                      left: `${twoHOneV.x0 * 100}%`,
                      '--line-color': '#38bdf8',
                    } as React.CSSProperties
                  }
                  onPointerDown={(e) => startDragLine('x0', e)}
                >
                  <span
                    className="calib-tag"
                    style={
                      {
                        top: '12px',
                        left: '50%',
                        transform: 'translateX(-50%)',
                        '--line-color': '#38bdf8',
                      } as React.CSSProperties
                    }
                  >
                    中轴
                  </span>
                </div>
              </>
            ) : (
              <>
                <div
                  className="calib-line-v"
                  style={
                    {
                      left: `${twoVOneH.xA * 100}%`,
                      '--line-color': '#38bdf8',
                    } as React.CSSProperties
                  }
                  onPointerDown={(e) => startDragLine('xA', e)}
                >
                  <span
                    className="calib-tag"
                    style={
                      {
                        top: '12px',
                        left: '50%',
                        transform: 'translateX(-50%)',
                        '--line-color': '#38bdf8',
                      } as React.CSSProperties
                    }
                  >
                    左脚
                  </span>
                </div>

                <div
                  className="calib-line-v"
                  style={
                    {
                      left: `${twoVOneH.xB * 100}%`,
                      '--line-color': '#f59e0b',
                    } as React.CSSProperties
                  }
                  onPointerDown={(e) => startDragLine('xB', e)}
                >
                  <span
                    className="calib-tag"
                    style={
                      {
                        top: '12px',
                        left: '50%',
                        transform: 'translateX(-50%)',
                        '--line-color': '#f59e0b',
                      } as React.CSSProperties
                    }
                  >
                    右脚
                  </span>
                </div>

                <div
                  className="calib-line-h"
                  style={
                    {
                      top: `${twoVOneH.y0 * 100}%`,
                      '--line-color': '#10b981',
                    } as React.CSSProperties
                  }
                  onPointerDown={(e) => startDragLine('y0', e)}
                >
                  <span
                    className="calib-tag"
                    style={
                      {
                        right: '10px',
                        bottom: '12px',
                        '--line-color': '#10b981',
                      } as React.CSSProperties
                    }
                  >
                    地面
                  </span>
                </div>
              </>
            )}
        </div>
      </div>

      {/* 底部一体波形找帧与时间对拍控制面板 */}
      <div className="bottom-bar fx-col-8 calib-bottom-bar">
        <div
          ref={waveformContainerRef}
          onPointerMove={handleTrimPointerMove}
          onPointerUp={handleTrimPointerUp}
          onPointerCancel={handleTrimPointerUp}
          className="calib-waveform-wrap"
          style={{
            position: 'relative',
            height: '46px',
            width: '100%',
            overflow: 'hidden',
            borderRadius: '4px',
            userSelect: 'none',
          }}
        >
          <canvas
            ref={canvasRef}
            width={1200}
            height={46}
            onPointerDown={handleWaveformPointerDown}
            onPointerMove={handleWaveformPointerMove}
            onPointerUp={handleWaveformPointerUp}
            onPointerCancel={handleWaveformPointerUp}
            style={{
              width: '100%',
              height: '100%',
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--border)',
              borderRadius: '4px',
              cursor: 'crosshair',
              touchAction: 'none',
              display: 'block',
            }}
          />

            {/* 左侧非有效截取区遮罩 */}
            <div
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: 0,
                width: `${(trimStart / totalDuration) * 100}%`,
                backgroundColor: 'rgba(0, 0, 0, 0.65)',
                pointerEvents: 'none',
                borderRight: '1px dashed rgba(245, 158, 11, 0.6)',
              }}
            />

            {/* 右侧非有效截取区遮罩 */}
            <div
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: `${(trimEnd / totalDuration) * 100}%`,
                right: 0,
                backgroundColor: 'rgba(0, 0, 0, 0.65)',
                pointerEvents: 'none',
                borderLeft: '1px dashed rgba(245, 158, 11, 0.6)',
              }}
            />

            {/* 左截取手柄 [ */}
            <div
              onPointerDown={(e) => handleTrimPointerDown('start', e)}
              style={{
                position: 'absolute',
                left: `${(trimStart / totalDuration) * 100}%`,
                top: 0,
                bottom: 0,
                transform: 'translateX(-50%)',
                width: '28px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'ew-resize',
                zIndex: 10,
                touchAction: 'none',
              }}
              title="拖拽微调目标招式起点 ["
            >
              <div
                style={{
                  width: '14px',
                  height: '42px',
                  backgroundColor: 'rgba(24, 24, 27, 0.95)',
                  border: '1.5px solid var(--accent)',
                  borderRadius: '3px 0 0 3px',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.8)',
                }}
              >
                <span style={{ fontSize: '13px', fontWeight: 800, color: 'var(--accent)', lineHeight: 1 }}>
                  [
                </span>
              </div>
              <span
                className="mono-num"
                style={{
                  position: 'absolute',
                  top: '2px',
                  right: '16px',
                  fontSize: '10px',
                  backgroundColor: 'rgba(9, 9, 11, 0.85)',
                  color: 'var(--accent)',
                  padding: '1px 3px',
                  borderRadius: '2px',
                  pointerEvents: 'none',
                  whiteSpace: 'nowrap',
                }}
              >
                {trimStart.toFixed(2)}s
              </span>
            </div>

            {/* 右截取手柄 ] */}
            <div
              onPointerDown={(e) => handleTrimPointerDown('end', e)}
              style={{
                position: 'absolute',
                left: `${(trimEnd / totalDuration) * 100}%`,
                top: 0,
                bottom: 0,
                transform: 'translateX(-50%)',
                width: '28px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'ew-resize',
                zIndex: 10,
                touchAction: 'none',
              }}
              title="拖拽微调目标招式终点 ]"
            >
              <div
                style={{
                  width: '14px',
                  height: '42px',
                  backgroundColor: 'rgba(24, 24, 27, 0.95)',
                  border: '1.5px solid var(--accent)',
                  borderRadius: '0 3px 3px 0',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.8)',
                }}
              >
                <span style={{ fontSize: '13px', fontWeight: 800, color: 'var(--accent)', lineHeight: 1 }}>
                  ]
                </span>
              </div>
              <span
                className="mono-num"
                style={{
                  position: 'absolute',
                  top: '2px',
                  left: '16px',
                  fontSize: '10px',
                  backgroundColor: 'rgba(9, 9, 11, 0.85)',
                  color: 'var(--accent)',
                  padding: '1px 3px',
                  borderRadius: '2px',
                  pointerEvents: 'none',
                  whiteSpace: 'nowrap',
                }}
              >
                {trimEnd.toFixed(2)}s
              </span>
            </div>
          </div>

          <div
            className="audio-controls-row fx-row-8"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
          >
            {/* 左：播放、当前时间 */}
            <div className="control-group">
              <button type="button" onClick={togglePlay} className="btn" style={{ padding: '0 8px' }}>
                {isPlaying ? <Pause size={13} /> : <Play size={13} />}
                <span>{isPlaying ? '暂停' : '播放'}</span>
              </button>

              <span
                className="mono-num audio-time-readout"
                style={{ minWidth: '60px', fontSize: '11.5px', textAlign: 'center' }}
              >
                {currentTime.toFixed(3)}s
              </span>
            </div>

            {/* 中：设为锚点、直接输入锚点数值、试听锚点 */}
            <div className="control-group">
              <button type="button" onClick={setAsAnchor} className="btn btn-accent" style={{ padding: '0 9px' }}>
                <Crosshair size={13} />
                <span>设为锚点</span>
              </button>

              <div className="fx-row-4" style={{ display: 'flex', alignItems: 'center' }}>
                <span className="mono-muted" style={{ fontSize: '11px', whiteSpace: 'nowrap' }}>锚点</span>
                <input
                  type="number"
                  step="0.001"
                  className="num-input audio-anchor-input"
                  value={anchorInputText}
                  onChange={(e) => {
                    setAnchorInputText(e.target.value);
                    const parsed = parseFloat(e.target.value);
                    if (!isNaN(parsed) && parsed >= trimStart && parsed <= trimEnd) {
                      userEditedRef.current.anchor = true;
                      commitAudioState(bpm, parsed, undefined, false);
                    }
                  }}
                  onBlur={commitAnchorInput}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      commitAnchorInput();
                      e.currentTarget.blur();
                    }
                  }}
                  style={{ width: '64px', height: '24px', fontSize: '11.5px', textAlign: 'center' }}
                />
                <span className="mono-muted" style={{ fontSize: '11px' }}>s</span>
              </div>

              <button type="button" onClick={jumpToAnchor} className="btn" style={{ padding: '0 8px' }}>
                <Volume2 size={13} />
                <span>试听</span>
              </button>

              <span className="mono-muted" style={{ fontSize: '11px', whiteSpace: 'nowrap' }}>
                <span className="audio-trim-prefix">招式 </span>{(trimEnd - trimStart).toFixed(1)}s
              </span>
            </div>

            {/* 右：TAP 测速与 BPM 调节区 */}
            <div className="control-group fx-row-4" style={{ flexShrink: 0 }}>
              <button
                type="button"
                onClick={handleTap}
                className={`btn ${tapActive ? 'btn-active' : ''}`}
                style={{ padding: '0 8px' }}
              >
                <Activity size={13} />
                <span>TAP</span>
              </button>

              <span className="mono-muted" style={{ fontSize: '11px' }}>BPM</span>
              <button
                type="button"
                onClick={() => {
                  userEditedRef.current.bpm = true;
                  commitAudioState(Math.max(1, bpm - 1), anchorTime);
                }}
                className="btn"
                style={{ padding: '0 6px', width: '24px' }}
              >
                <Minus size={12} />
              </button>
              <input
                type="number"
                className="num-input audio-bpm-input"
                value={bpm}
                onChange={(e) => {
                  const val = Math.max(1, parseInt(e.target.value, 10) || DEFAULT_BPM);
                  userEditedRef.current.bpm = true;
                  commitAudioState(val, anchorTime);
                }}
                style={{ width: '48px', height: '24px', fontSize: '11.5px' }}
              />
              <button
                type="button"
                onClick={() => {
                  userEditedRef.current.bpm = true;
                  commitAudioState(bpm + 1, anchorTime);
                }}
                className="btn"
                style={{ padding: '0 6px', width: '24px' }}
              >
                <Plus size={12} />
              </button>
            </div>
          </div>
      </div>
    </div>
  );
};
