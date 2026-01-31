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
        // Initialize ALL properties FIRST
        this.installationLog = [];
        this.activeConnections = new Map();
        this.currentInstallation = null;
        this.callbackServer = null;
        this.uploadDir = path.join(__dirname, 'uploads');
        this.cacheCleanupInterval = null;
        this.idleServerTimeout = null;
        this.connectionCleanupInterval = null;

        // Create uploads directory if it doesn't exist
        if (!fs.existsSync(this.uploadDir)) {
            fs.mkdirSync(this.uploadDir, { recursive: true });
        }

        // Initialize extractor
        this.extractor = new PKGExtractor();

        // Get deployment IP for Render
        this.pcIp = this.getDeploymentIp();
        this.callbackPort = 9022; // Fixed port for Render

        // Start cache cleanup
        this.startCacheCleanup();

        this.addLog(`✅ DualRequestInstaller initialized on ${this.pcIp}:${this.callbackPort}`);
    }

    getDeploymentIp() {
        // For Render.com, use the public URL
        if (process.env.RENDER_EXTERNAL_URL) {
            const url = process.env.RENDER_EXTERNAL_URL;
            this.addLog(`🌐 Using Render URL: ${url}`);
            return url.replace('https://', '').replace('http://', '').split(':')[0];
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

        // For local development
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

        // Ensure installationLog exists (safety check)
        if (!this.installationLog) {
            this.installationLog = [];
        }

        this.installationLog.push(logMsg);

        // Keep log size manageable (last 1000 entries)
        if (this.installationLog.length > 1000) {
            this.installationLog = this.installationLog.slice(-1000);
        }
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
        // BGFT format for PS4
        const urlData = Buffer.from(pkgUrl, 'utf-8');
        const nameData = Buffer.from(pkgInfo.title || 'Game', 'utf-8');
        const contentIdData = Buffer.from(pkgInfo.contentId || 'UP0000-CUSA00000_00-GAME0000000000', 'utf-8');
        const titleIdData = Buffer.from(pkgInfo.titleId || 'CUSA00000', 'utf-8');

        // Calculate total size
        let totalSize = 16; // Magic (4) + Version (4) + FileSize (8)
        totalSize += 4 + urlData.length;
        totalSize += 4 + nameData.length;
        totalSize += 4 + contentIdData.length;
        totalSize += 4 + titleIdData.length;

        const packet = Buffer.alloc(totalSize);
        let offset = 0;

        // Magic: "GBFT" (0x47424654)
        packet.writeUInt32LE(0x47424654, offset);
        offset += 4;

        // Version: 1
        packet.writeUInt32LE(1, offset);
        offset += 4;

        // URL
        packet.writeUInt32LE(urlData.length, offset);
        offset += 4;
        urlData.copy(packet, offset);
        offset += urlData.length;

        // Title
        packet.writeUInt32LE(nameData.length, offset);
        offset += 4;
        nameData.copy(packet, offset);
        offset += nameData.length;

        // Content ID
        packet.writeUInt32LE(contentIdData.length, offset);
        offset += 4;
        contentIdData.copy(packet, offset);
        offset += contentIdData.length;

        // Title ID
        packet.writeUInt32LE(titleIdData.length, offset);
        offset += 4;
        titleIdData.copy(packet, offset);
        offset += titleIdData.length;

        // File size (64-bit little endian)
        packet.writeBigUInt64LE(BigInt(pkgSize), offset);

        this.addLog(`📦 Built BGFT packet: ${packet.length} bytes`);
        this.addLog(`   Title: "${pkgInfo.title || 'Game'}"`);
        this.addLog(`   Content ID: ${pkgInfo.contentId}`);
        this.addLog(`   Size: ${(pkgSize / 1024 / 1024).toFixed(2)} MB`);

        return packet;
    }

    startCallbackServer(pkgUrl, pkgSize, pkgInfo) {
        // Close existing server if running
        if (this.callbackServer) {
            this.addLog(`🔄 Stopping existing callback server...`);
            this.stopCallbackServer();
        }

        // Create installation session
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

        }).listen(this.callbackPort, () => {
            this.addLog(`🎯 Callback server listening on port ${this.callbackPort}`);
        });

        this.callbackServer.on('error', (err) => {
            this.addLog(`❌ Callback server error: ${err.message}`);
        });

        // Start connection cleanup
        this.startConnectionCleanup();

        // Auto-close idle server after 10 minutes
        this.idleServerTimeout = setTimeout(() => {
            if (this.callbackServer && this.activeConnections.size === 0) {
                this.addLog(`🔄 Auto-closing idle server`);
                this.stopCallbackServer();
            }
        }, 10 * 60 * 1000);
    }

    stopCallbackServer() {
        if (!this.callbackServer) {
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
        }, 60000);
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
        }, 3600000);
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
            // PS4 reconnected for data
            installation.reconnectAttempts = 0;
            this.addLog(`✅ PS4 requesting download data`);

            // Send success response (0x01) - tells PS4 to start downloading
            const response = Buffer.from([0x01]);
            socket.write(response, (err) => {
                if (err) {
                    this.addLog(`❌ Failed to send response: ${err.message}`);
                } else {
                    this.addLog(`✅ Sent success response to PS4`);
                    this.addLog(`📤 PS4 should now show "${installation.pkgInfo.title}" in downloads`);
                }
                socket.end();
            });

            installation.isStreaming = true;
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

        // If extraction failed, use fallback metadata
        let finalInfo = extraction.bgftMetadata;
        if (extraction.success === false) {
            // Generate fallback metadata from filename
            const filename = path.basename(pkgUrl);
            const baseName = filename.replace('.pkg', '').replace(/_/g, ' ').replace(/%20/g, ' ');

            // Generate a fake but valid-looking Content ID and Title ID
            const randomNum = Date.now().toString().slice(-9);
            const contentId = `UP0000-CUSA${randomNum}_00-${baseName.toUpperCase().replace(/ /g, '')}`.substring(0, 36);
            const titleId = `CUSA${randomNum}`.substring(0, 9);

            finalInfo = {
                title: baseName || 'Unknown Game',
                contentId: contentId,
                titleId: titleId,
                type: '1',
                category: 'gd',
                icon: null
            };

            installer.addLog(`⚠️ Using fallback metadata for: ${baseName}`);
        }

        // Merge custom info if provided
        if (customInfo && typeof customInfo === 'object') {
            finalInfo = { ...finalInfo, ...customInfo };
            installer.addLog(`⚙️ Custom metadata applied`);
        }

        // Start callback server
        installer.startCallbackServer(pkgUrl, pkgSize, finalInfo);

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
            serverUrl: `https://${installer.pcIp}`,
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
        installer.stopCallbackServer();
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

// Serve the HTML frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
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
    console.log(`\n🚀 PS4 Direct Installer API Server`);
    console.log(`==============================`);
    console.log(`🌐 Web Interface: https://${installer.pcIp}`);
    console.log(`📞 Callback Port: ${installer.callbackPort}`);
    console.log(`📁 Uploads Dir: ${installer.uploadDir}`);
    console.log(`🔒 CORS Allowed: *`);
    console.log(`Press Ctrl+C to stop`);
    installer.addLog(`API Server started on https://${installer.pcIp}`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🔄 Shutting down gracefully...');

    try {
        installer.stopCallbackServer();

        if (installer.cacheCleanupInterval) {
            clearInterval(installer.cacheCleanupInterval);
        }

        server.close(() => {
            console.log('✅ Server stopped');
            process.exit(0);
        });

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
    installer.stopCallbackServer();
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