const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const url = require('url');

class PKGExtractor {
    constructor() {
        console.log("🔍 PKG Extractor v1.0");
        console.log("=====================\n");
    }

    async extractBGFTMetadata(pkgPathOrUrl) {
        console.log(`📦 Processing: ${pkgPathOrUrl}`);

        let buffer;
        let isUrl = false;

        // Check if input is URL or local file
        if (pkgPathOrUrl.startsWith('http://') || pkgPathOrUrl.startsWith('https://')) {
            console.log("🌐 Detected URL - downloading first 200 MB...");
            buffer = await this.downloadPartialFile(pkgPathOrUrl, 2 * 1024 * 1024);
            isUrl = true;
        } else {
            console.log("📁 Detected local file...");
            if (!fs.existsSync(pkgPathOrUrl)) {
                throw new Error(`File not found: ${pkgPathOrUrl}`);
            }
            // Read first 2MB for extraction
            buffer = fs.readFileSync(pkgPathOrUrl, { length: 2 * 1024 * 1024 });
        }

        console.log(`📊 File size read: ${(buffer.length / 1024 / 1024).toFixed(2)} MB\n`);

        // Extract all metadata
        const basicInfo = this.extractBasicPkgInfoFromBuffer(buffer, pkgPathOrUrl);
        const iconData = this.extractIconFromBuffer(buffer);

        // Build BGFT metadata object
        const bgftMetadata = {
            title: basicInfo.title,
            contentId: basicInfo.contentId,
            titleId: basicInfo.titleId,
            category: basicInfo.category,
            type: this.getBGFTType(basicInfo.category),
            hasIcon: !!iconData,
            iconSize: iconData ? iconData.size : 0,
            iconType: iconData ? iconData.type : null,
            source: isUrl ? 'URL' : 'Local File',
            filename: path.basename(pkgPathOrUrl)
        };

        return {
            bgft: bgftMetadata,
            basic: basicInfo,
            icon: iconData
        };
    }

    async downloadPartialFile(fileUrl, maxBytes) {
        return new Promise((resolve, reject) => {
            const parsedUrl = new URL(fileUrl);
            const protocol = parsedUrl.protocol === 'https:' ? https : http;

            const req = protocol.get(fileUrl, (res) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
                    return;
                }

                let buffer = Buffer.alloc(0);
                let bytesReceived = 0;

                res.on('data', (chunk) => {
                    buffer = Buffer.concat([buffer, chunk]);
                    bytesReceived += chunk.length;

                    // Stop when we have enough data
                    if (bytesReceived >= maxBytes) {
                        req.destroy();
                        console.log(`✅ Downloaded ${(bytesReceived / 1024 / 1024).toFixed(2)} MB for extraction`);
                        resolve(buffer);
                    }
                });

                res.on('end', () => {
                    if (bytesReceived > 0) {
                        console.log(`✅ Downloaded complete file ${(bytesReceived / 1024 / 1024).toFixed(2)} MB`);
                        resolve(buffer);
                    } else {
                        reject(new Error('No data received'));
                    }
                });

                res.on('error', (err) => {
                    reject(err);
                });
            });

            req.on('error', (err) => {
                reject(err);
            });

            req.setTimeout(15000, () => {
                req.destroy();
                reject(new Error('Download timeout'));
            });
        });
    }

    extractBasicPkgInfoFromBuffer(buffer, sourcePath) {
        console.log("🔧 Extracting basic PKG info...");

        const info = {
            title: '',
            category: 'gd',
            contentId: 'UNKNOWN',
            titleId: 'UNKNOWN'
        };

        // Look for param.sfo
        for (let i = 0; i < buffer.length - 4; i++) {
            if (buffer[i] === 0x00 && buffer[i + 1] === 0x50 &&
                buffer[i + 2] === 0x53 && buffer[i + 3] === 0x46) {

                console.log(`✅ Found param.sfo at offset: 0x${i.toString(16).toUpperCase()}`);

                const sfoOffset = i;
                let offset = sfoOffset + 8;

                const keyTableStart = buffer.readUInt32LE(offset); offset += 4;
                const dataTableStart = buffer.readUInt32LE(offset); offset += 4;
                const entryCount = buffer.readUInt32LE(offset); offset += 4;

                console.log(`   Key table: 0x${keyTableStart.toString(16).toUpperCase()}`);
                console.log(`   Data table: 0x${dataTableStart.toString(16).toUpperCase()}`);
                console.log(`   Entries: ${entryCount}\n`);

                for (let j = 0; j < entryCount; j++) {
                    const entryOffset = sfoOffset + 20 + (j * 16);
                    if (entryOffset + 16 > buffer.length) break;

                    const keyOffset = buffer.readUInt16LE(entryOffset);
                    const dataFormat = buffer.readUInt16LE(entryOffset + 2);
                    const dataLength = buffer.readUInt32LE(entryOffset + 4);
                    const dataOffset = buffer.readUInt32LE(entryOffset + 12);

                    // Read key name
                    const keyPos = sfoOffset + keyTableStart + keyOffset;
                    let keyName = "";
                    for (let k = 0; k < 50; k++) {
                        if (keyPos + k >= buffer.length) break;
                        const charCode = buffer[keyPos + k];
                        if (charCode === 0) break;
                        keyName += String.fromCharCode(charCode);
                    }

                    // Read data value
                    if (dataFormat === 0x0204 && dataLength > 0 && dataLength < 1000) {
                        const dataPos = sfoOffset + dataTableStart + dataOffset;
                        let value = "";

                        for (let k = 0; k < dataLength; k++) {
                            if (dataPos + k >= buffer.length) break;
                            const charCode = buffer[dataPos + k];
                            if (charCode === 0) break;
                            value += String.fromCharCode(charCode);
                        }

                        value = value.trim();

                        switch (keyName) {
                            case "TITLE":
                                info.title = value;
                                console.log(`   📝 TITLE: ${value}`);
                                break;
                            case "CONTENT_ID":
                                info.contentId = value;
                                console.log(`   🆔 CONTENT_ID: ${value}`);
                                break;
                            case "TITLE_ID":
                                info.titleId = value;
                                console.log(`   🎮 TITLE_ID: ${value}`);
                                break;
                            case "CATEGORY":
                                info.category = value.toLowerCase();
                                console.log(`   📂 CATEGORY: ${value}`);
                                break;
                        }
                    }
                }
                break;
            }
        }

        // If no title found, use filename
        if (!info.title) {
            info.title = path.basename(sourcePath).replace('.pkg', '').replace(/_/g, ' ');
            console.log(`   📝 Using filename as title: ${info.title}`);
        }

        console.log(); // Empty line for readability
        return info;
    }

    extractIconFromBuffer(buffer) {
        console.log("🖼️ Searching for icon...");

        const fileSize = buffer.length;

        // First try PKG entry table method
        try {
            // Check PKG header magic
            if (buffer.length >= 4) {
                const magic = buffer.readUInt32BE(0);
                if (magic === 0x7F434E54) {
                    console.log("   ✅ Valid PKG header found");

                    // PKG Header offsets
                    const entryTableOffset = buffer.readUInt32BE(0x58);
                    const entryCount = buffer.readUInt32BE(0x5C);

                    console.log(`   Entry table: 0x${entryTableOffset.toString(16).toUpperCase()}`);
                    console.log(`   Entry count: ${entryCount}`);

                    // Parse entry table if we have enough data
                    if (entryTableOffset < buffer.length - 32) {
                        let offset = entryTableOffset;

                        for (let i = 0; i < entryCount; i++) {
                            if (offset + 32 > buffer.length) break;

                            const id = buffer.readUInt32BE(offset);
                            const dataSize = buffer.readUInt32BE(offset + 4);
                            const dataOffset = buffer.readUInt32BE(offset + 8);

                            if (id === 0x12 || id === 0x13) { // ICON0_PNG or ICON0_JPG
                                const iconType = id === 0x12 ? 'png' : 'jpeg';
                                console.log(`   ✅ Found ICON0 (${iconType.toUpperCase()}) at offset: 0x${dataOffset.toString(16).toUpperCase()}`);

                                if (dataOffset + dataSize <= buffer.length) {
                                    const iconBuffer = buffer.slice(dataOffset, dataOffset + dataSize);
                                    console.log(`   Icon size: ${(dataSize / 1024).toFixed(2)} KB`);
                                    return {
                                        data: iconBuffer,
                                        size: dataSize,
                                        type: iconType
                                    };
                                } else {
                                    console.log(`   ⚠️ Icon data exceeds buffer size`);
                                }
                            }

                            offset += 32;
                        }
                    }
                }
            }
        } catch (err) {
            console.log(`   ⚠️ PKG entry table scan failed: ${err.message}`);
        }

        // Fallback: Scan for PNG/JPEG images
        console.log("   🔍 Scanning for embedded images...");
        const imageResult = this.scanForImage(buffer, fileSize);
        if (imageResult) {
            console.log(`   ✅ Found ${imageResult.type.toUpperCase()} image (${(imageResult.size / 1024).toFixed(2)} KB)`);
            return imageResult;
        }

        console.log("   ❌ No icon found");
        return null;
    }

    scanForImage(pkgBuffer, fileSize) {
        // Look for PNG or JPEG in first 2MB
        const searchLimit = Math.min(fileSize, 2 * 1024 * 1024);

        for (let i = 0x1000; i < searchLimit - 8; i++) {
            // PNG
            if (pkgBuffer[i] === 0x89 && pkgBuffer[i + 1] === 0x50 &&
                pkgBuffer[i + 2] === 0x4E && pkgBuffer[i + 3] === 0x47) {

                console.log(`   Found PNG signature at 0x${i.toString(16).toUpperCase()}`);

                let pngEnd = i;
                for (let j = i + 8; j < Math.min(i + 1024 * 1024, fileSize - 8); j++) {
                    if (pkgBuffer[j] === 0x49 && pkgBuffer[j + 1] === 0x45 &&
                        pkgBuffer[j + 2] === 0x4E && pkgBuffer[j + 3] === 0x44) {
                        pngEnd = j + 8;
                        break;
                    }
                }

                const pngSize = pngEnd - i;
                if (pngSize > 100 && pngSize < 1024 * 1024) {
                    return {
                        data: pkgBuffer.slice(i, pngEnd),
                        size: pngSize,
                        type: 'png'
                    };
                }
            }

            // JPEG
            if (pkgBuffer[i] === 0xFF && pkgBuffer[i + 1] === 0xD8 && pkgBuffer[i + 2] === 0xFF) {
                console.log(`   Found JPEG signature at 0x${i.toString(16).toUpperCase()}`);

                let jpegEnd = i;
                for (let j = i + 2; j < Math.min(i + 1024 * 1024, fileSize - 2); j++) {
                    if (pkgBuffer[j] === 0xFF && pkgBuffer[j + 1] === 0xD9) {
                        jpegEnd = j + 2;
                        break;
                    }
                }

                const jpegSize = jpegEnd - i;
                if (jpegSize > 100 && jpegSize < 1024 * 1024) {
                    return {
                        data: pkgBuffer.slice(i, jpegEnd),
                        size: jpegSize,
                        type: 'jpeg'
                    };
                }
            }
        }

        return null;
    }

    getBGFTType(category) {
        // Map PS3/PS4 category to BGFT type
        const categoryMap = {
            getBGFTType(category) {
                // Map PS3/PS4 category to BGFT package_type
                const categoryMap = {
                    'gd': 'PS4GD',        // PS4 Game Digital
                    'gda': 'PS4AC',       // PS4 Application Content (System App)
                    'gdo': 'PS4GD',       // PS2 Classic (treated as PS4 Game)
                    'gp': 'PS4GP',        // PS4 Game Patch
                    'ac': 'PS4AC',        // PS4 Additional Content
                    'theme': 'PS4TH',     // PS4 Theme
                    'avatar': 'PS4AV',    // PS4 Avatar
                    'sd': 'PS4SD',        // PS4 Save Data
                    'demo': 'PS4GD',      // PS4 Demo (treated as Game)
                    'gc': 'PS4GD',        // Game Content
                    'bd': 'PS4BD',        // Blu-ray Disc
                    'gdc': 'PS4AC',       // Non-Game Big Application
                    'gdd': 'PS4AC',       // BG Application
                    'gde': 'PS4AC',       // Non-Game Mini App
                    'gdk': 'PS4AC',       // Video Service Web App
                    'gdl': 'PS4AC',       // PS Cloud Beta App
                    'gpc': 'PS4GP',       // Non-Game Big App Patch
                    'gpd': 'PS4GP',       // BG Application Patch
                    'gpe': 'PS4GP',       // Non-Game Mini App Patch
                    'gpk': 'PS4GP',       // Video Service Web App Patch
                    'gpl': 'PS4GP'        // PS Cloud Beta App Patch
                };

                return categoryMap[category.toLowerCase()] || 'PS4GD'; // Default to PS4 Game Digital
            }
        };

        return categoryMap[category.toLowerCase()] || '1';
    }

    async saveIconToFile(iconData, outputPath) {
        if (!iconData) {
            console.log("❌ No icon data to save");
            return false;
        }

        try {
            const extension = iconData.type === 'png' ? '.png' : '.jpg';
            const fullPath = outputPath.endsWith(extension) ? outputPath : outputPath + extension;

            fs.writeFileSync(fullPath, iconData.data);
            console.log(`💾 Icon saved to: ${fullPath} (${(iconData.size / 1024).toFixed(2)} KB)`);
            return true;
        } catch (err) {
            console.log(`❌ Failed to save icon: ${err.message}`);
            return false;
        }
    }
}

// Main execution
async function main() {
    const extractor = new PKGExtractor();

    // Check command line arguments
    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.log("Usage: node extract.js <pkg-file-or-url> [output-icon-path]");
        console.log("\nExamples:");
        console.log("  node extract.js game.pkg");
        console.log("  node extract.js https://example.com/game.pkg");
        console.log("  node extract.js game.pkg ./icon");
        console.log("\nIf an icon is found, it will be saved to the specified path.");
        return;
    }

    const pkgPathOrUrl = args[0];
    const iconOutputPath = args[1] || null;

    try {
        const result = await extractor.extractBGFTMetadata(pkgPathOrUrl);

        console.log("\n" + "=".repeat(50));
        console.log("📊 EXTRACTION RESULTS");
        console.log("=".repeat(50));

        console.log("\n🎯 BGFT METADATA (for installation):");
        console.log("   Title:", result.bgft.title);
        console.log("   Content ID:", result.bgft.contentId);
        console.log("   Title ID:", result.bgft.titleId);
        console.log("   Category:", result.bgft.category);
        console.log("   BGFT Type:", result.bgft.type);
        console.log("   Has Icon:", result.bgft.hasIcon ? "✅ Yes" : "❌ No");
        if (result.bgft.hasIcon) {
            console.log("   Icon Size:", `${(result.bgft.iconSize / 1024).toFixed(2)} KB`);
            console.log("   Icon Type:", result.bgft.iconType?.toUpperCase());
        }

        console.log("\n📄 BASIC INFO:");
        console.log("   Source:", result.bgft.source);
        console.log("   Filename:", result.bgft.filename);

        // Save icon if requested
        if (iconOutputPath && result.icon) {
            console.log("\n💾 Saving icon...");
            await extractor.saveIconToFile(result.icon, iconOutputPath);
        }

        // Show a preview of the icon if it's small
        if (result.icon && result.icon.size < 50000) { // Less than 50KB
            console.log("\n👁️ Icon Preview (Base64 first 100 chars):");
            console.log(result.icon.data.toString('base64').substring(0, 100) + "...");
        }

    } catch (error) {
        console.error("\n❌ EXTRACTION FAILED:");
        console.error("   Error:", error.message);
        console.error("\nDebug info:");
        console.error("   Input:", pkgPathOrUrl);
        console.error("   Stack:", error.stack?.split('\n')[1] || 'N/A');
        process.exit(1);
    }
}

// Run if called directly
if (require.main === module) {
    main();
}

// Export for use in other modules
module.exports = PKGExtractor;