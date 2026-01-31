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

// Configure CORS to allow all origins
app.use(cors({
    origin: ['https://nopsn-fe.free.nf', 'http://nopsn-fe.free.nf'],
    credentials: true
}));

app.use(express.json({ limit: '10mb' }));

class MultiUserInstaller {
    constructor() {
        this.installationLog = [];
        this.activeInstallations = new Map();
        this.activeConnections = new Map();
        this.callbackServer = null;
        this.uploadDir = path.join(__dirname, 'uploads');
        this.pcIp = this.getDeploymentIp();
        this.callbackPort = 9022;
        this.extractor = new PKGExtractor();
        this.connectionCounter = 0;

        // Create uploads directory if it doesn't exist
        if (!fs.existsSync(this.uploadDir)) {
            fs.mkdirSync(this.uploadDir, { recursive: true });
        }

        this.addLog(`✅ MultiUserInstaller initialized`);
        this.addLog(`🌐 Server IP: ${this.pcIp}`);
        this.addLog(`📞 Callback Port: ${this.callbackPort}`);
    }

    getDeploymentIp() {
        // For Render.com, extract IP from URL
        if (process.env.RENDER_EXTERNAL_URL) {
            const url = process.env.RENDER_EXTERNAL_URL;
            const hostname = url.replace('https://', '').replace('http://', '').split(':')[0];
            this.addLog(`🌐 Using Render hostname: ${hostname}`);
            return hostname;
        }

        // Try to get public IP
        if (process.env.PUBLIC_IP) {
            return process.env.PUBLIC_IP;
        }

        if (process.env.SERVER_DOMAIN) {
            return process.env.SERVER_DOMAIN;
        }

        // For local testing
        return this.getLocalIp();
    }

    getLocalIp() {
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    return iface.address;
                }
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

    preparePayload(installationId) {
        const payloadPath = path.join(__dirname, 'payload.bin');
        if (!fs.existsSync(payloadPath)) {
            throw new Error("payload.bin missing from server folder");
        }

        const payload = fs.readFileSync(payloadPath);
        const placeholder = Buffer.from([0xB4, 0xB4, 0xB4, 0xB4, 0xB4, 0xB4]);
        const offset = payload.indexOf(placeholder);

        if (offset === -1) throw new Error("Placeholder 0xB4... not found in payload.bin");

        // Convert IP to bytes - VERY IMPORTANT: Use IP for TCP connection, not HTTPS URL
        const ipToUse = "74.220.49.1"; // Use Render's actual IP
        this.addLog(`🔧 Using IP for payload: ${ipToUse}`);

        const ipBytes = Buffer.from(ipToUse.split('.').map(Number));
        const portBytes = Buffer.alloc(2);
        portBytes.writeUInt16BE(this.callbackPort, 0);

        ipBytes.copy(payload, offset);
        portBytes.copy(payload, offset + 4);

        // Embed installation ID
        const idData = Buffer.from(`${installationId}\0`, 'utf-8');
        const idMaxLength = 64;
        const idLength = Math.min(idData.length, idMaxLength);

        let embedOffset = offset + 6;
        while (embedOffset < payload.length && payload[embedOffset] !== 0x00 && embedOffset < offset + 100) {
            embedOffset++;
        }

        if (embedOffset + idLength <= payload.length) {
            idData.copy(payload, embedOffset, 0, idLength);
            this.addLog(`📋 Embedded installation ID: ${installationId}`);
        }

        return payload;
    }

    async extractPkgInfo(pkgUrl) {
        try {
            this.addLog(`🔍 Extracting metadata from: ${pkgUrl}`);
            const result = await this.extractor.extractBGFTMetadata(pkgUrl);

            let iconBase64 = null;
            if (result.icon && result.icon.data) {
                iconBase64 = result.icon.data.toString('base64');
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
                fullInfo: result.basic
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
                headers: { 'User-Agent': 'PS4-Installer/1.0' }
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
                        this.getFileSize(redirectUrl).then(resolve).catch(reject);
                    } else {
                        reject(new Error(`HTTP ${res.statusCode}: No redirect location`));
                    }
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
                }
            });

            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Timeout connecting to server'));
            });
            req.end();
        });
    }

    buildMetadataPacket(pkgUrl, pkgSize, pkgInfo) {
        // IMPORTANT: Use HTTP URL for the PS4, not HTTPS
        let pkgUrlForPS4 = pkgUrl;

        // If PKG URL is HTTPS, we need to serve it via HTTP proxy
        if (pkgUrl.toLowerCase().startsWith('https://')) {
            // For HTTPS URLs, we'll need to proxy them through our HTTP server
            // For now, we'll try to use HTTP if available
            pkgUrlForPS4 = pkgUrl.replace('https://', 'http://');
            this.addLog(`⚠️ Converting HTTPS URL to HTTP for PS4: ${pkgUrlForPS4}`);
        }

        const urlData = Buffer.from(pkgUrlForPS4, 'utf-8');
        const nameData = Buffer.from(pkgInfo.title || 'Game', 'utf-8');
        const contentIdData = Buffer.from(pkgInfo.contentId || 'UP0000-CUSA00000_00-GAME0000000000', 'utf-8');
        const titleIdData = Buffer.from(pkgInfo.titleId || 'CUSA00000', 'utf-8');

        let totalSize = 16;
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

        // File size
        packet.writeBigUInt64LE(BigInt(pkgSize), offset);

        return packet;
    }

    startCallbackServer() {
        if (!this.callbackServer) {
            this.callbackServer = net.createServer((socket) => {
                const connectionId = `conn_${Date.now()}_${++this.connectionCounter}`;

                // Store connection
                const connection = {
                    socket: socket,
                    connectionId: connectionId,
                    startTime: Date.now(),
                    installationId: null,
                    lastActivity: Date.now(),
                    bytesStreamed: 0,
                    isMetadataSent: false
                };
                this.activeConnections.set(connectionId, connection);

                socket.setTimeout(30000);

                socket.on('timeout', () => {
                    this.addLog(`⏰ Socket timeout (${connectionId})`);
                    socket.destroy();
                });

                socket.on('error', (err) => {
                    this.addLog(`❌ Socket error (${connectionId}): ${err.message}`);
                    this.activeConnections.delete(connectionId);
                });

                socket.on('close', () => {
                    const conn = this.activeConnections.get(connectionId);
                    if (conn) {
                        const duration = (Date.now() - conn.startTime) / 1000;
                        this.addLog(`🔌 Closed (${connectionId}): ${duration.toFixed(1)}s, ${(conn.bytesStreamed / 1024 / 1024).toFixed(2)}MB`);
                    }
                    this.activeConnections.delete(connectionId);
                });

                // Handle the connection
                this.handleConnection(socket, connectionId);

            }).listen(this.callbackPort, () => {
                this.addLog(`🎯 Callback server listening on TCP port ${this.callbackPort} (HTTP protocol)`);
            });

            this.callbackServer.on('error', (err) => {
                this.addLog(`❌ Callback server error: ${err.message}`);
            });

            // Cleanup old installations every minute
            setInterval(() => {
                const now = Date.now();
                for (const [installationId, installation] of this.activeInstallations.entries()) {
                    if (now - installation.createdAt > 15 * 60 * 1000) {
                        this.addLog(`🧹 Cleaning up old installation: ${installationId}`);
                        this.activeInstallations.delete(installationId);
                    }
                }
            }, 60000);
        }

        return this.callbackServer;
    }

    handleConnection(socket, connectionId) {
        const connection = this.activeConnections.get(connectionId);
        if (!connection) return;

        let buffer = Buffer.alloc(0);

        socket.on('data', (data) => {
            try {
                connection.lastActivity = Date.now();
                buffer = Buffer.concat([buffer, data]);

                // Try to parse installation ID from data
                const dataStr = buffer.toString('utf-8', 0, Math.min(buffer.length, 100));

                // Look for installation ID pattern
                let installationId = null;
                const idMatch = dataStr.match(/inst_[a-z0-9_]+/i);
                if (idMatch) {
                    installationId = idMatch[0];
                }

                if (installationId) {
                    this.addLog(`📡 Connection ${connectionId} → Installation: ${installationId}`);
                    connection.installationId = installationId;
                    this.handlePS4Connection(socket, connectionId, installationId);
                } else if (!connection.isMetadataSent) {
                    // First connection without ID - find installation waiting for metadata
                    for (const [id, inst] of this.activeInstallations.entries()) {
                        if (!inst.hasSentMetadata) {
                            installationId = id;
                            break;
                        }
                    }

                    if (installationId) {
                        this.addLog(`📡 Connection ${connectionId} → Installation (auto): ${installationId}`);
                        connection.installationId = installationId;
                        this.handlePS4Connection(socket, connectionId, installationId);
                    } else {
                        // No installation found
                        this.addLog(`⚠️ No active installation found for ${connectionId}`);
                        socket.end();
                    }
                }
            } catch (err) {
                this.addLog(`❌ Connection handler error: ${err.message}`);
                socket.destroy();
            }
        });
    }

    createInstallation(pkgUrl, pkgSize, pkgInfo) {
        const installationId = `inst_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;

        const installation = {
            id: installationId,
            pkgUrl: pkgUrl,
            pkgSize: pkgSize,
            pkgInfo: pkgInfo,
            hasSentMetadata: false,
            isStreaming: false,
            createdAt: Date.now(),
            connections: new Set(),
            dataStreamStarted: false,
            httpStream: null
        };

        this.activeInstallations.set(installationId, installation);
        this.addLog(`📦 Created installation: ${installationId} for "${pkgInfo.title}"`);

        // Ensure callback server is running
        this.startCallbackServer();

        return installationId;
    }

    handlePS4Connection(socket, connectionId, installationId) {
        const connection = this.activeConnections.get(connectionId);
        const installation = this.activeInstallations.get(installationId);

        if (!installation) {
            this.addLog(`⚠️ Installation ${installationId} not found for ${connectionId}`);
            socket.end();
            return;
        }

        if (connection) {
            connection.lastActivity = Date.now();
            connection.installationId = installationId;
        }

        // Add connection to installation
        installation.connections.add(connectionId);

        if (!installation.hasSentMetadata) {
            // First connection - send metadata
            this.addLog(`📤 Sending metadata for "${installation.pkgInfo.title}" to ${connectionId}`);
            this.sendMetadata(socket, connectionId, installation);
            installation.hasSentMetadata = true;
            installation.currentSocket = socket;
            connection.isMetadataSent = true;
        } else if (!installation.isStreaming) {
            // Second connection - start streaming package data
            this.addLog(`✅ PS4 ${installationId} ready to download "${installation.pkgInfo.title}"`);
            installation.isStreaming = true;
            installation.currentSocket = socket;

            // Start streaming the package
            this.startPackageStream(socket, connectionId, installation);
        } else {
            // Already streaming
            this.addLog(`ℹ️ Installation ${installationId} already streaming`);
            socket.end();
        }
    }

    sendMetadata(socket, connectionId, installation) {
        try {
            const metadata = this.buildMetadataPacket(
                installation.pkgUrl,
                installation.pkgSize,
                installation.pkgInfo
            );

            this.addLog(`📤 Sending ${metadata.length} bytes to ${connectionId}`);
            this.addLog(`   Game: ${installation.pkgInfo.title}`);
            this.addLog(`   Content ID: ${installation.pkgInfo.contentId}`);
            this.addLog(`   Size: ${(installation.pkgSize / 1024 / 1024).toFixed(2)} MB`);

            socket.write(metadata, (err) => {
                if (err) {
                    this.addLog(`❌ Failed to send metadata to ${connectionId}: ${err.message}`);
                    socket.destroy();
                } else {
                    this.addLog(`✅ Metadata sent to ${connectionId}`);
                    this.addLog(`🔄 Waiting for PS4 to reconnect for download...`);

                    // PS4 will disconnect after receiving metadata
                    // We'll wait for it to reconnect for the actual download
                }
            });
        } catch (err) {
            this.addLog(`❌ Metadata error: ${err.message}`);
            socket.destroy();
        }
    }

    startPackageStream(socket, connectionId, installation) {
        this.addLog(`🚀 Starting package stream for "${installation.pkgInfo.title}"`);

        const parsedUrl = new URL(installation.pkgUrl);
        const protocol = parsedUrl.protocol === 'https:' ? https : http;

        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port,
            path: parsedUrl.pathname + parsedUrl.search,
            headers: {
                'User-Agent': 'PS4-Installer/1.0',
                'Range': 'bytes=0-' // Stream from beginning
            }
        };

        let bytesStreamed = 0;
        let startTime = Date.now();
        let lastLogTime = startTime;

        const httpReq = protocol.get(options, (httpRes) => {
            if (httpRes.statusCode !== 200 && httpRes.statusCode !== 206) {
                this.addLog(`❌ HTTP ${httpRes.statusCode}: ${httpRes.statusMessage}`);
                socket.destroy();
                return;
            }

            const contentLength = parseInt(httpRes.headers['content-length'] || '0', 10);
            this.addLog(`📥 Streaming ${(contentLength / 1024 / 1024).toFixed(2)}MB from ${installation.pkgUrl}`);

            installation.httpStream = httpRes;

            // Stream data to PS4
            httpRes.on('data', (chunk) => {
                bytesStreamed += chunk.length;

                // Update connection bytes streamed
                const connection = this.activeConnections.get(connectionId);
                if (connection) {
                    connection.bytesStreamed = bytesStreamed;
                }

                // Stream to PS4
                const canWrite = socket.write(chunk);
                if (!canWrite) {
                    // Pause HTTP stream if PS4 buffer is full
                    httpRes.pause();
                    socket.once('drain', () => {
                        httpRes.resume();
                    });
                }

                // Log progress every 5 seconds
                const now = Date.now();
                if (now - lastLogTime > 5000) {
                    const elapsed = (now - startTime) / 1000;
                    const speed = bytesStreamed / elapsed / 1024 / 1024;
                    const percent = contentLength > 0 ? (bytesStreamed / contentLength * 100).toFixed(1) : '?';

                    this.addLog(`📊 Download: ${(bytesStreamed / 1024 / 1024).toFixed(2)}MB (${percent}%) @ ${speed.toFixed(2)}MB/s`);
                    lastLogTime = now;
                }
            });

            httpRes.on('end', () => {
                this.addLog(`✅ Stream complete! ${(bytesStreamed / 1024 / 1024).toFixed(2)}MB in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

                // Wait a bit before closing socket
                setTimeout(() => {
                    if (!socket.destroyed) {
                        socket.end();
                    }
                }, 2000);

                // Clean up installation after completion
                setTimeout(() => {
                    this.cleanupInstallation(installationId);
                }, 5000);
            });

            httpRes.on('error', (err) => {
                this.addLog(`❌ HTTP stream error: ${err.message}`);
                socket.destroy();
            });
        });

        httpReq.on('error', (err) => {
            this.addLog(`❌ HTTP request error: ${err.message}`);
            socket.destroy();
        });

        installation.httpRequest = httpReq;

        // Handle socket close/error
        socket.on('error', (err) => {
            this.addLog(`❌ Socket error during stream: ${err.message}`);
            if (httpReq && !httpReq.destroyed) {
                httpReq.destroy();
            }
        });

        socket.on('close', () => {
            this.addLog(`🔌 PS4 connection closed during stream`);
            if (httpReq && !httpReq.destroyed) {
                httpReq.destroy();
            }
        });
    }

    getInstallationStatus(installationId) {
        const installation = this.activeInstallations.get(installationId);
        if (!installation) return null;

        return {
            id: installation.id,
            title: installation.pkgInfo.title,
            hasSentMetadata: installation.hasSentMetadata,
            isStreaming: installation.isStreaming,
            connections: Array.from(installation.connections),
            age: Date.now() - installation.createdAt
        };
    }

    cleanupInstallation(installationId) {
        if (this.activeInstallations.has(installationId)) {
            const installation = this.activeInstallations.get(installationId);

            // Close all connections
            for (const connectionId of installation.connections) {
                const connection = this.activeConnections.get(connectionId);
                if (connection && connection.socket && !connection.socket.destroyed) {
                    connection.socket.destroy();
                }
                this.activeConnections.delete(connectionId);
            }

            // Close HTTP stream if active
            if (installation.httpRequest && !installation.httpRequest.destroyed) {
                installation.httpRequest.destroy();
            }

            this.activeInstallations.delete(installationId);
            this.addLog(`🧹 Cleaned up installation: ${installationId}`);
            return true;
        }
        return false;
    }
}

const installer = new MultiUserInstaller();

// API Routes
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        server: 'PS4 Multi-User Installer',
        ip: installer.pcIp,
        callbackPort: installer.callbackPort,
        activeInstallations: installer.activeInstallations.size,
        activeConnections: installer.activeConnections.size,
        uptime: process.uptime()
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

        installer.addLog(`📍 New installation request: ${pkgUrl}`);

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

        // Use fallback metadata if extraction failed
        let finalInfo = extraction.bgftMetadata;
        if (extraction.success === false) {
            const filename = path.basename(pkgUrl);
            const baseName = filename.replace('.pkg', '').replace(/_/g, ' ').replace(/%20/g, ' ');
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

        // Merge custom info
        if (customInfo && typeof customInfo === 'object') {
            finalInfo = { ...finalInfo, ...customInfo };
        }

        // Create installation
        const installationId = installer.createInstallation(pkgUrl, pkgSize, finalInfo);

        // Prepare payload with installation ID embedded
        const payload = installer.preparePayload(installationId);
        installer.addLog(`📦 Payload ready for ${installationId}: ${payload.length} bytes`);

        res.json({
            success: true,
            installationId: installationId,
            payload: payload.toString('hex'),
            payloadSize: payload.length,
            packageSize: pkgSize,
            packageInfo: finalInfo,
            extraction: extraction,
            serverIp: installer.pcIp,
            callbackPort: installer.callbackPort,
            serverUrl: `http://${installer.pcIp}:${PORT}`,
            note: "Send this payload to your PS4. Each installation has a unique ID."
        });
    } catch (error) {
        installer.addLog(`❌ Install preparation failed: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Serve static HTML frontend
app.use(express.static('public'));

app.get('/api/installation/:id', (req, res) => {
    const status = installer.getInstallationStatus(req.params.id);
    if (status) {
        res.json({ success: true, status: status });
    } else {
        res.status(404).json({ success: false, error: "Installation not found" });
    }
});

app.delete('/api/installation/:id', (req, res) => {
    const cleaned = installer.cleanupInstallation(req.params.id);
    res.json({ success: cleaned, message: cleaned ? "Installation cleaned up" : "Installation not found" });
});

app.get('/api/installations', (req, res) => {
    const installations = [];
    for (const [id, inst] of installer.activeInstallations.entries()) {
        installations.push({
            id: id,
            title: inst.pkgInfo.title,
            hasSentMetadata: inst.hasSentMetadata,
            isStreaming: inst.isStreaming,
            connections: inst.connections.size,
            age: Date.now() - inst.createdAt
        });
    }
    res.json({
        success: true,
        count: installations.length,
        installations: installations
    });
});

app.get('/api/logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const logs = installer.installationLog.slice(-limit);
    res.json({
        logs: logs,
        total: installer.installationLog.length,
        limit: limit,
        activeInstallations: installer.activeInstallations.size,
        activeConnections: installer.activeConnections.size
    });
});

app.delete('/api/logs', (req, res) => {
    const oldCount = installer.installationLog.length;
    installer.installationLog = [];
    installer.addLog(`🧹 Logs cleared (${oldCount} entries)`);
    res.json({ success: true, cleared: oldCount });
});

app.get('/api/stats', (req, res) => {
    res.json({
        server: {
            ip: installer.pcIp,
            port: PORT,
            callbackPort: installer.callbackPort,
            payloadExists: fs.existsSync(path.join(__dirname, 'payload.bin'))
        },
        stats: {
            activeInstallations: installer.activeInstallations.size,
            activeConnections: installer.activeConnections.size,
            totalLogs: installer.installationLog.length,
            callbackServer: installer.callbackServer ? 'Running' : 'Stopped'
        }
    });
});

// Default route
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>PS4 Multi-User Direct Installer</title>
            <style>
                body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #1a1a1a; color: white; }
                .container { max-width: 800px; margin: 0 auto; background: #2a2a2a; padding: 30px; border-radius: 10px; }
                h1 { color: #0070ff; }
                .info { background: #333; padding: 20px; border-radius: 5px; margin: 20px 0; text-align: left; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🎮 PS4 Multi-User Direct Installer</h1>
                <p>Server is running on <strong>http://${installer.pcIp}:${PORT}</strong></p>
                <p>Callback server on <strong>TCP port ${installer.callbackPort}</strong></p>
                
                <div class="info">
                    <h3>📡 Important Notes:</h3>
                    <p>• The PS4 payload uses <strong>TCP/HTTP only</strong> (no HTTPS)</p>
                    <p>• Backend IP embedded in payload: <strong>${installer.pcIp}:${installer.callbackPort}</strong></p>
                    <p>• Use the frontend at: <strong>http://nopsn-fe.free.nf</strong></p>
                </div>
                
                <div class="info">
                    <h3>📊 Server Status:</h3>
                    <p>• Active Installations: ${installer.activeInstallations.size}</p>
                    <p>• Active Connections: ${installer.activeConnections.size}</p>
                    <p>• Callback Server: ${installer.callbackServer ? '✅ Running' : '❌ Stopped'}</p>
                </div>
            </div>
        </body>
        </html>
    `);
});

// Error handling
app.use((err, req, res, next) => {
    installer.addLog(`❌ Server error: ${err.message}`);
    console.error(err.stack);
    res.status(500).json({
        success: false,
        error: 'Internal server error'
    });
});

app.use((req, res) => {
    res.status(404).json({ success: false, error: "Endpoint not found" });
});

// Start server
const server = app.listen(PORT, () => {
    console.log(`\n🚀 PS4 Multi-User Installer API Server`);
    console.log(`======================================`);
    console.log(`🌐 Web Interface: http://${installer.pcIp}:${PORT}`);
    console.log(`📞 Callback Server: TCP port ${installer.callbackPort} (HTTP protocol)`);
    console.log(`👥 Supports: Multiple concurrent users`);
    console.log(`🔒 CORS: All origins allowed`);
    console.log(`\n📝 IMPORTANT: PS4 payload uses HTTP only, not HTTPS!`);
    console.log(`📝 Backend IP in payload: ${installer.pcIp}:${installer.callbackPort}`);
    console.log(`\nPress Ctrl+C to stop\n`);

    installer.addLog(`Server started on http://${installer.pcIp}:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🔄 Shutting down gracefully...');
    installer.addLog('Server shutting down...');

    // Close all connections
    for (const connection of installer.activeConnections.values()) {
        if (connection.socket && !connection.socket.destroyed) {
            connection.socket.destroy();
        }
    }

    // Close callback server
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

process.on('SIGTERM', () => {
    console.log('\n🔻 Received SIGTERM, shutting down...');
    if (installer.callbackServer) installer.callbackServer.close();
    server.close(() => process.exit(0));
});

module.exports = { app, installer };