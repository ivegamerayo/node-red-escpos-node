module.exports = function(RED) {
    const net = require('net');
    const sharp = require('sharp');

    const RESPONSE_TIMEOUT = 3000;
    const DLE_EOT_PAPER = Buffer.from([0x10, 0x04, 0x02]);

    const FONT_A = Buffer.from([0x1B, 0x4D, 0x00]);
    const FONT_B = Buffer.from([0x1B, 0x4D, 0x01]);
    const BOLD_ON = Buffer.from([0x1B, 0x45, 0x01]);
    const BOLD_OFF = Buffer.from([0x1B, 0x45, 0x00]);
    const ALIGN_LEFT = Buffer.from([0x1B, 0x61, 0x00]);
    const ALIGN_CENTER = Buffer.from([0x1B, 0x61, 0x01]);
    const ALIGN_RIGHT = Buffer.from([0x1B, 0x61, 0x02]);
    const INVERT_ON = Buffer.from([0x1D, 0x42, 0x01]);
    const INVERT_OFF = Buffer.from([0x1D, 0x42, 0x00]);
    const SMOOTH_ON = Buffer.from([0x1B, 0x62, 0x01]);
    const SMOOTH_OFF = Buffer.from([0x1B, 0x62, 0x00]);
    const CUT_FULL = Buffer.from([0x1D, 0x56, 0x00]);
    const PRINT_FEED = Buffer.from([0x1B, 0x64, 0x06]);

    function parsePaperStatus(byte) {
        return {
            paperOut: (byte & 0x04) !== 0,
            nearEnd: (byte & 0x0C) !== 0,
            raw: byte
        };
    }

    function sendAndReceive(client, command, timeout = RESPONSE_TIMEOUT) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error('Timeout waiting for printer response'));
            }, timeout);

            function cleanup() {
                clearTimeout(timer);
                client.removeListener('data', onData);
                client.removeListener('error', onError);
            }

            function onData(data) {
                cleanup();
                resolve(data);
            }

            function onError(err) {
                cleanup();
                reject(err);
            }

            client.on('data', onData);
            client.on('error', onError);
            client.write(command);
        });
    }

    async function convertImageToRaster(imagePath, alignment = 'center') {
        const width = 384;

        const rawImage = await sharp(imagePath)
            .resize({ width })
            .grayscale()
            .threshold(128)
            .raw()
            .toBuffer({ resolveWithObject: true });

        const { data, info } = rawImage;
        const widthBytes = Math.ceil(info.width / 8);
        const height = info.height;

        const rasterData = Buffer.alloc(widthBytes * height, 0);

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < info.width; x++) {
                const pixel = data[y * info.width + x];
                if (pixel === 0) {
                    const byteIndex = y * widthBytes + Math.floor(x / 8);
                    rasterData[byteIndex] |= 0x80 >> (x % 8);
                }
            }
        }

        const alignCommand = alignment === 'center'
            ? ALIGN_CENTER
            : alignment === 'right'
                ? ALIGN_RIGHT
                : ALIGN_LEFT;

        const header = Buffer.from([
            0x1D, 0x76, 0x30, 0x00,
            widthBytes & 0xFF,
            (widthBytes >> 8) & 0xFF,
            height & 0xFF,
            (height >> 8) & 0xFF
        ]);

        return Buffer.concat([alignCommand, header, rasterData]);
    }

    function createConnection(ip, port) {
        return new Promise((resolve, reject) => {
            const client = new net.Socket();
            client.setTimeout(5000);

            client.once('connect', () => {
                client.setTimeout(0);
                resolve(client);
            });

            client.once('error', (err) => {
                client.destroy();
                reject(err);
            });

            client.connect(port, ip);
        });
    }

    function buildPrintBuffer(config) {
        const font = config.fontType || 'A';
        const width = parseInt(config.width) || 1;
        const height = parseInt(config.height) || 1;
        const align = config.alignment || 'left';
        const bold = config.bold || false;
        const invert = config.invert || false;
        const smooth = config.smooth || false;
        const cut = config.cutAfterPrint || false;

        const fontCommand = font.toLowerCase() === 'a' ? FONT_A : FONT_B;
        const alignCommand = align === 'left' ? ALIGN_LEFT : align === 'center' ? ALIGN_CENTER : ALIGN_RIGHT;
        const boldCommand = bold ? BOLD_ON : BOLD_OFF;
        const invertCommand = invert ? INVERT_ON : INVERT_OFF;
        const smoothCommand = smooth ? SMOOTH_ON : SMOOTH_OFF;
        const sizeCommand = Buffer.from([0x1D, 0x21, (width - 1) * 0x10 + (height - 1)]);

        let parts = [
            sizeCommand,
            fontCommand,
            alignCommand,
            boldCommand,
            invertCommand,
            smoothCommand,
            Buffer.from((config.text || '').trim() + '\n')
        ];

        if (cut) {
            parts.push(PRINT_FEED, CUT_FULL);
        }

        return Buffer.concat(parts);
    }

    function EscPosPrinter(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.on('input', async function(msg) {
            const printerIp = config.ip;
            const printerPort = parseInt(config.port) || 9100;
            const text = config.text ? config.text.trim() : (msg.payload || '').toString().trim();

            if (!text && !msg.image) {
                node.warn('No text or image to print, skipping...');
                return;
            }

            const bufferParts = [];

            if (text) {
                bufferParts.push(buildPrintBuffer(config));
            }

            if (msg.image) {
                const imagePromises = Object.entries(msg.image).map(async ([key, value]) => {
                    try {
                        return await convertImageToRaster(value);
                    } catch (err) {
                        node.warn(`Image conversion failed for "${key}": ${err.message}`);
                        return null;
                    }
                });

                const imageBuffers = await Promise.all(imagePromises);
                imageBuffers.forEach(buffer => {
                    if (buffer) bufferParts.push(buffer);
                });
            }

            if (cut) {
                bufferParts.push(PRINT_FEED, CUT_FULL);
            }

            const printBuffer = Buffer.concat(bufferParts);

            let client;
            try {
                node.status({ fill: 'yellow', shape: 'dot', text: 'Connecting' });
                client = await createConnection(printerIp, printerPort);
                node.log(`Connected to ${printerIp}:${printerPort}`);

                node.status({ fill: 'yellow', shape: 'dot', text: 'Checking paper' });
                const paperStatusBefore = await sendAndReceive(client, DLE_EOT_PAPER);
                const statusBefore = parsePaperStatus(paperStatusBefore[0]);

                if (statusBefore.paperOut) {
                    node.status({ fill: 'red', shape: 'dot', text: 'Sin papel' });
                    node.error('La impresora se ha quedado sin papel');
                    msg.paperStatus = {
                        ok: false,
                        paperOut: true,
                        nearEnd: statusBefore.nearEnd,
                        raw: statusBefore.raw,
                        checkedBefore: true
                    };
                    return;
                }

                if (statusBefore.nearEnd) {
                    node.warn('Papel cerca del final');
                    msg.paperNearEnd = true;
                }

                node.status({ fill: 'yellow', shape: 'dot', text: 'Printing' });
                client.write(printBuffer);

                await new Promise((resolve) => setTimeout(resolve, 500));

                const paperStatusAfter = await sendAndReceive(client, DLE_EOT_PAPER);
                const statusAfter = parsePaperStatus(paperStatusAfter[0]);

                if (statusAfter.paperOut) {
                    node.status({ fill: 'red', shape: 'dot', text: 'Sin papel' });
                    node.error('La impresora se ha quedado sin papel tras imprimir');
                    msg.paperStatus = {
                        ok: false,
                        paperOut: true,
                        nearEnd: statusAfter.nearEnd,
                        raw: statusAfter.raw,
                        checkedAfter: true
                    };
                    return;
                }

                node.status({ fill: 'green', shape: 'dot', text: 'Printing successful' });
                msg.paperStatus = {
                    ok: true,
                    paperOut: false,
                    nearEnd: statusAfter.nearEnd,
                    checked: true
                };

            } catch (err) {
                node.status({ fill: 'red', shape: 'dot', text: 'Error' });
                node.error(`Printer error: ${err.message}`);
                msg.payload = { error: err.message };
            } finally {
                if (client) {
                    client.destroy();
                }
            }

            node.send(msg);
        });
    }

    RED.nodes.registerType('EscPos-Printer', EscPosPrinter);
};
