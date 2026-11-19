/**
 * 单声道 PCM 模块级注册表
 *
 * 设计动机：完整 PCM（Android 路径最高 16kHz×600s×4B ≈ 38MB/通道）此前随
 * audioInfo 存放于 React 顶层状态终身持有，双通道叠加逼近 WebView 内存红线。
 * 现改为与 React 状态解耦的模块级注册表，按视频 url 键控：
 * - ImportStep 在解码完成后 putPcm；
 * - CalibrationStep 局部重算 BPM 与 exporter Web 音轨合成按 url getPcm；
 * - 更换/移除视频时 dropPcm 释放。
 * 注册表仅持有当前两个通道的数据，putPcm 对同 url 覆盖，容量天然有界。
 */

const pcmRegistry = new Map<string, Float32Array>();

/** 写入（同 url 覆盖）指定视频 url 的单声道 PCM 数据 */
export function putPcm(url: string, pcm: Float32Array): void {
  if (!url || !pcm || pcm.length === 0) return;
  pcmRegistry.set(url, pcm);
}

/** 读取指定视频 url 的 PCM 数据；不存在时返回 null */
export function getPcm(url: string): Float32Array | null {
  const pcm = pcmRegistry.get(url);
  return pcm && pcm.length > 0 ? pcm : null;
}

/** 是否已存在指定视频 url 的 PCM 数据 */
export function hasPcm(url: string): boolean {
  return pcmRegistry.has(url);
}

/** 释放指定视频 url 的 PCM 数据（更换视频或通道清空时调用） */
export function dropPcm(url: string): void {
  pcmRegistry.delete(url);
}
