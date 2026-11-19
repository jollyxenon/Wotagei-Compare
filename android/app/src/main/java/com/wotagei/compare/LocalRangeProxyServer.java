package com.wotagei.compare;

import android.content.ContentResolver;
import android.content.Context;
import android.content.res.AssetFileDescriptor;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 轻量级本地 HTTP Range 流式代理服务
 * 仅监听 127.0.0.1 随机端口，通过 ContentResolver 按需分片读取 content:// URI，
 * 供 WebView <video> 零拷贝加载与毫秒级随机寻道 (HTTP 206 Partial Content)。
 */
public class LocalRangeProxyServer {
    private final Context appContext;
    private final Map<String, Uri> uriRegistry = new ConcurrentHashMap<>();
    private final Map<Integer, String> channelTokenMap = new ConcurrentHashMap<>();
    private final Map<String, AudioPcmPayload> audioPcmRegistry = new ConcurrentHashMap<>();
    private final Map<String, String> audioOwnerTokenMap = new ConcurrentHashMap<>();
    private final ExecutorService executor = Executors.newCachedThreadPool();

    private static class AudioPcmPayload {
        final String ownerKey;
        final byte[] pcmInt16Le;
        final int sampleRate;
        final double durationSec;

        AudioPcmPayload(String ownerKey, byte[] pcmInt16Le, int sampleRate, double durationSec) {
            this.ownerKey = ownerKey;
            this.pcmInt16Le = pcmInt16Le;
            this.sampleRate = sampleRate;
            this.durationSec = durationSec;
        }
    }

    private ServerSocket serverSocket;
    private int port = -1;
    private volatile boolean running = false;

    public LocalRangeProxyServer(Context context) {
        this.appContext = context != null ? context.getApplicationContext() : null;
    }

    /**
     * 懒启动本地回环监听端口
     */
    public synchronized int ensureStarted() throws IOException {
        if (running && serverSocket != null && !serverSocket.isClosed() && port > 0) {
            return port;
        }
        InetAddress loopback = InetAddress.getByAddress(new byte[] {127, 0, 0, 1});
        serverSocket = new ServerSocket(0, 64, loopback);
        port = serverSocket.getLocalPort();
        running = true;

        Thread acceptThread = new Thread(() -> {
            while (running && serverSocket != null && !serverSocket.isClosed()) {
                try {
                    Socket client = serverSocket.accept();
                    executor.execute(() -> handleClient(client));
                } catch (IOException ignored) {
                    if (!running) break;
                }
            }
        }, "LocalRangeProxyAccept");
        acceptThread.setDaemon(true);
        acceptThread.start();

        return port;
    }

    /**
     * 为指定通道注册 URI 并返回本地流式访问 URL（覆盖同通道旧绑定，并清理旧 URI 未消费音频载荷）
     */
    public String registerChannelUri(int channel, Uri uri) throws IOException {
        int activePort = ensureStarted();
        String oldToken = channelTokenMap.remove(channel);
        if (oldToken != null) {
            Uri oldUri = uriRegistry.remove(oldToken);
            if (oldUri != null && !oldUri.equals(uri) && !uriRegistry.containsValue(oldUri)) {
                removePendingAudioForOwner(oldUri.toString());
            }
        }
        String token = UUID.randomUUID().toString().replace("-", "");
        uriRegistry.put(token, uri);
        if (channel > 0) {
            channelTokenMap.put(channel, token);
        }
        return "http://127.0.0.1:" + activePort + "/video/" + token;
    }

    /**
     * 注册一次性音频 PCM 二进制载荷并返回本地读取 URL（同属主覆盖时清理前次未消费载荷）
     */
    public String registerAudioPcm(String ownerKey, byte[] pcmInt16Le, int sampleRate, double durationSec) throws IOException {
        int activePort = ensureStarted();
        if (ownerKey != null && !ownerKey.isEmpty()) {
            removePendingAudioForOwner(ownerKey);
        }
        String token = UUID.randomUUID().toString().replace("-", "");
        audioPcmRegistry.put(token, new AudioPcmPayload(ownerKey, pcmInt16Le, sampleRate, durationSec));
        if (ownerKey != null && !ownerKey.isEmpty()) {
            audioOwnerTokenMap.put(ownerKey, token);
        }
        return "http://127.0.0.1:" + activePort + "/audio/" + token;
    }

    private void removePendingAudioForOwner(String ownerKey) {
        if (ownerKey == null || ownerKey.isEmpty()) return;
        String prevToken = audioOwnerTokenMap.remove(ownerKey);
        if (prevToken != null) {
            audioPcmRegistry.remove(prevToken);
        }
    }

    /**
     * 停止服务并释放注册表
     */
    public synchronized void shutdown() {
        running = false;
        uriRegistry.clear();
        channelTokenMap.clear();
        audioPcmRegistry.clear();
        audioOwnerTokenMap.clear();
        if (serverSocket != null) {
            try {
                serverSocket.close();
            } catch (IOException ignored) {}
            serverSocket = null;
        }
        executor.shutdownNow();
    }

    private void handleClient(Socket socket) {
        try (Socket s = socket) {
            s.setSoTimeout(15000);
            InputStream rawIn = new BufferedInputStream(s.getInputStream(), 8192);
            OutputStream out = new BufferedOutputStream(s.getOutputStream(), 65536);

            // 1. 解析 HTTP 请求行与头部
            String requestLine = readLine(rawIn);
            if (requestLine == null || requestLine.isEmpty()) {
                return;
            }
            String[] parts = requestLine.split(" ");
            if (parts.length < 2) {
                writeSimpleStatus(out, "400 Bad Request");
                return;
            }
            String method = parts[0].toUpperCase();
            String path = parts[1];
            int qIdx = path.indexOf('?');
            if (qIdx >= 0) {
                path = path.substring(0, qIdx);
            }

            String rangeHeader = null;
            String hostHeader = null;
            String line;
            while ((line = readLine(rawIn)) != null && !line.isEmpty()) {
                int colon = line.indexOf(':');
                if (colon > 0) {
                    String name = line.substring(0, colon).trim().toLowerCase();
                    if ("range".equals(name)) {
                        rangeHeader = line.substring(colon + 1).trim();
                    } else if ("host".equals(name)) {
                        hostHeader = line.substring(colon + 1).trim();
                    }
                }
            }

            // Host 头校验：仅接受指向本机回环地址的请求。服务虽仅绑定 127.0.0.1，
            // 该校验可将安全边界显式化，并防御经上层代理转发或 DNS 重绑定类误用。
            // 说明：Android 上 127.0.0.1 为全设备共享，随机 token 是访问控制主体，
            // 此处为纵深防御层而非唯一防线。
            if (hostHeader == null
                    || !(hostHeader.startsWith("127.0.0.1") || hostHeader.startsWith("localhost"))) {
                writeSimpleStatus(out, "403 Forbidden");
                return;
            }

            if ("OPTIONS".equals(method)) {
                String corsResp = "HTTP/1.1 204 No Content\r\n"
                    + "Access-Control-Allow-Origin: *\r\n"
                    + "Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n"
                    + "Access-Control-Allow-Headers: Range\r\n"
                    + "Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges, X-Sample-Rate, X-Duration\r\n"
                    + "Connection: close\r\n\r\n";
                out.write(corsResp.getBytes(StandardCharsets.US_ASCII));
                out.flush();
                return;
            }

            if (!"GET".equals(method) && !"HEAD".equals(method)) {
                writeSimpleStatus(out, "405 Method Not Allowed");
                return;
            }

            // 分支 A：一次性音频 PCM 二进制流下载（前端读取后即刻释放 Java 内存）
            if (path.startsWith("/audio/")) {
                String audioToken = path.substring("/audio/".length());
                AudioPcmPayload payload = "GET".equals(method)
                    ? audioPcmRegistry.remove(audioToken)
                    : audioPcmRegistry.get(audioToken);
                if (payload == null) {
                    writeSimpleStatus(out, "404 Not Found");
                    return;
                }
                if ("GET".equals(method) && payload.ownerKey != null && !payload.ownerKey.isEmpty()) {
                    audioOwnerTokenMap.remove(payload.ownerKey, audioToken);
                }
                StringBuilder audioHeaders = new StringBuilder();
                audioHeaders.append("HTTP/1.1 200 OK\r\n");
                audioHeaders.append("Content-Type: application/octet-stream\r\n");
                audioHeaders.append("Content-Length: ").append(payload.pcmInt16Le.length).append("\r\n");
                audioHeaders.append("X-Sample-Rate: ").append(payload.sampleRate).append("\r\n");
                audioHeaders.append("X-Duration: ").append(payload.durationSec).append("\r\n");
                audioHeaders.append("Access-Control-Allow-Origin: *\r\n");
                audioHeaders.append("Access-Control-Expose-Headers: Content-Length, X-Sample-Rate, X-Duration\r\n");
                audioHeaders.append("Cache-Control: no-store\r\n");
                audioHeaders.append("Connection: close\r\n\r\n");
                out.write(audioHeaders.toString().getBytes(StandardCharsets.US_ASCII));
                if ("GET".equals(method)) {
                    out.write(payload.pcmInt16Le);
                }
                out.flush();
                return;
            }

            if (!path.startsWith("/video/")) {
                writeSimpleStatus(out, "404 Not Found");
                return;
            }
            String token = path.substring("/video/".length());
            Uri uri = uriRegistry.get(token);
            if (uri == null) {
                writeSimpleStatus(out, "404 Not Found");
                return;
            }

            ContentResolver resolver = appContext.getContentResolver();
            String mimeType = resolver.getType(uri);
            if (mimeType == null || mimeType.isEmpty()) {
                mimeType = "video/mp4";
            }

            long totalLength = resolveContentLength(resolver, uri);
            if (totalLength <= 0) {
                writeSimpleStatus(out, "500 Internal Server Error");
                return;
            }

            // 2. 解析 Range 区间
            long start = 0;
            long end = totalLength - 1;
            boolean isPartial = false;

            if (rangeHeader != null && rangeHeader.startsWith("bytes=")) {
                String spec = rangeHeader.substring("bytes=".length()).trim();
                int comma = spec.indexOf(',');
                if (comma >= 0) {
                    spec = spec.substring(0, comma).trim();
                }
                int dash = spec.indexOf('-');
                if (dash >= 0) {
                    String sPart = spec.substring(0, dash).trim();
                    String ePart = spec.substring(dash + 1).trim();
                    try {
                        if (sPart.isEmpty() && !ePart.isEmpty()) {
                            long suffix = Long.parseLong(ePart);
                            start = Math.max(0, totalLength - suffix);
                            end = totalLength - 1;
                        } else if (!sPart.isEmpty()) {
                            start = Long.parseLong(sPart);
                            end = ePart.isEmpty() ? (totalLength - 1) : Long.parseLong(ePart);
                        }
                        if (start < 0 || start >= totalLength || end < start) {
                            String invalid = "HTTP/1.1 416 Range Not Satisfiable\r\n"
                                + "Content-Range: bytes */" + totalLength + "\r\n"
                                + "Connection: close\r\n\r\n";
                            out.write(invalid.getBytes(StandardCharsets.US_ASCII));
                            out.flush();
                            return;
                        }
                        end = Math.min(end, totalLength - 1);
                        isPartial = true;
                    } catch (NumberFormatException ignored) {}
                }
            }

            long contentLen = end - start + 1;

            // 3. 发送响应头
            StringBuilder headers = new StringBuilder();
            headers.append(isPartial ? "HTTP/1.1 206 Partial Content\r\n" : "HTTP/1.1 200 OK\r\n");
            headers.append("Content-Type: ").append(mimeType).append("\r\n");
            headers.append("Accept-Ranges: bytes\r\n");
            headers.append("Content-Length: ").append(contentLen).append("\r\n");
            if (isPartial) {
                headers.append("Content-Range: bytes ").append(start).append("-").append(end).append("/").append(totalLength).append("\r\n");
            }
            headers.append("Access-Control-Allow-Origin: *\r\n");
            headers.append("Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges\r\n");
            headers.append("Cache-Control: no-store\r\n");
            headers.append("Connection: close\r\n\r\n");

            out.write(headers.toString().getBytes(StandardCharsets.US_ASCII));

            if ("HEAD".equals(method)) {
                out.flush();
                return;
            }

            // 4. 随机定位并分块输出指定字节区间
            try (AssetFileDescriptor afd = resolver.openAssetFileDescriptor(uri, "r")) {
                if (afd == null) return;
                try (FileInputStream fis = afd.createInputStream()) {
                    long startOffset = afd.getStartOffset();
                    long targetPos = startOffset + start;
                    if (targetPos > 0) {
                        // 优先利用 FileChannel.position 实现 O(1) 定位，不可用时回退 skip
                        try {
                            fis.getChannel().position(targetPos);
                        } catch (Exception channelEx) {
                            long remainingSkip = targetPos;
                            while (remainingSkip > 0) {
                                long skipped = fis.skip(remainingSkip);
                                if (skipped <= 0) {
                                    if (fis.read() < 0) break;
                                    remainingSkip--;
                                } else {
                                    remainingSkip -= skipped;
                                }
                            }
                        }
                    }

                    byte[] buffer = new byte[65536];
                    long left = contentLen;
                    while (left > 0) {
                        int toRead = (int) Math.min(buffer.length, left);
                        int read = fis.read(buffer, 0, toRead);
                        if (read < 0) break;
                        out.write(buffer, 0, read);
                        left -= read;
                    }
                    out.flush();
                }
            }
        } catch (IOException ignored) {
            // 客户端 seek 中断旧连接属正常行为，静默退出
        }
    }

    private long resolveContentLength(ContentResolver resolver, Uri uri) {
        try (AssetFileDescriptor afd = resolver.openAssetFileDescriptor(uri, "r")) {
            if (afd != null && afd.getLength() > 0) {
                return afd.getLength();
            }
        } catch (Exception ignored) {}

        try (Cursor cursor = resolver.query(uri, new String[] {OpenableColumns.SIZE}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int idx = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (idx >= 0 && !cursor.isNull(idx)) {
                    long sz = cursor.getLong(idx);
                    if (sz > 0) return sz;
                }
            }
        } catch (Exception ignored) {}

        return -1;
    }

    private String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream baos = new ByteArrayOutputStream(128);
        int prev = -1;
        int b;
        while ((b = in.read()) != -1) {
            if (b == '\n') {
                byte[] arr = baos.toByteArray();
                int len = arr.length;
                if (prev == '\r' && len > 0) {
                    len--;
                }
                return new String(arr, 0, len, StandardCharsets.UTF_8);
            }
            baos.write(b);
            prev = b;
            if (baos.size() > 8192) {
                throw new IOException("Header line too long");
            }
        }
        return baos.size() > 0 ? baos.toString("UTF-8") : null;
    }

    private void writeSimpleStatus(OutputStream out, String status) throws IOException {
        String resp = "HTTP/1.1 " + status + "\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
        out.write(resp.getBytes(StandardCharsets.US_ASCII));
        out.flush();
    }
}
