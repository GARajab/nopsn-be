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
const FRONTEND_URL = process.env.FRONTEND_URL || '*'; // Set your frontend URL in production

// CORS Configuration - Allow requests from frontend
app.use(cors({
    origin: FRONTEND_URL,
    credentials: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));

// Remove static file serving since frontend is separate
// app.use(express.static('public')); // REMOVED

class DualRequestInstaller {
    constructor() {
        this.pcIp = this.getLocalIp();
        this.callbackPort = 9022;
        this.callbackServer = null;
        this.activeConnections = new Map();
        this.installationLog = [];
        this.extractor = new PKGExtractor();
        this.uploadDir = path.join(__dirname, 'uploads');
        this.currentInstallation = null;

        if (!fs.existsSync(this.uploadDir)) {
            fs.mkdirSync(this.uploadDir, { recursive: true });
        }
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

        // Try multiple placeholder patterns
        const placeholders = [
            Buffer.from([0xB4, 0xB4, 0xB4, 0xB4, 0xB4, 0xB4]),
            Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), // Sometimes zeros
            Buffer.from('YOUR_IP', 'utf-8').slice(0, 6), // Sometimes text placeholder
        ];

        let offset = -1;
        for (const placeholder of placeholders) {
            offset = payload.indexOf(placeholder);
            if (offset !== -1) {
                this.addLog(`✅ Found placeholder at offset 0x${offset.toString(16)}`);
                break;
            }
        }

        if (offset === -1) {
            // Try to find IP:PORT pattern
            const ipPortPattern = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{1,5})/;
            const payloadStr = payload.toString('ascii');
            const match = payloadStr.match(ipPortPattern);

            if (match) {
                offset = payloadStr.indexOf(match[0]);
                this.addLog(`✅ Found IP:PORT pattern at offset ${offset}`);
            } else {
                throw new Error("Could not find IP placeholder in payload.bin");
            }
        }

        const ipBytes = Buffer.from(this.pcIp.split('.').map(Number));
        const portBytes = Buffer.alloc(2);
        portBytes.writeUInt16BE(this.callbackPort, 0);

        ipBytes.copy(payload, offset);
        portBytes.copy(payload, offset + 4);

        this.addLog(`🔧 Patched payload: ${this.pcIp}:${this.callbackPort} at offset 0x${offset.toString(16)}`);

        return payload;
    }

    async extractPkgInfo(pkgUrl) {
        try {
            this.addLog(`🔍 Extracting metadata from: ${pkgUrl}`);

            const result = await this.extractor.extractBGFTMetadata(pkgUrl);

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
        // First 4 bytes: return code for get_pkg_info()
        // 1 = success, -1 = error
        const returnCode = Buffer.alloc(4);
        returnCode.writeInt32LE(0, 0);  // Always return success

        // Then send the actual metadata
        const contentId = pkgInfo.contentId || 'UNKNOWN00000';
        const bgftType = pkgInfo.type || '1';
        const title = pkgInfo.title || 'Package';
        // const hasIcon = pkgInfo.icon && pkgInfo.icon.length > 0;

        const urlData = Buffer.from(pkgUrl + '\0', 'utf-8');
        const nameData = Buffer.from(title + '\0', 'utf-8');
        const idData = Buffer.from(contentId + '\0', 'utf-8');
        const typeData = Buffer.from(bgftType + '\0', 'utf-8');

        const urlLen = Buffer.alloc(4);
        urlLen.writeUInt32LE(urlData.length, 0);

        const nameLen = Buffer.alloc(4);
        nameLen.writeUInt32LE(nameData.length, 0);

        const idLen = Buffer.alloc(4);
        idLen.writeUInt32LE(idData.length, 0);

        const typeLen = Buffer.alloc(4);
        typeLen.writeUInt32LE(typeData.length, 0);

        const sizeBuf = Buffer.alloc(8);
        sizeBuf.writeBigUInt64LE(BigInt(pkgSize), 0);

        let iconData = Buffer.alloc(0);
        const hasIcon = false;

        const iconLen = Buffer.alloc(4);
        iconLen.writeUInt32LE(0, 0);

        const packet = Buffer.concat([
            returnCode,
            urlLen,
            urlData,
            nameLen,
            nameData,
            idLen,
            idData,
            typeLen,
            typeData,
            sizeBuf,
            iconLen
        ]);

        return packet;
    }

    startCallbackServer(pkgUrl, pkgSize, pkgInfo) {
        if (this.callbackServer) {
            this.addLog(`🔄 Restarting callback server...`);
            this.activeConnections.forEach((connection, id) => {
                if (connection.socket && !connection.socket.destroyed) {
                    connection.socket.destroy();
                }
            });
            this.activeConnections.clear();
            this.callbackServer.close();
            this.callbackServer = null;
        }

        const installationId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
        this.currentInstallation = {
            id: installationId,
            pkgUrl: pkgUrl,
            pkgSize: pkgSize,
            pkgInfo: pkgInfo,
            hasSentMetadata: false,
            isStreaming: false,
            isComplete: false
        };

        this.addLog(`📦 Starting installation session: ${installationId}`);

        this.callbackServer = net.createServer((socket) => {
            const connectionId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);

            this.activeConnections.set(connectionId, {
                socket: socket,
                installationId: installationId,
                connectionId: connectionId,
                startTime: Date.now(),
                bytesStreamed: 0
            });

            socket.on('error', (err) => {
                this.addLog(`❌ Socket error (${connectionId}): ${err.message}`);
                this.activeConnections.delete(connectionId);
                if (this.currentInstallation && this.currentInstallation.currentSocket === socket) {
                    this.currentInstallation.currentSocket = null;
                    this.currentInstallation.isStreaming = false;
                }
            });

            socket.on('close', () => {
                const connection = this.activeConnections.get(connectionId);
                const duration = connection ? (Date.now() - connection.startTime) / 1000 : 0;
                const bytes = connection ? connection.bytesStreamed : 0;

                this.addLog(`🔌 Connection closed (${connectionId}): ${(bytes / 1024 / 1024).toFixed(2)}MB in ${duration.toFixed(1)}s`);

                this.activeConnections.delete(connectionId);
                if (this.currentInstallation && this.currentInstallation.currentSocket === socket) {
                    this.currentInstallation.currentSocket = null;
                    this.currentInstallation.isStreaming = false;
                }
            });

            socket.on('timeout', () => {
                this.addLog(`⏰ Socket timeout (${connectionId})`);
                socket.destroy();
            });

            socket.setTimeout(120000);
            this.handlePS4Connection(socket, connectionId, installationId);

        }).listen(this.callbackPort, () => {
            this.addLog(`🎯 Callback server listening on port ${this.callbackPort}`);
            this.addLog(`📡 Installation ID: ${installationId}`);
        });

        this.callbackServer.on('error', (err) => {
            this.addLog(`❌ Callback server error: ${err.message}`);
        });

        setTimeout(() => {
            if (this.callbackServer && this.activeConnections.size === 0) {
                this.addLog(`🔄 Auto-closing idle callback server`);
                this.callbackServer.close();
                this.callbackServer = null;
                this.currentInstallation = null;
            }
        }, 10 * 60 * 1000);
    }

    handlePS4Connection(socket, connectionId, installationId) {
        if (!this.currentInstallation || this.currentInstallation.id !== installationId) {
            this.addLog(`⚠️ Connection ${connectionId} rejected - no active installation`);
            socket.destroy();
            return;
        }

        const installation = this.currentInstallation;

        // Track connection attempts
        if (!installation.connectionAttempts) {
            installation.connectionAttempts = 0;
        }
        if (installation.connectionAttempts > 5) {
            this.addLog(`🛑 Too many retries, aborting installation`);
            socket.destroy();
            return;
        }

        this.addLog(`🔗 Connection #${installation.connectionAttempts} from PS4 (${connectionId})`);

        // First connection: send metadata
        if (installation.connectionAttempts === 1) {
            this.addLog(`📤 Sending metadata on first connection`);
            this.sendMetadata(socket, connectionId, installation);
        }
        // Subsequent connections: the PS4 is retrying - send metadata again
        else {
            this.addLog(`🔄 PS4 reconnected (attempt ${installation.connectionAttempts}) - resending metadata`);
            this.sendMetadata(socket, connectionId, installation);
        }
    }

    sendMetadata(socket, connectionId, installation) {
        try {
            const metadata = this.buildMetadataPacket(
                installation.pkgUrl,
                installation.pkgSize,
                installation.pkgInfo
            );

            this.addLog(`📤 Sending metadata (${metadata.length} bytes)`);

            socket.write(metadata);
            // DO NOT close socket here

        } catch (err) {
            this.addLog(`❌ Metadata error: ${err.message}`);
            socket.destroy();
        }
    }


    streamPackageData(socket, connectionId, installation) {
        // PS4 will download the full file directly from the Oracle Cloud URL
        // We just need to acknowledge and close the connection
        this.addLog(`✅ Connection established - PS4 will download from Oracle Cloud`);
        this.addLog(`📊 Package: ${(installation.pkgSize / 1024 / 1024).toFixed(2)}MB`);
        this.addLog(`🔗 URL: ${installation.pkgUrl}`);

        // Close connection gracefully - PS4 will use the URL from metadata
        // setTimeout(() => {
        //     if (!socket.destroyed) {
        //         socket.end();
        //     }
        //     installation.isComplete = true;
        //     this.addLog(`✅ Installation initiated - PS4 downloading from Oracle Cloud`);

        //     // Auto-cleanup
        //     setTimeout(() => {
        //         if (this.callbackServer) {
        //             this.callbackServer.close();
        //             this.callbackServer = null;
        //             this.currentInstallation = null;
        //             this.addLog(`🔄 Callback server closed`);
        //         }
        //     }, 10000);
        // }, 500);
    }
}

const installer = new DualRequestInstaller();

// --- API Routes ---

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        serverIp: installer.pcIp,
        port: PORT,
        callbackPort: installer.callbackPort,
        uptime: process.uptime(),
        activeConnections: installer.activeConnections.size,
        logsCount: installer.installationLog.length,
        currentInstallation: installer.currentInstallation ? installer.currentInstallation.id : null
    });
});

// Extract PKG metadata only
app.post('/api/extract', async (req, res) => {
    try {
        const { pkgUrl } = req.body;

        if (!pkgUrl) {
            return res.status(400).json({
                success: false,
                error: "No PKG URL provided"
            });
        }

        installer.addLog(`🔍 Metadata extraction requested: ${pkgUrl}`);
        const result = await installer.extractPkgInfo(pkgUrl);

        res.json({
            success: true,
            extraction: result,
            serverIp: installer.pcIp,
            callbackPort: installer.callbackPort
        });

    } catch (error) {
        console.error('Extraction error:', error);
        installer.addLog(`❌ Extraction API error: ${error.message}`);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Prepare installation (main endpoint)
app.post('/api/prepare-install', async (req, res) => {
    try {
        const { pkgUrl, customInfo } = req.body;

        if (!pkgUrl) {
            return res.status(400).json({
                success: false,
                error: "No PKG URL provided"
            });
        }

        installer.addLog(`📍 Installation request: ${pkgUrl}`);

        const extraction = await installer.extractPkgInfo(pkgUrl);

        let pkgSize = 0;
        try {
            pkgSize = await installer.getFileSize(pkgUrl);
            installer.addLog(`📏 Package size: ${(pkgSize / 1024 / 1024).toFixed(2)} MB`);
        } catch (sizeError) {
            installer.addLog(`⚠️ Could not get file size: ${sizeError.message}`);
            pkgSize = 1024 * 1024 * 1024;
        }

        let finalInfo = extraction.bgftMetadata;
        if (customInfo && typeof customInfo === 'object') {
            finalInfo = { ...finalInfo, ...customInfo };
            installer.addLog(`⚙️ Using custom metadata overrides`);
        }

        installer.startCallbackServer(pkgUrl, pkgSize, finalInfo);

        const payload = installer.preparePayload();
        installer.addLog(`📦 Payload prepared: ${payload.length} bytes`);

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
        console.error('Install preparation error:', error);
        installer.addLog(`❌ Install preparation failed: ${error.message}`);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get installation logs
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
            isStreaming: installer.currentInstallation.isStreaming
        } : null
    });
});

// Clear logs
app.delete('/api/logs', (req, res) => {
    const oldCount = installer.installationLog.length;
    installer.installationLog = [];
    installer.addLog(`🧹 Logs cleared (was ${oldCount} entries)`);

    res.json({
        success: true,
        cleared: oldCount,
        message: `Cleared ${oldCount} log entries`
    });
});

// Get server info
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
            isStreaming: installer.currentInstallation.isStreaming
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

// Root route - API info instead of serving HTML
app.get('/', (req, res) => {
    res.json({
        message: '🎮 PS4 Direct Installer API',
        version: '1.0.0',
        status: 'running',
        endpoints: {
            health: 'GET /api/health',
            info: 'GET /api/info',
            logs: 'GET /api/logs',
            clearLogs: 'DELETE /api/logs',
            extract: 'POST /api/extract',
            install: 'POST /api/prepare-install'
        },
        documentation: 'https://github.com/your-repo/ps4-installer'
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: "Endpoint not found",
        availableEndpoints: [
            "GET /",
            "GET /api/health",
            "GET /api/info",
            "GET /api/logs",
            "DELETE /api/logs",
            "POST /api/extract",
            "POST /api/prepare-install"
        ]
    });
});

// Error handler
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    installer.addLog(`🚨 Server error: ${err.message}`);

    res.status(500).json({
        success: false,
        error: "Internal server error",
        message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
    });
});

// Start server
const server = app.listen(PORT, () => {
    console.log(`\n🚀 PS4 Direct Installer API Server`);
    console.log(`==============================`);
    console.log(`🌐 API URL: http://${installer.pcIp}:${PORT}`);
    console.log(`📞 Callback Port: ${installer.callbackPort}`);
    console.log(`📁 Uploads Dir: ${installer.uploadDir}`);
    console.log(`🔒 CORS Allowed: ${FRONTEND_URL}`);
    console.log(`\nPress Ctrl+C to stop\n`);

    installer.addLog(`API Server started on http://${installer.pcIp}:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🔄 Shutting down gracefully...');
    installer.addLog('Server shutting down...');

    installer.activeConnections.forEach((connection, id) => {
        if (connection.socket && !connection.socket.destroyed) {
            connection.socket.destroy();
        }
    });

    if (installer.callbackServer) {
        installer.callbackServer.close();
    }

    server.close(() => {
        console.log('✅ Server stopped');
        process.exit(0);
    });

    setTimeout(() => {
        console.log('⚠️ Forcing shutdown...');
        process.exit(1);
    }, 5000);
});

module.exports = { app, installer };