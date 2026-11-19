package com.wotagei.compare;

import android.Manifest;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Build;
import android.provider.OpenableColumns;
import android.provider.Settings;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 原生媒体选择、本地流式代理与 GPU 离线导出插件入口
 */
@CapacitorPlugin(
    name = "NativeMedia",
    permissions = {
        @Permission(
            alias = "storage",
            strings = {Manifest.permission.WRITE_EXTERNAL_STORAGE}
        )
    }
)
public class NativeMediaPlugin extends Plugin {
    private LocalRangeProxyServer proxyServer;
    private final Map<Integer, ChannelUriGrant> channelUriMap = new ConcurrentHashMap<>();
    private final ExecutorService audioExecutor = Executors.newSingleThreadExecutor();
    private final ExecutorService exportExecutor = Executors.newSingleThreadExecutor();
    private final ExecutorService updateExecutor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean exportCancelFlag = new AtomicBoolean(false);
    private volatile File pendingInstallApkFile = null;

    static class ChannelUriGrant {
        final Uri uri;
        final int flags;

        ChannelUriGrant(Uri uri, int flags) {
            this.uri = uri;
            this.flags = flags;
        }
    }

    @Override
    public void load() {
        File cacheDir = getContext().getCacheDir();
        cleanupStaleExportTempFiles(cacheDir);
        cleanupStaleUpdateApkFiles(cacheDir);
        proxyServer = new LocalRangeProxyServer(getContext());
    }

    /**
     * 启动时清扫因导出过程中闪退或强杀遗留的历史临时合成文件
     */
    static void cleanupStaleExportTempFiles(File cacheDir) {
        if (cacheDir == null || !cacheDir.isDirectory()) return;
        File[] files = cacheDir.listFiles();
        if (files == null) return;
        for (File file : files) {
            if (file.isFile()) {
                String name = file.getName();
                if (name.startsWith("wotagei_export_") && name.endsWith(".mp4")) {
                    //noinspection ResultOfMethodCallIgnored
                    file.delete();
                }
            }
        }
    }

    /**
     * 清扫端内更新下载遗留的 APK 安装包（冷启动、重下载前及取消安装后调用）
     */
    static void cleanupStaleUpdateApkFiles(File cacheDir) {
        if (cacheDir == null || !cacheDir.isDirectory()) return;
        File[] files = cacheDir.listFiles();
        if (files == null) return;
        for (File file : files) {
            if (file.isFile()) {
                String name = file.getName();
                if (name.startsWith("wotagei_update_") && name.endsWith(".apk")) {
                    //noinspection ResultOfMethodCallIgnored
                    file.delete();
                }
            }
        }
    }

    @Override
    protected void handleOnDestroy() {
        exportCancelFlag.set(true);
        audioExecutor.shutdownNow();
        exportExecutor.shutdownNow();
        updateExecutor.shutdownNow();
        if (getContext() != null) {
            ContentResolver resolver = getContext().getContentResolver();
            for (Integer ch : channelUriMap.keySet().toArray(new Integer[0])) {
                ChannelUriGrant grant = channelUriMap.remove(ch);
                if (grant != null && !isUriStillActive(channelUriMap, grant.uri)) {
                    try {
                        resolver.releasePersistableUriPermission(grant.uri, grant.flags);
                    } catch (Exception ignored) {}
                }
            }
        }
        channelUriMap.clear();
        if (proxyServer != null) {
            proxyServer.shutdown();
            proxyServer = null;
        }
        super.handleOnDestroy();
    }

    static boolean isUriStillActive(Map<Integer, ChannelUriGrant> map, Uri targetUri) {
        if (targetUri == null) return false;
        for (ChannelUriGrant grant : map.values()) {
            if (grant != null && targetUri.equals(grant.uri)) {
                return true;
            }
        }
        return false;
    }

    /**
     * 拉起系统原生文档/视频选择器，获取持久化 content:// URI、流式播放地址及媒体元信息
     */
    @PluginMethod
    public void pickVideo(PluginCall call) {
        int channel = call.getInt("channel", 1);
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("video/*");
        intent.addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
        );
        startActivityForResult(call, intent, "handlePickVideoResult");
    }

    @ActivityCallback
    private void handlePickVideoResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            JSObject canceled = new JSObject();
            canceled.put("canceled", true);
            call.resolve(canceled);
            return;
        }

        Uri uri = result.getData().getData();
        if (uri == null) {
            call.reject("未获取到有效视频 URI");
            return;
        }

        int channel = call.getInt("channel", 1);
        ContentResolver resolver = getContext().getContentResolver();

        int takeFlags = result.getData().getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION;
        if (takeFlags == 0) {
            takeFlags = Intent.FLAG_GRANT_READ_URI_PERMISSION;
        }
        try {
            resolver.takePersistableUriPermission(uri, takeFlags);
        } catch (Exception ignored) {
            // 部分第三方 Provider 不支持持久化授权，会话内临时读取授权依然有效
        }

        try {
            if (proxyServer == null) {
                proxyServer = new LocalRangeProxyServer(getContext());
            }
            String streamUrl = proxyServer.registerChannelUri(channel, uri);
            ChannelUriGrant oldGrant = channelUriMap.put(channel, new ChannelUriGrant(uri, takeFlags));
            if (oldGrant != null && !oldGrant.uri.equals(uri) && !isUriStillActive(channelUriMap, oldGrant.uri)) {
                try {
                    resolver.releasePersistableUriPermission(oldGrant.uri, oldGrant.flags);
                } catch (Exception ignored) {}
            }

            String name = "video_" + channel + ".mp4";
            long size = 0;
            try (Cursor cursor = resolver.query(
                uri,
                new String[] {OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE},
                null,
                null,
                null
            )) {
                if (cursor != null && cursor.moveToFirst()) {
                    int nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    int sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE);
                    if (nameIdx >= 0 && !cursor.isNull(nameIdx)) {
                        name = cursor.getString(nameIdx);
                    }
                    if (sizeIdx >= 0 && !cursor.isNull(sizeIdx)) {
                        size = cursor.getLong(sizeIdx);
                    }
                }
            } catch (Exception ignored) {}

            // 元数据未知哨兵统一为 0：解析失败时绝不回退伪造的 1920×1080 / 10s
            // 默认值（假尺寸会静默污染前端整套三线几何标定数学），
            // 前端收到 0 字段后会经本地流式代理二次探测补齐。
            int width = 0;
            int height = 0;
            double duration = 0.0;

            MediaMetadataRetriever retriever = new MediaMetadataRetriever();
            try {
                retriever.setDataSource(getContext(), uri);
                String wStr = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH);
                String hStr = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT);
                String rotStr = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION);
                String durStr = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);

                int rawW = wStr != null ? Integer.parseInt(wStr) : 0;
                int rawH = hStr != null ? Integer.parseInt(hStr) : 0;
                int rot = rotStr != null ? Integer.parseInt(rotStr) : 0;

                if (rot == 90 || rot == 270) {
                    width = rawH;
                    height = rawW;
                } else {
                    width = rawW;
                    height = rawH;
                }

                if (durStr != null) {
                    long durMs = Long.parseLong(durStr);
                    if (durMs > 0) {
                        duration = durMs / 1000.0;
                    }
                }
            } catch (Exception ignored) {
                // 解析失败保持 0（未知），交由前端经代理流二次探测
            } finally {
                try {
                    retriever.release();
                } catch (Exception ignored) {}
            }

            JSObject res = new JSObject();
            res.put("canceled", false);
            res.put("uri", uri.toString());
            res.put("streamUrl", streamUrl);
            res.put("name", name);
            res.put("size", size);
            res.put("width", width);
            res.put("height", height);
            res.put("duration", duration);
            call.resolve(res);
        } catch (Exception e) {
            call.reject("原生视频载入失败: " + e.getMessage(), e);
        }
    }

    /**
     * 在后台线程流式提取降采样单声道 Int16 PCM 并通过本地代理 URL 零拷贝传回前端
     */
    @PluginMethod
    public void extractAudioAnalysis(PluginCall call) {
        String uriStr = call.getString("uri");
        if (uriStr == null || uriStr.isEmpty()) {
            call.reject("缺少 uri 参数");
            return;
        }
        Uri uri = Uri.parse(uriStr);
        audioExecutor.execute(() -> {
            try {
                NativeAudioExtractor.ExtractionResult ext =
                    NativeAudioExtractor.extractMonoPcm(getContext(), uri);

                JSObject res = new JSObject();
                res.put("hasAudio", ext.hasAudio);
                res.put("truncated", ext.truncated);
                res.put("sampleRate", ext.sampleRate);
                res.put("duration", ext.durationSec);
                if (ext.hasAudio && ext.pcmInt16Le.length > 0) {
                    if (proxyServer == null) {
                        proxyServer = new LocalRangeProxyServer(getContext());
                    }
                    String pcmUrl = proxyServer.registerAudioPcm(
                        uriStr,
                        ext.pcmInt16Le,
                        ext.sampleRate,
                        ext.durationSec
                    );
                    res.put("pcmUrl", pcmUrl);
                }
                call.resolve(res);
            } catch (Exception e) {
                call.reject("原生音频解析失败: " + e.getMessage(), e);
            }
        });
    }

    /**
     * 启动 GPU 零拷贝离线硬件导出 MP4（Android 6~9 自动先请求公开目录存储权限）
     */
    @PluginMethod
    public void exportVideo(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
            && getPermissionState("storage") != PermissionState.GRANTED) {
            requestPermissionForAlias("storage", call, "storagePermissionCallback");
            return;
        }
        startExportTask(call);
    }

    @PermissionCallback
    private void storagePermissionCallback(PluginCall call) {
        // 即使被拒绝，saveToPublicMovies 仍可回退到应用私有目录完成保存
        startExportTask(call);
    }

    @PluginMethod
    public void cancelExport(PluginCall call) {
        exportCancelFlag.set(true);
        call.resolve();
    }

    private void startExportTask(PluginCall call) {
        JSObject v1Obj = call.getObject("video1");
        JSObject v2Obj = call.getObject("video2");
        if (v1Obj == null || v2Obj == null) {
            call.reject("缺少导出视频布局配置");
            return;
        }

        NativeOfflineExporter.ExportParams params = new NativeOfflineExporter.ExportParams();
        params.mode = call.getString("mode", "split-screen");
        params.width = call.getInt("width", 1280);
        params.height = call.getInt("height", 720);
        params.fps = call.getInt("fps", 30);
        params.exportStartTau = call.getDouble("exportStartTau", 0.0);
        params.exportEndTau = call.getDouble("exportEndTau", 1.0);
        params.slowMotionRate = call.getDouble("slowMotionRate", 1.0);
        params.effectiveBpm = call.getDouble("effectiveBpm", 160.0);
        params.soundSource = call.getString("soundSource", "metronome");

        params.uri1 = Uri.parse(v1Obj.getString("uri", ""));
        params.anchor1 = v1Obj.optDouble("anchorTime", 1.0);
        params.rate1 = v1Obj.optDouble("rate", 1.0);
        params.span1Start = v1Obj.optDouble("spanStart", -1000.0);
        params.span1End = v1Obj.optDouble("spanEnd", 1000.0);
        params.spec1 = parseLayerSpec(v1Obj);

        params.uri2 = Uri.parse(v2Obj.getString("uri", ""));
        params.anchor2 = v2Obj.optDouble("anchorTime", 1.0);
        params.rate2 = v2Obj.optDouble("rate", 1.0);
        params.span2Start = v2Obj.optDouble("spanStart", -1000.0);
        params.span2End = v2Obj.optDouble("spanEnd", 1000.0);
        params.spec2 = parseLayerSpec(v2Obj);

        exportCancelFlag.set(false);
        exportExecutor.execute(() -> {
            try {
                NativeOfflineExporter.ExportResult res = NativeOfflineExporter.export(
                    getContext(),
                    params,
                    exportCancelFlag,
                    (cur, total, pct, text) -> {
                        JSObject ev = new JSObject();
                        ev.put("currentFrame", cur);
                        ev.put("totalFrames", total);
                        ev.put("percent", pct);
                        ev.put("statusText", text);
                        notifyListeners("exportProgress", ev);
                    }
                );

                JSObject out = new JSObject();
                out.put("savedPath", res.savedPath);
                out.put("width", res.width);
                out.put("height", res.height);
                out.put("durationSec", res.durationSec);
                call.resolve(out);
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : "原生导出失败", e);
            }
        });
    }

    private NativeGlRenderer.VideoLayerSpec parseLayerSpec(JSObject obj) {
        NativeGlRenderer.VideoLayerSpec spec = new NativeGlRenderer.VideoLayerSpec();
        spec.mirror = obj.optBoolean("mirror", false);
        spec.alpha = (float) obj.optDouble("alpha", 1.0);
        spec.clipRect = parseRect(obj.optJSONObject("clipRect"));
        spec.mainRect = parseRect(obj.optJSONObject("mainRect"));
        spec.bgRect = parseRect(obj.optJSONObject("bgRect"));
        spec.bgAlpha = (float) obj.optDouble("bgAlpha", 0.0);
        return spec;
    }

    private NativeGlRenderer.NormRect parseRect(org.json.JSONObject rectObj) {
        if (rectObj == null) return null;
        return new NativeGlRenderer.NormRect(
            (float) rectObj.optDouble("x", 0.0),
            (float) rectObj.optDouble("y", 0.0),
            (float) rectObj.optDouble("w", 1.0),
            (float) rectObj.optDouble("h", 1.0)
        );
    }

    /**
     * 读取当前安装包真实版本号与 versionCode
     */
    @PluginMethod
    @SuppressWarnings("deprecation")
    public void getAppVersion(PluginCall call) {
        try {
            PackageManager pm = getContext().getPackageManager();
            PackageInfo info = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                ? pm.getPackageInfo(
                    getContext().getPackageName(),
                    PackageManager.PackageInfoFlags.of(0)
                )
                : pm.getPackageInfo(getContext().getPackageName(), 0);
            JSObject res = new JSObject();
            res.put("versionName", info.versionName != null ? info.versionName : "1.0.0");
            long code = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? info.getLongVersionCode()
                : info.versionCode;
            res.put("versionCode", code);
            call.resolve(res);
        } catch (Exception e) {
            JSObject fallback = new JSObject();
            fallback.put("versionName", "1.0.0");
            fallback.put("versionCode", 1);
            call.resolve(fallback);
        }
    }

    /**
     * 拉起系统浏览器访问 GitHub 仓库或 Releases 页面
     */
    @PluginMethod
    public void openExternalUrl(PluginCall call) {
        String url = call.getString("url", "");
        if (url == null || (!url.startsWith("http://") && !url.startsWith("https://"))) {
            call.reject("无效的外部链接地址");
            return;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("无法拉起系统浏览器: " + e.getMessage(), e);
        }
    }

    /**
     * 原生查询 GitHub Releases 最新版本元数据（规避旧版 WebView TLS/CORS 限制）
     */
    @PluginMethod
    public void checkLatestRelease(PluginCall call) {
        updateExecutor.execute(() -> {
            HttpURLConnection conn = null;
            try {
                conn = openConnectionWithRedirects(
                    "https://api.github.com/repos/jollyxenon/Wotagei-Compare/releases/latest",
                    "application/vnd.github+json",
                    15000
                );
                int status = conn.getResponseCode();
                if (status == 404) {
                    call.reject("暂未在 GitHub Releases 找到已发布的正式版本");
                    return;
                }
                if (status == 403 || status == 429) {
                    call.reject("GitHub 接口请求受限，请稍后重试或前往 Releases 页面查看");
                    return;
                }
                if (status < 200 || status >= 300) {
                    call.reject("检查更新失败（HTTP " + status + "）");
                    return;
                }

                StringBuilder sb = new StringBuilder();
                try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8)
                )) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        sb.append(line);
                    }
                }

                JSONObject json = new JSONObject(sb.toString());
                JSObject result = new JSObject();
                result.put("tagName", json.optString("tag_name", ""));
                result.put("name", json.optString("name", ""));
                result.put("body", json.optString("body", ""));
                result.put(
                    "htmlUrl",
                    json.optString(
                        "html_url",
                        "https://github.com/jollyxenon/Wotagei-Compare/releases"
                    )
                );
                result.put("publishedAt", json.optString("published_at", ""));

                JSArray assetsArr = new JSArray();
                JSONArray rawAssets = json.optJSONArray("assets");
                if (rawAssets != null) {
                    for (int i = 0; i < rawAssets.length(); i++) {
                        JSONObject item = rawAssets.optJSONObject(i);
                        if (item == null) continue;
                        JSObject mapped = new JSObject();
                        mapped.put("name", item.optString("name", ""));
                        mapped.put("browserDownloadUrl", item.optString("browser_download_url", ""));
                        mapped.put("size", item.optLong("size", 0L));
                        mapped.put("contentType", item.optString("content_type", ""));
                        assetsArr.put(mapped);
                    }
                }
                result.put("assets", assetsArr);
                call.resolve(result);
            } catch (Exception e) {
                call.reject(
                    "网络检查更新失败: " + (e.getMessage() != null ? e.getMessage() : "未知错误"),
                    e
                );
            } finally {
                if (conn != null) {
                    conn.disconnect();
                }
            }
        });
    }

    /**
     * 端内下载目标 APK 安装包到 cacheDir 并唤起系统安装器（自动先清扫历史 APK）
     */
    @PluginMethod
    public void downloadAndInstallApk(PluginCall call) {
        String downloadUrl = call.getString("url", "");
        String versionRaw = call.getString("version", "latest");
        if (
            downloadUrl == null
                || (!downloadUrl.startsWith("https://") && !downloadUrl.startsWith("http://"))
        ) {
            call.reject("无效的 APK 下载地址");
            return;
        }

        String safeVer = (versionRaw != null ? versionRaw : "latest").replaceAll("[^0-9A-Za-z._-]", "_");
        if (safeVer.isEmpty()) {
            safeVer = "latest";
        }
        String fileName = "wotagei_update_" + safeVer + ".apk";

        updateExecutor.execute(() -> {
            File cacheDir = getContext().getCacheDir();
            cleanupStaleUpdateApkFiles(cacheDir);
            File apkFile = new File(cacheDir, fileName);

            HttpURLConnection conn = null;
            try {
                emitUpdateDownloadProgress(0, 0, 0, "正在连接更新下载源...");
                conn = openConnectionWithRedirects(downloadUrl, "application/octet-stream", 60000);
                int status = conn.getResponseCode();
                if (status < 200 || status >= 300) {
                    call.reject("下载安装包失败（HTTP " + status + "）");
                    return;
                }

                long totalBytes = conn.getContentLengthLong();
                long downloadedBytes = 0;
                int lastEmittedPercent = -1;
                long lastEmitTimeMs = 0L;

                try (
                    InputStream in = conn.getInputStream();
                    FileOutputStream out = new FileOutputStream(apkFile, false)
                ) {
                    byte[] buffer = new byte[16384];
                    int read;
                    while ((read = in.read(buffer)) != -1) {
                        out.write(buffer, 0, read);
                        downloadedBytes += read;
                        int percent = totalBytes > 0
                            ? (int) Math.min(99L, (downloadedBytes * 100L) / totalBytes)
                            : 0;
                        long nowMs = System.currentTimeMillis();
                        if (percent != lastEmittedPercent && nowMs - lastEmitTimeMs >= 120L) {
                            lastEmittedPercent = percent;
                            lastEmitTimeMs = nowMs;
                            String statusText = totalBytes > 0
                                ? String.format("正在下载安装包 %d%%", percent)
                                : String.format("已下载 %.1f MB", downloadedBytes / (1024.0 * 1024.0));
                            emitUpdateDownloadProgress(percent, downloadedBytes, totalBytes, statusText);
                        }
                    }
                    out.flush();
                }

                emitUpdateDownloadProgress(100, downloadedBytes, downloadedBytes, "下载完成，准备安装...");
                pendingInstallApkFile = apkFile;

                Activity activity = getActivity();
                if (activity == null) {
                    cleanupStaleUpdateApkFiles(cacheDir);
                    pendingInstallApkFile = null;
                    call.reject("当前页面不可用，无法拉起系统安装界面");
                    return;
                }
                activity.runOnUiThread(() -> proceedToInstallApk(call, apkFile));
            } catch (Exception e) {
                if (apkFile.exists()) {
                    //noinspection ResultOfMethodCallIgnored
                    apkFile.delete();
                }
                pendingInstallApkFile = null;
                call.reject(
                    "下载更新包失败: " + (e.getMessage() != null ? e.getMessage() : "网络异常"),
                    e
                );
            } finally {
                if (conn != null) {
                    conn.disconnect();
                }
            }
        });
    }

    private void proceedToInstallApk(PluginCall call, File apkFile) {
        if (apkFile == null || !apkFile.exists()) {
            call.reject("安装文件不存在或已被清理");
            return;
        }
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !getContext().getPackageManager().canRequestPackageInstalls()
        ) {
            Intent permIntent = new Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + getContext().getPackageName())
            );
            startActivityForResult(call, permIntent, "handleUnknownSourcePermissionResult");
            return;
        }
        launchApkInstaller(call, apkFile);
    }

    @ActivityCallback
    private void handleUnknownSourcePermissionResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        File apkFile = pendingInstallApkFile;
        boolean granted =
            Build.VERSION.SDK_INT < Build.VERSION_CODES.O
                || getContext().getPackageManager().canRequestPackageInstalls();
        if (granted && apkFile != null && apkFile.exists()) {
            launchApkInstaller(call, apkFile);
            return;
        }

        cleanupStaleUpdateApkFiles(getContext().getCacheDir());
        pendingInstallApkFile = null;
        JSObject res = new JSObject();
        res.put("status", "permission_required");
        res.put("message", "未授予“安装未知应用”权限，请授权后重新尝试更新");
        call.resolve(res);
    }

    private void launchApkInstaller(PluginCall call, File apkFile) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW);
            Uri apkUri;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                apkUri = FileProvider.getUriForFile(
                    getContext(),
                    getContext().getPackageName() + ".fileprovider",
                    apkFile
                );
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } else {
                // Android 6.0 无 FileProvider 授权机制，需对系统安装器开放临时可读
                //noinspection ResultOfMethodCallIgnored
                apkFile.setReadable(true, false);
                apkUri = Uri.fromFile(apkFile);
            }
            intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
            intent.putExtra(Intent.EXTRA_RETURN_RESULT, true);
            startActivityForResult(call, intent, "handleInstallApkResult");
        } catch (Exception e) {
            cleanupStaleUpdateApkFiles(getContext().getCacheDir());
            pendingInstallApkFile = null;
            call.reject("无法唤起系统安装器: " + e.getMessage(), e);
        }
    }

    @ActivityCallback
    private void handleInstallApkResult(PluginCall call, ActivityResult result) {
        // 若用户取消安装、校验失败或退出系统安装器，立即回收临时安装包避免占用缓存
        cleanupStaleUpdateApkFiles(getContext().getCacheDir());
        pendingInstallApkFile = null;
        if (call == null) return;

        JSObject res = new JSObject();
        if (result.getResultCode() == Activity.RESULT_OK) {
            res.put("status", "installer_launched");
        } else {
            res.put("status", "cancelled");
            res.put("message", "已取消安装或安装未完成，临时安装包已自动清理");
        }
        call.resolve(res);
    }

    private void emitUpdateDownloadProgress(
        int percent,
        long downloadedBytes,
        long totalBytes,
        String statusText
    ) {
        JSObject ev = new JSObject();
        ev.put("percent", percent);
        ev.put("downloadedBytes", downloadedBytes);
        ev.put("totalBytes", totalBytes);
        ev.put("statusText", statusText);
        notifyListeners("updateDownloadProgress", ev);
    }

    private HttpURLConnection openConnectionWithRedirects(
        String startUrl,
        String acceptHeader,
        int readTimeoutMs
    ) throws Exception {
        String currentUrl = startUrl;
        for (int hops = 0; hops < 6; hops++) {
            HttpURLConnection conn = (HttpURLConnection) new URL(currentUrl).openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(readTimeoutMs);
            conn.setRequestMethod("GET");
            conn.setRequestProperty("Accept", acceptHeader);
            conn.setRequestProperty("User-Agent", "Wotagei-Compare-Android");
            int code = conn.getResponseCode();
            if (
                code == HttpURLConnection.HTTP_MOVED_PERM
                    || code == HttpURLConnection.HTTP_MOVED_TEMP
                    || code == HttpURLConnection.HTTP_SEE_OTHER
                    || code == 307
                    || code == 308
            ) {
                String location = conn.getHeaderField("Location");
                conn.disconnect();
                if (location == null || location.isEmpty()) {
                    throw new IllegalStateException("重定向缺少 Location 头");
                }
                currentUrl = new URL(new URL(currentUrl), location).toString();
                continue;
            }
            return conn;
        }
        throw new IllegalStateException("更新请求重定向次数过多");
    }
}
