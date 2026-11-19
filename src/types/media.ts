/**
 * 已载入单通道视频的运行时数据契约
 * 注意：本类型属于全局契约层，core 与 components 均从此处导入，
 * 禁止反向从组件文件导出以保持依赖方向（core 不得依赖 UI）。
 */

import type { VideoGeometryConfig } from './geometry.ts';
import type { VideoAudioInfo } from './timeline.ts';

export interface LoadedVideoItem {
  file?: File;
  nativeUri?: string;
  url: string;
  name: string;
  duration: number; // 秒；0 表示尚未探测完成（未知），禁止用魔法数占位
  width: number; // 0 表示尚未探测完成
  height: number; // 0 表示尚未探测完成
  geometry: VideoGeometryConfig;
  audioInfo?: VideoAudioInfo;
  spatialTouched?: boolean;
  audioAnchorTouched?: boolean;
}
