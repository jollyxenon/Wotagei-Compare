import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

const ROOT_DIR = process.cwd();
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const LAUNCHER_DIR = path.join(ROOT_DIR, 'scripts', 'desktop-launcher');
const RELEASE_DIR = path.join(ROOT_DIR, 'release');
const STAGE_ROOT = path.join(RELEASE_DIR, '_stage');
const BUNDLE_NAME = 'Wotagei-Compare-Desktop';
const STAGE_DIR = path.join(STAGE_ROOT, BUNDLE_NAME);
const ZIP_NAME = `${BUNDLE_NAME}-win.zip`;
const ZIP_PATH = path.join(RELEASE_DIR, ZIP_NAME);

/**
 * 递归复制目录内容
 */
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * 将文本文件按指定换行符与可选 UTF-8 BOM 写入目标路径，确保 Windows cmd/PowerShell 5.1 正常解析
 */
function writeWindowsTextFile(srcPath, destPath, withUtf8Bom) {
  const raw = fs.readFileSync(srcPath, 'utf8').replace(/^\uFEFF/, '');
  const crlf = raw.replace(/\r?\n/g, '\r\n');
  const bom = withUtf8Bom ? '\uFEFF' : '';
  fs.writeFileSync(destPath, bom + crlf, 'utf8');
}

// ---------------------------------------------------------------------------
// 纯 Node ZIP 写入器（Deflate 压缩 + CRC32 + UTF-8 文件名标志位 0x800）
// 取代此前对系统 python3 的隐式依赖；中文文件名在 Windows 资源管理器与
// 主流解压软件下均不乱码（参考 PKWARE APPNOTE.TXT）。
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** 将 Date 转为 ZIP DOS 时间字段（本地时区） */
function dosDateTime(date) {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f);
  const day =
    ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

class ZipWriter {
  constructor() {
    this.chunks = [];
    this.offset = 0;
    this.centralEntries = [];
  }

  push(chunk) {
    this.chunks.push(chunk);
    this.offset += chunk.length;
  }

  addFile(absolutePath, entryName, mtime) {
    const content = fs.readFileSync(absolutePath);
    const compressed = deflateRawSync(content, { level: 6 });
    const useDeflate = compressed.length < content.length;
    const payload = useDeflate ? compressed : content;
    const nameBytes = Buffer.from(entryName, 'utf8');
    const crc = crc32(content);
    const { time, day } = dosDateTime(mtime);

    // 通用位标志 0x0800 = 文件名为 UTF-8 编码
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(0x0014, 4); // 最小解压版本 2.0（Deflate）
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 文件名标志
    localHeader.writeUInt16LE(useDeflate ? 8 : 0, 8); // 压缩方式：Deflate / Store
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(day, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);

    this.push(localHeader);
    this.push(nameBytes);
    this.push(payload);

    this.centralEntries.push({
      nameBytes,
      crc,
      compressedSize: payload.length,
      uncompressedSize: content.length,
      method: useDeflate ? 8 : 0,
      time,
      day,
      localHeaderOffset: this.offset - localHeader.length - nameBytes.length - payload.length,
    });
  }

  /** 返回完整 ZIP 文件 Buffer（中央目录 + EOCD 已附加） */
  finish() {
    const centralStart = this.offset;
    for (const e of this.centralEntries) {
      // 中央目录文件头（46 字节固定部分），字段布局见 PKWARE APPNOTE.TXT 4.3.12
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0); // 签名
      header.writeUInt16LE(0x0014, 4); // 制作方版本 2.0
      header.writeUInt16LE(0x0014, 6); // 解压所需版本 2.0
      header.writeUInt16LE(0x0800, 8); // 通用标志：UTF-8 文件名
      header.writeUInt16LE(e.method, 10); // 压缩方式
      header.writeUInt16LE(e.time, 12); // 修改时间 (DOS)
      header.writeUInt16LE(e.day, 14); // 修改日期 (DOS)
      header.writeUInt32LE(e.crc, 16); // CRC-32
      header.writeUInt32LE(e.compressedSize, 20);
      header.writeUInt32LE(e.uncompressedSize, 24);
      header.writeUInt16LE(e.nameBytes.length, 28); // 文件名长度
      header.writeUInt16LE(0, 30); // 额外字段长度
      header.writeUInt16LE(0, 32); // 文件注释长度
      header.writeUInt16LE(0, 34); // 起始磁盘号
      header.writeUInt16LE(0, 36); // 内部属性
      header.writeUInt32LE(0, 38); // 外部属性
      header.writeUInt32LE(e.localHeaderOffset, 42); // 本地文件头相对偏移
      this.push(header);
      this.push(e.nameBytes);
    }
    const centralSize = this.offset - centralStart;

    // 结束记录（EOCD，22 字节）
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4); // 当前磁盘号
    eocd.writeUInt16LE(0, 6); // 中央目录起始磁盘号
    eocd.writeUInt16LE(this.centralEntries.length, 8); // 本磁盘条目数
    eocd.writeUInt16LE(this.centralEntries.length, 10); // 总条目数
    eocd.writeUInt32LE(centralSize, 12);
    eocd.writeUInt32LE(centralStart, 16);
    eocd.writeUInt16LE(0, 20); // 注释长度
    this.push(eocd);

    return Buffer.concat(this.chunks);
  }
}

// 1. 构建最新前端静态产物
console.log('[1/4] 正在构建前端产物 (npm run build)...');
execSync('npm run build', { cwd: ROOT_DIR, stdio: 'inherit' });

if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
  throw new Error('构建完成但未找到 dist/index.html');
}

// 2. 准备打包暂存目录
console.log('[2/4] 正在组装桌面工作台目录...');
fs.rmSync(STAGE_ROOT, { recursive: true, force: true });
fs.mkdirSync(STAGE_DIR, { recursive: true });
copyDirSync(DIST_DIR, path.join(STAGE_DIR, 'dist'));

writeWindowsTextFile(
  path.join(LAUNCHER_DIR, '启动工作台.bat'),
  path.join(STAGE_DIR, '启动工作台.bat'),
  false
);
writeWindowsTextFile(
  path.join(LAUNCHER_DIR, 'launcher.ps1'),
  path.join(STAGE_DIR, 'launcher.ps1'),
  true
);
writeWindowsTextFile(
  path.join(LAUNCHER_DIR, '使用说明.txt'),
  path.join(STAGE_DIR, '使用说明.txt'),
  true
);

// 3. 纯 Node 生成带 UTF-8 文件名标志 (通用位 0x800) 的跨平台兼容 ZIP，
//    Windows 资源管理器与解压软件均不乱码；无需系统安装 Python。
console.log(`[3/4] 正在生成压缩包 release/${ZIP_NAME}...`);
const zip = new ZipWriter();
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else {
      const rel = path.relative(STAGE_ROOT, full).split(path.sep).join('/');
      zip.addFile(full, rel, fs.statSync(full).mtime);
    }
  }
};
walk(STAGE_DIR);
fs.rmSync(ZIP_PATH, { force: true });
fs.writeFileSync(ZIP_PATH, zip.finish());

// 4. 清理暂存目录并输出结果
fs.rmSync(STAGE_ROOT, { recursive: true, force: true });
const stats = fs.statSync(ZIP_PATH);
const sizeKb = (stats.size / 1024).toFixed(1);
console.log(`[4/4] 打包完成：${ZIP_PATH} (${sizeKb} KB)`);
