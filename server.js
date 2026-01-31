const express = require('express');
const cors = require('cors');
const net = require('net');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const PKGExtractor = require('./extract.js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

class DualRequestInstaller {
    constructor() {
        this.pcIp = this.getDeploymentIp();
        this.callbackPort = parseInt(process.env.CALLBACK_PORT) || 9022;
        this.callbackServer = null;
        this.activeConnections = new Map();
        this.installationLog = [];
        this.extractor = new PKGExtractor();
        this.uploadDir = path.join(__dirname, 'uploads');
        this.cacheCleanupInterval = null;

        // Installation session tracking
        this.currentInstallation = null;

        // Create uploads directory if it doesn't exist
        if (!fs.existsSync(this.uploadDir)) {
            fs.mkdirSync(this.uploadDir, { recursive: true });
        }

        // Start cache cleanup
        this.startCacheCleanup();
    }

    getDeploymentIp() {
        // For Render.com deployment, use the public domain
        if (process.env.RENDER_EXTERNAL_URL) {
            // Extract hostname from Render URL
            const url = process.env.RENDER_EXTERNAL_URL.replace('https://', '').replace('http://', '');
            this.addLog(`🌐 Using Render URL: ${url}`);
            return url;
        }

        // Check for explicit PUBLIC_IP or SERVER_DOMAIN env vars
        if (process.env.PUBLIC_IP) {
            this.addLog(`🌐 Using PUBLIC_IP: ${process.env.PUBLIC_IP}`);
            return process.env.PUBLIC_IP;
        }

        if (process.env.SERVER_DOMAIN) {
            this.addLog(`🌐 Using SERVER_DOMAIN: ${process.env.SERVER_DOMAIN}`);
            return process.env.SERVER_DOMAIN;
        }

        // Fallback to local IP detection
        return this.getLocalIp();
    }

    getLocalIp() {
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) return iface.address;
            }
        }
        return "127.0.0.1";
    }

    addLog(msg) {
        const timestamp = new Date().toLocaleTimeString();
        const logMsg = `[${timestamp}] ${msg}`;
        console.log(logMsg);
        this.installationLog.push(logMsg);

        // Keep log size manageable (last 1000 entries)
        if (this.installationLog.length > 1000) {
            this.installationLog = this.installationLog.slice(-1000);
        }
    }

    async isPortAvailable(port) {
        return new Promise((resolve) => {
            const server = net.createServer();
            server.once('error', (err) => {
                if (err.code === 'EADDRINUSE') {
                    this.addLog(`⚠️ Port ${port} is in use`);
                    resolve(false);
                } else {
                    resolve(false);
                }
            });
            server.once('listening', () => {
                server.close();
                resolve(true);
            });
            server.listen(port);
        });
    }

    async findAvailablePort(startPort, maxAttempts = 10) {
        for (let i = 0; i < maxAttempts; i++) {
            const port = startPort + i;
            if (await this.isPortAvailable(port)) {
                return port;
            }
        }
        throw new Error(`No available ports found between ${startPort} and ${startPort + maxAttempts - 1}`);
    }

    preparePayload() {
        const payloadPath = path.join(__dirname, 'payload.bin');
        if (!fs.existsSync(payloadPath)) {
            throw new Error("payload.bin missing from server folder");
        }

        const payload = fs.readFileSync(payloadPath);
        const placeholder = Buffer.from([0xB4, 0xB4, 0xB4, 0xB4, 0xB4, 0xB4]);
        const offset = payload.indexOf(placeholder);

        if (offset === -1) throw new Error("Placeholder 0xB4... not found in payload.bin");

        const ipBytes = Buffer.from(this.pcIp.split('.').map(Number));
        const portBytes = Buffer.alloc(2);
        portBytes.writeUInt16BE(this.callbackPort, 0);

        ipBytes.copy(payload, offset);
        portBytes.copy(payload, offset + 4);

        return payload;
    }

    async extractPkgInfo(pkgUrl) {
        try {
            this.addLog(`🔍 Extracting metadata from: ${pkgUrl}`);

            const result = await this.extractor.extractBGFTMetadata(pkgUrl);

            // Prepare icon data for BGFT
            let iconBase64 = null;
            if (result.icon && result.icon.data) {
                iconBase64 = result.icon.data.toString('base64');
                this.addLog(`🖼️ Icon extracted: ${(result.icon.size / 1024).toFixed(2)} KB ${result.icon.type.toUpperCase()}`);
            }

            return {
                success: true,
                bgftMetadata: {
                    title: result.bgft.title,
                    contentId: result.bgft.contentId,
                    type: result.bgft.type,
                    category: result.bgft.category,
                    titleId: result.bgft.titleId,
                    icon: iconBase64
                },
                fullInfo: result.basic,
                hasIcon: result.bgft.hasIcon
            };

        } catch (error) {
            this.addLog(`❌ Extraction failed: ${error.message}`);

            // Fallback: Use filename as title
            const filename = path.basename(pkgUrl);
            const baseName = filename.replace('.pkg', '').replace(/_/g, ' ');

            return {
                success: false,
                bgftMetadata: {
                    title: baseName || 'Unknown Game',
                    contentId: `UNKNOWN-${Date.now().toString(16).toUpperCase()}`,
                    type: '1',
                    category: 'gd',
                    titleId: 'UNKNOWN00000',
                    icon: null
                },
                error: error.message
            };
        }
    }

    async getFileSize(pkgUrl) {
        return new Promise((resolve, reject) => {
            const parsedUrl = new URL(pkgUrl);
            const protocol = parsedUrl.protocol === 'https:' ? https : http;

            const options = {
                method: 'HEAD',
                hostname: parsedUrl.hostname,
                port: parsedUrl.port,
                path: parsedUrl.pathname + parsedUrl.search,
                timeout: 10000,
                headers: {
                    'User-Agent': 'PS4-Installer/1.0'
                }
            };

            const req = protocol.request(options, (res) => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    const length = res.headers['content-length'];
                    if (length) {
                        resolve(parseInt(length, 10));
                    } else {
                        reject(new Error('Content-Length header not found'));
                    }
                } else if (res.statusCode === 302 || res.statusCode === 301) {
                    const redirectUrl = res.headers.location;
                    if (redirectUrl) {
                        this.addLog(`⚠️ Following redirect to: ${redirectUrl}`);
                        this.getFileSize(redirectUrl).then(resolve).catch(reject);
                    } else {
                        reject(new Error(`HTTP ${res.statusCode}: No redirect location`));
                    }
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
                }
            });

            req.on('error', (err) => {
                reject(new Error(`Network error: ${err.message}`));
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Timeout connecting to server'));
            });

            req.end();
        });
    }

    buildMetadataPacket(pkgUrl, pkgSize, pkgInfo) {
        const contentId = pkgInfo.contentId || 'UNKNOWN00000';
        const bgftType = pkgInfo.type || '1';
        const title = pkgInfo.title || 'Package';
        const hasIcon = pkgInfo.icon && pkgInfo.icon.length > 0;

        const urlData = Buffer.from(pkgUrl, 'utf-8');
        const nameData = Buffer.from(title, 'utf-8');
        const idData = Buffer.from(contentId, 'utf-8');
        const typeData = Buffer.from(bgftType, 'utf-8');

        let totalSize = 4 + 4 + urlData.length + 4 + nameData.length +
            4 + idData.length + 4 + typeData.length + 8 + 4;

        let iconData = Buffer.alloc(0);
        if (hasIcon) {
            iconData = Buffer.from(pkgInfo.icon, 'base64');
            totalSize += iconData.length;
        }

        const packet = Buffer.alloc(totalSize);
        let offset = 0;

        const version = hasIcon ? 2 : 1;
        packet.writeUInt32LE(version, offset);
        offset += 4;

        packet.writeUInt32LE(urlData.length, offset);
        offset += 4;
        urlData.copy(packet, offset);
        offset += urlData.length;

        packet.writeUInt32LE(nameData.length, offset);
        offset += 4;
        nameData.copy(packet, offset);
        offset += nameData.length;

        packet.writeUInt32LE(idData.length, offset);
        offset += 4;
        idData.copy(packet, offset);
        offset += idData.length;

        packet.writeUInt32LE(typeData.length, offset);
        offset += 4;
        typeData.copy(packet, offset);
        offset += typeData.length;

        packet.writeBigUInt64LE(BigInt(pkgSize), offset);
        offset += 8;

        if (hasIcon) {
            packet.writeUInt32LE(iconData.length, offset);
            offset += 4;
            iconData.copy(packet, offset);
            this.addLog(`🖼️ Icon included: ${(iconData.length / 1024).toFixed(2)} KB`);
        } else {
            packet.writeUInt32LE(0, offset);
        }

        return packet;
    }

    async startCallbackServer(pkgUrl, pkgSize, pkgInfo) {
        // Cleanup any existing server
        if (this.callbackServer) {
            this.addLog(`🔄 Stopping existing callback server...`);
            await this.stopCallbackServer();
        }

        // Try to find an available port
        try {
            this.callbackPort = await this.findAvailablePort(this.callbackPort);
            this.addLog(`✅ Using port ${this.callbackPort} for callback server`);
        } catch (error) {
            throw new Error(`Failed to find available port: ${error.message}`);
        }

        const installationId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
        this.currentInstallation = {
            id: installationId,
            pkgUrl: pkgUrl,
            pkgSize: pkgSize,
            pkgInfo: pkgInfo,
            hasSentMetadata: false,
            isStreaming: false,
            currentSocket: null,
            reconnectAttempts: 0,
            maxReconnectAttempts: 3
        };

        this.addLog(`📦 Starting installation: ${installationId}`);

        return new Promise((resolve, reject) => {
            this.callbackServer = net.createServer((socket) => {
                const connectionId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);

                this.activeConnections.set(connectionId, {
                    socket: socket,
                    installationId: installationId,
                    connectionId: connectionId,
                    startTime: Date.now(),
                    bytesStreamed: 0,
                    lastActivity: Date.now()
                });

                // Set socket timeout
                socket.setTimeout(120000);

                socket.on('timeout', () => {
                    this.addLog(`⏰ Socket timeout (${connectionId})`);
                    socket.destroy();
                });

                socket.on('error', (err) => {
                    this.addLog(`❌ Socket error (${connectionId}): ${err.message}`);
                    this.activeConnections.delete(connectionId);
                });

                socket.on('close', () => {
                    const connection = this.activeConnections.get(connectionId);
                    if (connection) {
                        const duration = (Date.now() - connection.startTime) / 1000;
                        this.addLog(`🔌 Closed (${connectionId}): ${duration.toFixed(1)}s`);
                    }
                    this.activeConnections.delete(connectionId);
                });

                this.handlePS4Connection(socket, connectionId, installationId);

            });

            this.callbackServer.on('error', (err) => {
                this.addLog(`❌ Callback server error: ${err.message}`);
                reject(err);
            });

            this.callbackServer.on('listening', () => {
                this.addLog(`🎯 Callback server listening on port ${this.callbackPort}`);
                resolve();
            });

            this.callbackServer.listen(this.callbackPort);

            // Start connection cleanup interval
            this.startConnectionCleanup();

            // Auto-close idle server after 10 minutes
            this.idleServerTimeout = setTimeout(() => {
                if (this.callbackServer && this.activeConnections.size === 0) {
                    this.addLog(`🔄 Auto-closing idle server`);
                    this.stopCallbackServer();
                }
            }, 10 * 60 * 1000);
        });
    }

    async stopCallbackServer() {
        return new Promise((resolve) => {
            if (!this.callbackServer) {
                resolve();
                return;
            }

            // Clear idle timeout
            if (this.idleServerTimeout) {
                clearTimeout(this.idleServerTimeout);
                this.idleServerTimeout = null;
            }

            // Stop connection cleanup
            if (this.connectionCleanupInterval) {
                clearInterval(this.connectionCleanupInterval);
                this.connectionCleanupInterval = null;
            }

            // Close all active connections
            this.activeConnections.forEach((connection) => {
                if (connection.socket && !connection.socket.destroyed) {
                    connection.socket.destroy();
                }
            });
            this.activeConnections.clear();

            // Close the server
            this.callbackServer.close(() => {
                this.addLog(`✅ Callback server stopped`);
                this.callbackServer = null;
                this.currentInstallation = null;
                resolve();
            });

            // Force close after 5 seconds
            setTimeout(() => {
                if (this.callbackServer) {
                    this.callbackServer.close();
                    this.callbackServer = null;
                    this.currentInstallation = null;
                }
                resolve();
            }, 5000);
        });
    }

    startConnectionCleanup() {
        if (this.connectionCleanupInterval) {
            clearInterval(this.connectionCleanupInterval);
        }

        this.connectionCleanupInterval = setInterval(() => {
            const now = Date.now();
            for (const [connectionId, connection] of this.activeConnections.entries()) {
                // Close inactive connections (2 minutes)
                if (now - connection.lastActivity > 120000) {
                    this.addLog(`🧹 Cleaning up inactive connection: ${connectionId}`);
                    if (connection.socket && !connection.socket.destroyed) {
                        connection.socket.destroy();
                    }
                    this.activeConnections.delete(connectionId);
                }
            }
        }, 60000); // Run every minute
    }

    startCacheCleanup() {
        if (this.cacheCleanupInterval) {
            clearInterval(this.cacheCleanupInterval);
        }

        this.cacheCleanupInterval = setInterval(() => {
            try {
                const files = fs.readdirSync(this.uploadDir);
                const now = Date.now();
                let cleaned = 0;

                for (const file of files) {
                    if (file.startsWith('cache_') && file.endsWith('.pkg')) {
                        const filePath = path.join(this.uploadDir, file);
                        const stats = fs.statSync(filePath);

                        // Delete files older than 1 hour
                        if (now - stats.mtimeMs > 3600000) {
                            fs.unlinkSync(filePath);
                            cleaned++;
                        }
                    }
                }

                if (cleaned > 0) {
                    this.addLog(`🧹 Cache cleanup: removed ${cleaned} old files`);
                }
            } catch (error) {
                console.error('Cache cleanup error:', error);
            }
        }, 3600000); // Run every hour
    }

    handlePS4Connection(socket, connectionId, installationId) {
        // Update last activity
        const connection = this.activeConnections.get(connectionId);
        if (connection) {
            connection.lastActivity = Date.now();
        }

        if (!this.currentInstallation || this.currentInstallation.id !== installationId) {
            this.addLog(`⚠️ Rejected connection (${connectionId}): Invalid installation`);
            socket.destroy();
            return;
        }

        const installation = this.currentInstallation;

        if (!installation.hasSentMetadata) {
            this.sendMetadata(socket, connectionId, installation);
            installation.hasSentMetadata = true;
            installation.currentSocket = socket;
        } else if (!installation.isStreaming) {
            // Reset reconnect attempts on successful connection
            installation.reconnectAttempts = 0;

            this.addLog(`✅ PS4 reconnected for data`);
            installation.currentSocket = socket;
            installation.isStreaming = true;
            this.streamPackageData(socket, connectionId, installation);
        } else {
            this.addLog(`⚠️ Already streaming to another connection`);
            socket.destroy();
        }
    }

    sendMetadata(socket, connectionId, installation) {
        try {
            const metadata = this.buildMetadataPacket(
                installation.pkgUrl,
                installation.pkgSize,
                installation.pkgInfo
            );

            this.addLog(`📤 Sending metadata (${metadata.length} bytes) to ${connectionId}`);
            this.addLog(`   Title: ${installation.pkgInfo.title}`);
            this.addLog(`   Size: ${(installation.pkgSize / 1024 / 1024).toFixed(2)} MB`);

            socket.write(metadata, (err) => {
                if (err) {
                    this.addLog(`❌ Send failed to ${connectionId}: ${err.message}`);
                    socket.destroy();
                } else {
                    this.addLog(`✅ Metadata sent to ${connectionId}`);
                }
            });
        } catch (err) {
            this.addLog(`❌ Metadata error for ${connectionId}: ${err.message}`);
            socket.destroy();
        }
    }

    streamPackageData(socket, connectionId, installation) {
        this.addLog(`🔌 Closing PS4 connection, starting download`);

        // Don't destroy socket immediately, let it close naturally
        installation.currentSocket = null;
        installation.isStreaming = false;

        this.downloadPackageToLocalCache(installation)
            .then(localPath => {
                this.addLog(`✅ Cached to: ${path.basename(localPath)}`);
                this.waitForPS4Reconnection(installation, localPath);
            })
            .catch(error => {
                this.addLog(`❌ Download failed: ${error.message}`);
                installation.isStreaming = false;

                // Increment reconnect attempts
                installation.reconnectAttempts++;
                if (installation.reconnectAttempts >= installation.maxReconnectAttempts) {
                    this.addLog(`❌ Max reconnect attempts reached, stopping installation`);
                    this.stopCallbackServer();
                }
            });
    }

    async downloadPackageToLocalCache(installation) {
        return new Promise((resolve, reject) => {
            const parsedUrl = new URL(installation.pkgUrl);
            const protocol = parsedUrl.protocol === 'https:' ? https : http;

            const cacheFilename = `cache_${installation.id}.pkg`;
            const cachePath = path.join(this.uploadDir, cacheFilename);

            this.addLog(`📥 Downloading to cache: ${cacheFilename}`);

            const options = {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port,
                path: parsedUrl.pathname + parsedUrl.search,
                timeout: 120000, // 2 minute timeout
                headers: {
                    'User-Agent': 'PS4-Installer/1.0',
                    'Accept-Encoding': 'identity' // No compression for accurate progress
                }
            };

            const req = protocol.get(options, (res) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }

                const fileStream = fs.createWriteStream(cachePath);
                const contentLength = parseInt(res.headers['content-length'] || '0', 10);
                let downloaded = 0;
                let lastLog = Date.now();

                res.pipe(fileStream);

                res.on('data', (chunk) => {
                    downloaded += chunk.length;
                    const now = Date.now();
                    if (now - lastLog > 5000) {
                        const percent = contentLength > 0 ?
                            ((downloaded / contentLength) * 100).toFixed(1) : '??';
                        this.addLog(`📊 ${(downloaded / 1024 / 1024).toFixed(2)}MB (${percent}%)`);
                        lastLog = now;
                    }
                });

                fileStream.on('finish', () => {
                    fileStream.close();
                    this.addLog(`✅ Download complete: ${(downloaded / 1024 / 1024).toFixed(2)}MB`);
                    resolve(cachePath);
                });

                fileStream.on('error', (err) => {
                    fileStream.destroy();
                    try { fs.unlinkSync(cachePath); } catch (e) { }
                    reject(new Error(`File write error: ${err.message}`));
                });

                res.on('error', (err) => {
                    fileStream.destroy();
                    try { fs.unlinkSync(cachePath); } catch (e) { }
                    reject(new Error(`Download error: ${err.message}`));
                });
            });

            req.on('error', (err) => {
                reject(new Error(`Request error: ${err.message}`));
            });

            req.setTimeout(120000, () => {
                req.destroy();
                reject(new Error('Download timeout'));
            });
        });
    }

    waitForPS4Reconnection(installation, localPath) {
        const reconnectTimeout = setTimeout(() => {
            this.addLog(`❌ PS4 didn't reconnect within timeout`);
            installation.isStreaming = false;
            try {
                if (fs.existsSync(localPath)) {
                    fs.unlinkSync(localPath);
                    this.addLog(`🧹 Removed cache file: ${path.basename(localPath)}`);
                }
            } catch (e) {
                // Ignore cleanup errors
            }
        }, 45000); // 45 second timeout

        const checkInterval = setInterval(() => {
            if (installation.currentSocket &&
                !installation.currentSocket.destroyed &&
                installation.currentSocket.writable) {

                clearTimeout(reconnectTimeout);
                clearInterval(checkInterval);
                this.streamFromCache(installation.currentSocket, localPath, installation);
                return;
            }

            if (!installation.isStreaming) {
                clearTimeout(reconnectTimeout);
                clearInterval(checkInterval);
                try {
                    if (fs.existsSync(localPath)) {
                        fs.unlinkSync(localPath);
                    }
                } catch (e) {
                    // Ignore cleanup errors
                }
            }
        }, 1000);
    }

    streamFromCache(socket, cachePath, installation) {
        try {
            if (!fs.existsSync(cachePath)) {
                throw new Error(`Cache file not found: ${cachePath}`);
            }

            const fileSize = fs.statSync(cachePath).size;
            const fileStream = fs.createReadStream(cachePath);

            this.addLog(`📤 Streaming from cache: ${(fileSize / 1024 / 1024).toFixed(2)}MB`);

            let streamed = 0;
            let lastLog = Date.now();

            fileStream.on('data', (chunk) => {
                streamed += chunk.length;

                const canWrite = socket.write(chunk);
                if (!canWrite) {
                    fileStream.pause();
                    socket.once('drain', () => fileStream.resume());
                }

                const now = Date.now();
                if (now - lastLog > 5000) {
                    const percent = ((streamed / fileSize) * 100).toFixed(1);
                    this.addLog(`📦 ${(streamed / 1024 / 1024).toFixed(2)}MB (${percent}%)`);
                    lastLog = now;
                }
            });

            fileStream.on('end', () => {
                this.addLog(`✅ Stream complete!`);
                setTimeout(() => {
                    if (!socket.destroyed) {
                        socket.end();
                    }
                }, 1000);

                // Cleanup cache file
                this.safeDeleteFile(cachePath);
            });

            fileStream.on('error', (err) => {
                this.addLog(`❌ Stream error: ${err.message}`);
                socket.destroy();
                this.safeDeleteFile(cachePath);
            });

            socket.on('error', (err) => {
                this.addLog(`❌ Socket error during streaming: ${err.message}`);
                fileStream.destroy();
                this.safeDeleteFile(cachePath);
            });

            socket.on('close', () => {
                fileStream.destroy();
                this.safeDeleteFile(cachePath);
                installation.isStreaming = false;
            });

        } catch (err) {
            this.addLog(`❌ Streaming setup error: ${err.message}`);
            socket.destroy();
            this.safeDeleteFile(cachePath);
            installation.isStreaming = false;
        }
    }

    safeDeleteFile(filePath) {
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                this.addLog(`🧹 Removed cache file: ${path.basename(filePath)}`);
            }
        } catch (e) {
            // Ignore cleanup errors
        }
    }
}

const installer = new DualRequestInstaller();

// API Routes
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        environment: process.env.NODE_ENV || 'production',
        serverIp: installer.pcIp,
        port: PORT,
        callbackPort: installer.callbackPort,
        uptime: process.uptime(),
        activeConnections: installer.activeConnections.size,
        logsCount: installer.installationLog.length,
        currentInstallation: installer.currentInstallation ? installer.currentInstallation.id : null
    });
});

app.post('/api/extract', async (req, res) => {
    try {
        const { pkgUrl } = req.body;
        if (!pkgUrl) {
            return res.status(400).json({ success: false, error: "No PKG URL provided" });
        }

        installer.addLog(`🔍 Extract request: ${pkgUrl}`);
        const result = await installer.extractPkgInfo(pkgUrl);

        res.json({
            success: true,
            extraction: result,
            serverIp: installer.pcIp,
            callbackPort: installer.callbackPort
        });
    } catch (error) {
        installer.addLog(`❌ Extract error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/prepare-install', async (req, res) => {
    try {
        const { pkgUrl, customInfo } = req.body;
        if (!pkgUrl) {
            return res.status(400).json({ success: false, error: "No PKG URL provided" });
        }

        installer.addLog(`📍 Install preparation request: ${pkgUrl}`);

        // Extract package info
        const extraction = await installer.extractPkgInfo(pkgUrl);

        // Get file size
        let pkgSize = 0;
        try {
            pkgSize = await installer.getFileSize(pkgUrl);
            installer.addLog(`📏 Size: ${(pkgSize / 1024 / 1024).toFixed(2)} MB`);
        } catch (sizeError) {
            installer.addLog(`⚠️ Size unknown, using 1GB default`);
            pkgSize = 1024 * 1024 * 1024;
        }

        // Merge custom info if provided
        let finalInfo = extraction.bgftMetadata;
        if (customInfo && typeof customInfo === 'object') {
            finalInfo = { ...finalInfo, ...customInfo };
            installer.addLog(`⚙️ Custom metadata applied`);
        }

        // Start callback server
        await installer.startCallbackServer(pkgUrl, pkgSize, finalInfo);

        // Prepare payload
        const payload = installer.preparePayload();
        installer.addLog(`📦 Payload ready: ${payload.length} bytes`);

        res.json({
            success: true,
            payload: payload.toString('hex'),
            payloadSize: payload.length,
            packageSize: pkgSize,
            packageInfo: finalInfo,
            extraction: extraction,
            serverIp: installer.pcIp,
            callbackPort: installer.callbackPort,
            serverUrl: `http://${installer.pcIp}:${PORT}`,
            installationId: installer.currentInstallation ? installer.currentInstallation.id : null
        });
    } catch (error) {
        installer.addLog(`❌ Install preparation failed: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/stop-installation', async (req, res) => {
    try {
        installer.addLog(`🛑 Stopping current installation`);
        await installer.stopCallbackServer();
        res.json({ success: true, message: 'Installation stopped' });
    } catch (error) {
        installer.addLog(`❌ Failed to stop installation: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const logs = installer.installationLog.slice(-limit);

    res.json({
        logs: logs,
        total: installer.installationLog.length,
        limit: limit,
        serverIp: installer.pcIp,
        activeConnections: installer.activeConnections.size,
        currentInstallation: installer.currentInstallation ? {
            id: installer.currentInstallation.id,
            title: installer.currentInstallation.pkgInfo.title,
            hasSentMetadata: installer.currentInstallation.hasSentMetadata,
            isStreaming: installer.currentInstallation.isStreaming,
            reconnectAttempts: installer.currentInstallation.reconnectAttempts
        } : null
    });
});

app.delete('/api/logs', (req, res) => {
    const oldCount = installer.installationLog.length;
    installer.installationLog = [];
    installer.addLog(`🧹 Logs cleared (${oldCount} entries)`);
    res.json({ success: true, cleared: oldCount });
});

app.get('/api/info', (req, res) => {
    res.json({
        server: {
            ip: installer.pcIp,
            port: PORT,
            callbackPort: installer.callbackPort,
            uploadDir: installer.uploadDir,
            payloadExists: fs.existsSync(path.join(__dirname, 'payload.bin'))
        },
        installation: installer.currentInstallation ? {
            id: installer.currentInstallation.id,
            title: installer.currentInstallation.pkgInfo.title,
            size: installer.currentInstallation.pkgSize,
            hasSentMetadata: installer.currentInstallation.hasSentMetadata,
            isStreaming: installer.currentInstallation.isStreaming,
            reconnectAttempts: installer.currentInstallation.reconnectAttempts
        } : null,
        connections: {
            active: installer.activeConnections.size,
            callbackServer: installer.callbackServer ? 'Running' : 'Stopped'
        },
        logs: {
            count: installer.installationLog.length,
            recent: installer.installationLog.slice(-5)
        }
    });
});

app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>PS4 PKG Installer</title>
            <style>
                body { 
                    font-family: Arial, sans-serif; 
                    text-align: center; 
                    padding: 20px; 
                    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
                    color: #fff;
                    min-height: 100vh;
                    margin: 0;
                }
                .container { 
                    max-width: 800px; 
                    margin: 0 auto; 
                    background: rgba(42, 42, 42, 0.9); 
                    padding: 40px; 
                    border-radius: 15px;
                    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
                    border: 1px solid #0070ff;
                }
                h1 { 
                    color: #0070ff; 
                    font-size: 2.5em;
                    margin-bottom: 20px;
                    text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
                }
                .status-box {
                    background: rgba(0, 112, 255, 0.1);
                    border: 1px solid #0070ff;
                    border-radius: 8px;
                    padding: 20px;
                    margin: 20px 0;
                    text-align: left;
                }
                .endpoint {
                    background: #333;
                    padding: 10px;
                    border-radius: 5px;
                    margin: 10px 0;
                    font-family: monospace;
                    word-break: break-all;
                }
                a {
                    color: #00a8ff;
                    text-decoration: none;
                    transition: color 0.3s;
                }
                a:hover {
                    color: #4cd137;
                    text-decoration: underline;
                }
                .logo {
                    font-size: 4em;
                    margin-bottom: 20px;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="logo">🎮</div>
                <h1>PS4 PKG Installer Server</h1>
                
                <div class="status-box">
                    <h3>Server Status</h3>
                    <p><strong>Server IP:</strong> ${installer.pcIp}:${PORT}</p>
                    <p><strong>Callback Port:</strong> ${installer.callbackPort}</p>
                    <p><strong>Status:</strong> <span style="color: #4cd137;">✓ Running</span></p>
                </div>
                
                <h3>API Endpoints</h3>
                <div class="endpoint">GET <a href="/api/health">/api/health</a> - Server health check</div>
                <div class="endpoint">POST /api/extract - Extract PKG metadata</div>
                <div class="endpoint">POST /api/prepare-install - Prepare installation</div>
                <div class="endpoint">GET <a href="/api/logs">/api/logs</a> - View server logs</div>
                <div class="endpoint">GET <a href="/api/info">/api/info</a> - Server information</div>
                
                <p style="margin-top: 30px; color: #aaa;">
                    Use the API endpoints with your PKG installer client
                </p>
            </div>
        </body>
        </html>
    `);
});

// Error handling middleware
app.use((err, req, res, next) => {
    installer.addLog(`❌ Server error: ${err.message}`);
    console.error(err.stack);
    res.status(500).json({
        success: false,
        error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message
    });
});

app.use((req, res) => {
    res.status(404).json({ success: false, error: "Endpoint not found" });
});

// Start server
const server = app.listen(PORT, () => {
    console.log(`\n🚀 PS4 PKG Installer Server`);
    console.log(`============================`);
    console.log(`🌐 Server: http://${installer.pcIp}:${PORT}`);
    console.log(`📞 Callback port: ${installer.callbackPort}`);
    console.log(`📁 Uploads directory: ${installer.uploadDir}`);
    console.log(`📦 Payload file: ${fs.existsSync(path.join(__dirname, 'payload.bin')) ? '✓ Found' : '✗ Missing'}`);
    console.log(`\n✅ Server is ready!\n`);
    installer.addLog(`Server started on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🔄 Shutting down gracefully...');

    try {
        await installer.stopCallbackServer();

        if (installer.cacheCleanupInterval) {
            clearInterval(installer.cacheCleanupInterval);
        }

        server.close(() => {
            console.log('✅ Server stopped');
            process.exit(0);
        });

        // Force close after 5 seconds
        setTimeout(() => {
            console.log('⚠️ Forcing shutdown...');
            process.exit(1);
        }, 5000);

    } catch (error) {
        console.error('Shutdown error:', error);
        process.exit(1);
    }
});

process.on('SIGTERM', async () => {
    console.log('\n🔻 Received SIGTERM, shutting down...');
    await installer.stopCallbackServer();
    server.close(() => {
        process.exit(0);
    });
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    installer.addLog(`❌ Uncaught Exception: ${error.message}`);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    installer.addLog(`❌ Unhandled Rejection: ${reason}`);
});

module.exports = { app, installer };