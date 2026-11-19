/**
 * 双视频同步时钟引擎 (DualVideoSyncEngine)
 *
 * 工业级双视频同步基座，借鉴 W3C TimingObject / MediaSync 架构思想：
 * 1. SafeVideoController：封装底层的 seeked 监听与事件排队，阻断 seeking 重入导致的解码器死锁；
 * 2. 操作代数守卫 (Epoch Guard)：递增代数彻底丢弃滞后的异步 seek 回调，消除暂停后单侧视频被幽灵拉起的严重缺陷；
 * 3. 寻道与时钟原子互斥 (Seek-First Mutual Exclusion)：拖动进度条时立即挂起后台锁相环，杜绝并发冲击；
 * 4. 双端严格会合起播屏障 (Deterministic Rendezvous Barrier)：等待双端全部就绪退出寻道后联合起步，消除起步相位差；
 * 5. 连续阻尼比例调速 (Continuous Damped Velocity Controller)：消除固定 1.08/0.92 的跳变顿挫，平滑指数收敛；
 * 6. 统一虚拟时钟向量与自适应发声通道主时钟：保证声画零延迟输出与交集区间无缝循环。
 */

import type {
  SlowMotionRate,
  SoundSource,
  TimeInterval,
} from '../types/timeline.ts';
import {
  UnifiedTimelineResult,
  mapTauToSourceTime,
  isTauInVideoRange,
  getPlaybackRate,
} from './timeline.ts';

export interface DualVideoSyncConfig {
  timeline: UnifiedTimelineResult;
  anchor1: number;
  anchor2: number;
  soundSource: SoundSource;
  slowMotionRate: SlowMotionRate;
  loopInterval?: TimeInterval;
  onTauUpdate?: (tau: number, isPlaying?: boolean) => void;
  onPlayingChange?: (isPlaying: boolean) => void;
}

/**
 * 单路视频安全控制器：状态机防抖排队，彻底消除 Seek Thrashing
 */
export class SafeVideoController {
  private element: HTMLVideoElement | null = null;
  public isSeeking: boolean = false;
  public pendingTarget: number | null = null;
  public pendingDone: (() => void) | null = null;
  public taskEpoch: number = 0;
  private seekedHandler: (() => void) | null = null;
  private metadataHandler: (() => void) | null = null;

  constructor(element: HTMLVideoElement | null = null) {
    this.attach(element);
  }

  public attach(element: HTMLVideoElement | null): void {
    if (this.element === element) return;
    this.cleanupListener();
    this.element = element;
    this.isSeeking = false;
    this.pendingTarget = null;
  }

  public getElement(): HTMLVideoElement | null {
    return this.element;
  }

  public isReady(): boolean {
    if (!this.element) return true;
    return (
      !this.isSeeking &&
      !this.element.seeking &&
      (typeof this.element.readyState !== 'number' || this.element.readyState >= 2)
    );
  }

  /**
   * 取消当前挂载的等待与队列，彻底切断滞后回调
   */
  public cancelPending(): void {
    this.cleanupListener();
    this.pendingTarget = null;
    this.pendingDone = null;
    this.isSeeking = false;
  }

  /**
   * 安全寻道：正在寻道期间排队最新目标，绝不高频重复重置 currentTime
   */
  public seek(targetTime: number, onDone?: () => void, epoch: number = 0): void {
    const video = this.element;
    if (!video || !isFinite(targetTime)) {
      onDone?.();
      return;
    }

    this.taskEpoch = epoch;

    // 元数据加载守卫：若视频就绪级别低于 HAVE_METADATA (readyState < 1) 或 duration 为 NaN/未就绪，
    // 严禁执行 Math.min(duration, targetTime)，否则非零目标会被错误截断为 0 并静默丢弃。
    // 将目标时间暂存排队，待 loadedmetadata 触发后再执行真正寻道。
    if (typeof video.readyState === 'number' && video.readyState < 1) {
      this.pendingTarget = targetTime;
      if (!this.metadataHandler) {
        this.metadataHandler = () => {
          if (this.element && this.metadataHandler) {
            this.element.removeEventListener('loadedmetadata', this.metadataHandler);
            this.metadataHandler = null;
          }
          if (this.pendingTarget !== null) {
            const next = this.pendingTarget;
            this.pendingTarget = null;
            this.seek(next, onDone, this.taskEpoch);
          } else {
            onDone?.();
          }
        };
        video.addEventListener('loadedmetadata', this.metadataHandler, { once: true });
      }
      return;
    }

    const duration = isFinite(video.duration) && video.duration > 0 ? video.duration : targetTime;
    const clamped = Math.max(0, Math.min(duration, targetTime));

    const hasFrameReady = typeof video.readyState !== 'number' || video.readyState >= 2;
    if (hasFrameReady && !this.isSeeking && !video.seeking && Math.abs(video.currentTime - clamped) < 0.005) {
      onDone?.();
      return;
    }

    if (this.isSeeking || video.seeking) {
      this.pendingTarget = clamped;
      this.pendingDone = onDone || null;
      this.taskEpoch = epoch;
      return;
    }

    this.isSeeking = true;
    this.pendingTarget = null;
    this.pendingDone = null;

    this.seekedHandler = () => {
      this.cleanupListener();
      this.isSeeking = false;
      if (this.pendingTarget !== null) {
        const next = this.pendingTarget;
        const nextDone = this.pendingDone;
        this.pendingTarget = null;
        this.pendingDone = null;
        this.seek(next, nextDone || undefined, this.taskEpoch);
      } else {
        onDone?.();
      }
    };

    video.addEventListener('seeked', this.seekedHandler, { once: true });
    video.currentTime = clamped;
  }

  public setPlaybackRate(rate: number): void {
    if (this.element && isFinite(rate) && rate > 0) {
      this.element.playbackRate = rate;
    }
  }

  public setMuted(muted: boolean): void {
    if (this.element) {
      this.element.muted = muted;
    }
  }

  public setPreservesPitch(preserves: boolean): void {
    if (this.element) {
      this.element.preservesPitch = preserves;
    }
  }

  public play(): Promise<void> {
    if (!this.element) return Promise.resolve();
    return this.element.play().catch(() => {});
  }

  public pause(): void {
    if (this.element && !this.element.paused) {
      this.element.pause();
    }
  }

  private cleanupListener(): void {
    if (this.element && this.seekedHandler) {
      this.element.removeEventListener('seeked', this.seekedHandler);
      this.seekedHandler = null;
    }
    if (this.element && this.metadataHandler) {
      this.element.removeEventListener('loadedmetadata', this.metadataHandler);
      this.metadataHandler = null;
    }
  }

  public destroy(): void {
    this.cancelPending();
    this.element = null;
  }
}

/**
 * 连续阻尼调速计算纯函数 (便于高覆盖单元测试)
 * @param timeDiff 期望时间减当前时间 (秒): expectedT - currentTime
 * @param baseRate 当前基准播放倍速
 * @param dampingConstant 阻尼时间常数 (默认 0.5s)
 * @param maxAdjustment 最大微调幅度比例 (默认 0.15 即 ±15%)
 */
export function calculateDampedPlaybackRate(
  timeDiff: number,
  baseRate: number,
  dampingConstant: number = 0.5,
  maxAdjustment: number = 0.15
): number {
  if (!isFinite(timeDiff) || !isFinite(baseRate) || baseRate <= 0) {
    return baseRate;
  }

  // 死区保护：误差小于 10ms 保持基准速率，避免频繁微小重采样开销
  if (Math.abs(timeDiff) < 0.01) {
    return baseRate;
  }

  // 连续比例控制：对偏差进行阻尼归一化并进行安全 clamp
  const adjustmentRatio = Math.max(-maxAdjustment, Math.min(maxAdjustment, timeDiff / dampingConstant));
  return baseRate * (1 + adjustmentRatio);
}

// Node.js / Web 跨环境兼容的 RAF 包装
const safeRequestAnimationFrame = (cb: (now: number) => void): number => {
  if (typeof requestAnimationFrame !== 'undefined') {
    return requestAnimationFrame(cb);
  }
  return setTimeout(() => cb(performance.now()), 16) as unknown as number;
};

const safeCancelAnimationFrame = (id: number): void => {
  if (typeof cancelAnimationFrame !== 'undefined') {
    cancelAnimationFrame(id);
  } else {
    clearTimeout(id);
  }
};

/**
 * 双视频同步时钟引擎核心类
 */
export class DualVideoSyncEngine {
  private ctrl1: SafeVideoController;
  private ctrl2: SafeVideoController;

  private timeline: UnifiedTimelineResult;
  private anchor1: number;
  private anchor2: number;
  private soundSource: SoundSource;
  private slowMotionRate: SlowMotionRate;
  private loopInterval?: TimeInterval;

  private onTauUpdate?: (tau: number, isPlaying?: boolean) => void;
  private onPlayingChange?: (isPlaying: boolean) => void;

  private currentTau: number;
  private isPlaying: boolean = false;
  private isStartingPlay: boolean = false;
  private intendedPlaying: boolean = false;
  private currentEpoch: number = 0;
  private lastHardSeekTime: number = 0;

  private animId: number | null = null;
  private lastTimestamp: number = 0;
  private isDestroyed: boolean = false;

  constructor(
    v1: HTMLVideoElement | null,
    v2: HTMLVideoElement | null,
    config: DualVideoSyncConfig
  ) {
    this.ctrl1 = new SafeVideoController(v1);
    this.ctrl2 = new SafeVideoController(v2);

    this.timeline = config.timeline;
    this.anchor1 = config.anchor1;
    this.anchor2 = config.anchor2;
    this.soundSource = config.soundSource;
    this.slowMotionRate = config.slowMotionRate;
    this.loopInterval = config.loopInterval;
    this.onTauUpdate = config.onTauUpdate;
    this.onPlayingChange = config.onPlayingChange;

    this.currentTau = this.timeline.intersectInterval.start;
    this.applyAudioSettings();
  }

  /**
   * 挂载或更新底层 HTMLVideoElement
   */
  public attachVideos(v1: HTMLVideoElement | null, v2: HTMLVideoElement | null): void {
    this.ctrl1.attach(v1);
    this.ctrl2.attach(v2);
    this.applyAudioSettings();
  }

  /**
   * 更新时间轴与同步配置参数
   */
  public updateConfig(config: Partial<DualVideoSyncConfig>): void {
    if (config.timeline) this.timeline = config.timeline;
    if (typeof config.anchor1 === 'number') this.anchor1 = config.anchor1;
    if (typeof config.anchor2 === 'number') this.anchor2 = config.anchor2;
    if (config.loopInterval) this.loopInterval = config.loopInterval;
    if (config.soundSource) {
      this.soundSource = config.soundSource;
      this.applyAudioSettings();
    }
    if (typeof config.slowMotionRate === 'number') {
      this.slowMotionRate = config.slowMotionRate;
      this.updatePlaybackRates();
    }
    if (config.onTauUpdate) this.onTauUpdate = config.onTauUpdate;
    if (config.onPlayingChange) this.onPlayingChange = config.onPlayingChange;
  }

  public getTau(): number {
    return this.currentTau;
  }

  public getIsPlaying(): boolean {
    return this.isPlaying;
  }

  public getIntendedPlaying(): boolean {
    return this.intendedPlaying;
  }

  /**
   * 应用声音通道与变速不变调设置
   */
  private applyAudioSettings(): void {
    this.ctrl1.setPreservesPitch(true);
    this.ctrl2.setPreservesPitch(true);

    if (this.soundSource === 'video1') {
      this.ctrl1.setMuted(false);
      this.ctrl2.setMuted(true);
    } else if (this.soundSource === 'video2') {
      this.ctrl1.setMuted(true);
      this.ctrl2.setMuted(false);
    } else {
      this.ctrl1.setMuted(true);
      this.ctrl2.setMuted(true);
    }
  }

  /**
   * 刷新两通道基准播放倍率
   */
  private updatePlaybackRates(): void {
    const base1 = getPlaybackRate(this.slowMotionRate, this.timeline.rate1);
    const base2 = getPlaybackRate(this.slowMotionRate, this.timeline.rate2);
    this.ctrl1.setPlaybackRate(base1);
    this.ctrl2.setPlaybackRate(base2);
  }

  /**
   * 同步定位两路视频至统一时间轴位置
   * @param targetTau 目标时间戳 (秒)
   * @param onComplete 完成回调
   * @param keepPlaying 是否保持原有的播放意图 (默认根据当前是否处于播放中自动决定)
   */
  public seekToTau(targetTau: number, onComplete?: () => void, keepPlaying?: boolean): void {
    const shouldKeepPlaying = typeof keepPlaying === 'boolean'
      ? keepPlaying
      : (this.intendedPlaying || this.isPlaying);

    // 若当前正在播放且需保持播放，则原子会合跳转并继续播放
    if (shouldKeepPlaying) {
      this.playFrom(targetTau).then(() => {
        onComplete?.();
      });
      return;
    }

    // 暂停状态下的纯静态寻道：挂起时钟，静态定位目标帧
    this.currentEpoch++;
    const epoch = this.currentEpoch;
    this.intendedPlaying = false;
    this.isStartingPlay = false;
    this.isPlaying = false;
    this.stopLoop();
    this.ctrl1.pause();
    this.ctrl2.pause();
    this.onPlayingChange?.(false);

    const intersect = this.timeline.intersectInterval;
    const clampedTau = Math.max(intersect.start, Math.min(intersect.end, targetTau));

    this.currentTau = clampedTau;
    this.onTauUpdate?.(clampedTau, false);

    const t1 = mapTauToSourceTime(clampedTau, this.anchor1, this.timeline.rate1);
    const t2 = mapTauToSourceTime(clampedTau, this.anchor2, this.timeline.rate2);

    let v1Finished = !this.ctrl1.getElement() || !isFinite(t1);
    let v2Finished = !this.ctrl2.getElement() || !isFinite(t2);

    const checkBoth = () => {
      if (v1Finished && v2Finished) {
        if (this.currentEpoch === epoch && !this.isDestroyed) {
          onComplete?.();
        }
      }
    };

    if (!v1Finished) {
      this.ctrl1.seek(t1, () => {
        v1Finished = true;
        checkBoth();
      }, epoch);
    }

    if (!v2Finished) {
      this.ctrl2.seek(t2, () => {
        v2Finished = true;
        checkBoth();
      }, epoch);
    }

    if (v1Finished && v2Finished) {
      checkBoth();
    }
  }

  /**
   * 双端严格会合起播屏障 (Deterministic Rendezvous Barrier)
   * 无论从当前位置起播还是从目标位置 (如锚点前 1s) 起播，先对齐停稳再联合开跑
   */
  public async playFrom(targetTau: number): Promise<void> {
    this.currentEpoch++;
    const epoch = this.currentEpoch;
    this.intendedPlaying = true;
    this.isStartingPlay = true;

    // 1. 彻底挂起先前的驱动循环与残留 seek 任务
    this.stopLoop();
    this.isPlaying = false;
    this.ctrl1.cancelPending();
    this.ctrl2.cancelPending();
    this.ctrl1.pause();
    this.ctrl2.pause();

    const loopStart = this.loopInterval?.start ?? this.timeline.intersectInterval.start;
    const loopEnd = this.loopInterval?.end ?? this.timeline.intersectInterval.end;

    // 零宽/近零宽区间防护：无有效重叠时步进循环会在起播帧立即触发回绕，
    // 造成 seek 风暴。此时退化为静态定位到区间起点并保持暂停。
    if (loopEnd - loopStart < 0.02) {
      this.intendedPlaying = false;
      this.isStartingPlay = false;
      this.onPlayingChange?.(false);
      this.seekToTau(loopStart, undefined, false);
      return;
    }

    let clampedTau = Math.max(loopStart, Math.min(loopEnd - 0.05, targetTau));

    this.currentTau = clampedTau;
    this.onTauUpdate?.(clampedTau, false);

    const t1 = mapTauToSourceTime(clampedTau, this.anchor1, this.timeline.rate1);
    const t2 = mapTauToSourceTime(clampedTau, this.anchor2, this.timeline.rate2);

    // 2. 双端并行 seek 到目标时间，等待双方全部 seeked
    await new Promise<void>((resolve) => {
      let v1Done = !this.ctrl1.getElement() || !isFinite(t1);
      let v2Done = !this.ctrl2.getElement() || !isFinite(t2);

      const check = () => {
        if (v1Done && v2Done) resolve();
      };

      if (!v1Done) {
        this.ctrl1.seek(t1, () => {
          v1Done = true;
          check();
        }, epoch);
      }
      if (!v2Done) {
        this.ctrl2.seek(t2, () => {
          v2Done = true;
          check();
        }, epoch);
      }
      if (v1Done && v2Done) resolve();
    });

    // 3. 代数与意图检查：若寻道期间用户点击了暂停，直接静止
    if (this.currentEpoch !== epoch || !this.intendedPlaying || this.isDestroyed) {
      this.isStartingPlay = false;
      return;
    }

    // 4. 等待硬件渲染就绪屏障 (超时 250ms 防死锁)
    let waitCount = 0;
    while (waitCount < 10) {
      if (this.ctrl1.isReady() && this.ctrl2.isReady()) break;
      await new Promise((r) => setTimeout(r, 20));
      waitCount++;
    }

    if (this.currentEpoch !== epoch || !this.intendedPlaying || this.isDestroyed) {
      this.isStartingPlay = false;
      return;
    }

    this.isStartingPlay = false;
    this.updatePlaybackRates();

    const v1Active = isTauInVideoRange(clampedTau, this.timeline.span1);
    const v2Active = isTauInVideoRange(clampedTau, this.timeline.span2);

    const plays: Promise<void>[] = [];
    if (v1Active) plays.push(this.ctrl1.play());
    if (v2Active) plays.push(this.ctrl2.play());

    await Promise.all(plays);

    // 5. 联合激活主时钟
    if (this.currentEpoch === epoch && this.intendedPlaying && !this.isDestroyed) {
      this.isPlaying = true;
      this.lastTimestamp = performance.now();
      this.onPlayingChange?.(true);
      this.startLoop();
    }
  }

  public play(): void {
    const loopStart = this.loopInterval?.start ?? this.timeline.intersectInterval.start;
    const loopEnd = this.loopInterval?.end ?? this.timeline.intersectInterval.end;

    let startTau = this.currentTau;
    if (startTau >= loopEnd - 0.05 || startTau < loopStart) {
      startTau = loopStart;
    }

    this.playFrom(startTau);
  }

  /**
   * 暂停双通道播放 (代数自增，彻底丢弃滞后异步唤醒)
   */
  public pause(): void {
    this.currentEpoch++;
    this.intendedPlaying = false;
    this.isStartingPlay = false;
    this.isPlaying = false;
    this.stopLoop();

    this.ctrl1.cancelPending();
    this.ctrl2.cancelPending();
    this.ctrl1.pause();
    this.ctrl2.pause();
    this.onPlayingChange?.(false);
  }

  public togglePlay(): void {
    if (this.isPlaying || this.isStartingPlay || this.intendedPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  /**
   * 启动同步主时钟驱动循环
   */
  private startLoop(): void {
    if (this.animId !== null) return;

    const loop = (now: number) => {
      if (!this.isPlaying || !this.intendedPlaying || this.isDestroyed) {
        this.animId = null;
        return;
      }

      const deltaSec = (now - this.lastTimestamp) / 1000;
      this.lastTimestamp = now;

      this.stepSync(now, deltaSec);
      if (this.isPlaying && this.intendedPlaying && !this.isDestroyed) {
        this.animId = safeRequestAnimationFrame(loop);
      } else {
        this.animId = null;
      }
    };

    this.animId = safeRequestAnimationFrame(loop);
  }

  private stopLoop(): void {
    if (this.animId !== null) {
      safeCancelAnimationFrame(this.animId);
      this.animId = null;
    }
  }

  /**
   * 每帧单步时钟计算与从属通道连续阻尼对齐
   */
  public stepSync(now: number, deltaSec: number): void {
    if (!this.intendedPlaying || !this.isPlaying) return;

    const v1 = this.ctrl1.getElement();
    const v2 = this.ctrl2.getElement();

    const baseRate1 = getPlaybackRate(this.slowMotionRate, this.timeline.rate1);
    const baseRate2 = getPlaybackRate(this.slowMotionRate, this.timeline.rate2);

    let tau = this.currentTau;
    let masterVideo: HTMLVideoElement | null = null;
    let masterRate = this.timeline.rate1;
    let masterAnchor = this.anchor1;

    // 根据发声源动态确定物理硬件主时钟
    if (this.soundSource === 'video2' && v2 && !v2.paused && v2.readyState >= 2) {
      masterVideo = v2;
      masterRate = this.timeline.rate2;
      masterAnchor = this.anchor2;
    } else if (v1 && !v1.paused && v1.readyState >= 2) {
      masterVideo = v1;
      masterRate = this.timeline.rate1;
      masterAnchor = this.anchor1;
    }

    if (masterVideo) {
      tau = (masterVideo.currentTime - masterAnchor) / masterRate;
    } else {
      tau += deltaSec * this.slowMotionRate;
    }

    // 截取区间边界循环保护
    const loopStart = this.loopInterval?.start ?? this.timeline.intersectInterval.start;
    const loopEnd = this.loopInterval?.end ?? this.timeline.intersectInterval.end;

    if (tau >= loopEnd) {
      this.playFrom(loopStart);
      return;
    }

    this.currentTau = tau;
    this.onTauUpdate?.(tau, true);

    const v1Active = isTauInVideoRange(tau, this.timeline.span1);
    const v2Active = isTauInVideoRange(tau, this.timeline.span2);

    const expectedT1 = this.anchor1 + tau * this.timeline.rate1;
    const expectedT2 = this.anchor2 + tau * this.timeline.rate2;

    // 对通道 1 执行状态与阻尼跟踪
    if (v1) {
      if (v1Active) {
        if (v1.paused && this.intendedPlaying) {
          this.ctrl1.setPlaybackRate(baseRate1);
          this.ctrl1.play();
        } else if (masterVideo !== v1) {
          const diff = expectedT1 - v1.currentTime;
          if (Math.abs(diff) > 0.3) {
            const canHardSeek = this.ctrl1.isReady() && now - this.lastHardSeekTime > 600;
            if (canHardSeek) {
              this.lastHardSeekTime = now;
              this.ctrl1.seek(expectedT1, undefined, this.currentEpoch);
            }
          } else {
            const rate = calculateDampedPlaybackRate(diff, baseRate1);
            this.ctrl1.setPlaybackRate(rate);
          }
        } else {
          this.ctrl1.setPlaybackRate(baseRate1);
        }
      } else if (!v1.paused) {
        this.ctrl1.pause();
      }
    }

    // 对通道 2 执行状态与阻尼跟踪
    if (v2) {
      if (v2Active) {
        if (v2.paused && this.intendedPlaying) {
          this.ctrl2.setPlaybackRate(baseRate2);
          this.ctrl2.play();
        } else if (masterVideo !== v2) {
          const diff = expectedT2 - v2.currentTime;
          if (Math.abs(diff) > 0.3) {
            const canHardSeek = this.ctrl2.isReady() && now - this.lastHardSeekTime > 600;
            if (canHardSeek) {
              this.lastHardSeekTime = now;
              this.ctrl2.seek(expectedT2, undefined, this.currentEpoch);
            }
          } else {
            const rate = calculateDampedPlaybackRate(diff, baseRate2);
            this.ctrl2.setPlaybackRate(rate);
          }
        } else {
          this.ctrl2.setPlaybackRate(baseRate2);
        }
      } else if (!v2.paused) {
        this.ctrl2.pause();
      }
    }
  }

  /**
   * 销毁引擎实例，释放所有资源与监听器
   */
  public destroy(): void {
    this.isDestroyed = true;
    this.stopLoop();
    this.ctrl1.destroy();
    this.ctrl2.destroy();
  }
}
