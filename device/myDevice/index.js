import Params from './parameters.js';
import PQueue from 'p-queue';
import { SerialPort, ReadlineParser } from 'serialport';

/**
 * Calculates an IBM CRC16 checksum.
 *
 * @param {number} b - The byte of data to process for the checksum.
 * @param {number} crc - The previous value of the checksum.
 * @returns {number} The new value of the checksum.
 */
function computeCRC16MSB(b, crc) {
    let data = b;
    data <<= 8;
    for (let i = 0; i < 8; i++) {
        if (((data ^ crc) & 0x8000) !== 0) {
            crc = 0xffff & ((crc << 1) ^ 0x8005);
        } else {
            crc = 0xffff & (crc << 1);
        }
        data <<= 1;
    }
    return crc;
}

function generateChecksum(msg) {
    const withDelim = msg.toString() + ';';
    const bytes = withDelim.split('').map(c => c.charCodeAt(0));
    let calc = 0;
    for (const b of bytes) {
        calc = computeCRC16MSB(b, calc);
    }
    return calc.toString(16).toUpperCase().padStart(4, '0');
}

function validate_checksum(msg, checksum) {
    return generateChecksum(msg) === checksum;
}

/**
 * Sends a command and reads multiple data lines back until the device
 * emits its idle sentinel (`self.idle`). Use this for commands whose
 * response spans more than one line (e.g. log dumps, bulk data exports,
 * streamed readings).
 *
 * Differs from `ack_call` in three important ways:
 *   1. Uses `.on('data', ...)` not `.once('data', ...)`, so we can
 *      accumulate multiple lines from the same listener.
 *   2. Explicitly calls `removeAllListeners('data')` at every exit path.
 *      With `.once` the parser cleans up after one call; with `.on` we
 *      have to do it ourselves or leak listeners on every request.
 *   3. Lines are filtered by their header: only lines starting with
 *      `expected` (e.g. `!LOG`) are collected. `!ACK` is ignored, `!NACK`
 *      rejects, and the idle sentinel ends collection.
 *
 * Example usage in a myDevice method:
 *   getLogs() {
 *     const cmd = Buffer.from('!GET,LOGS\r', 'ascii');
 *     return this.queue.add(() => new Promise((resolve, reject) => {
 *       multi_receive(this, resolve, reject, cmd, '!LOG');
 *     }));
 *   }
 */
async function multi_receive(self, resolve, reject, command, expected) {
    try {
        self.port.once('error', err => reject(err));
        const collected = [];
        const cleanup = () => {
            self.parser.removeAllListeners('data');
            self.port.removeAllListeners('error');
        };
        const timer = setTimeout(() => {
            cleanup();
            reject('Device timed out. CMD: ' + command.toString().trim() + ' failed. Path: ' + self.path);
        }, 15000);

        self.port.write(command, (err) => {
            if (err) {
                clearTimeout(timer);
                cleanup();
                reject(err);
            }
        });

        self.parser.on('data', (data) => {
            const msg = data.toString('ascii').split(';');
            const checksum = msg[1] ? msg[1].trim() : '';
            const info = msg[0].split(',');

            if (!validate_checksum(msg[0], checksum)) {
                clearTimeout(timer);
                cleanup();
                reject('Invalid checksum returned. received: ' + msg[0] + ' check: ' + checksum);
                return;
            }

            if (info[0] === '!NACK') {
                clearTimeout(timer);
                cleanup();
                reject('Command: ' + command.toString().trim() + ' not properly acknowledged.');
                return;
            }

            // Skip bare acknowledgements. Data lines are what we want.
            if (info[0] === '!ACK') return;

            // Collect lines whose header matches what the caller asked for.
            if (info[0] === expected) {
                collected.push(msg[0]);
            }

            // Device signals end-of-stream with self.idle (e.g. '!STATUS,IDLE').
            if (msg[0] === self.idle) {
                clearTimeout(timer);
                cleanup();
                resolve(collected);
            }
        });
    } catch (err) {
        reject(err);
    }
}

async function ack_call(self, resolve, reject, cmd, timeoutMs = 5000) {
    try {
        self.port.once('error', err => reject(err));
        const timer = setTimeout(() => {
            self.port.removeAllListeners('error');
            reject('Device Timed out.');
        }, timeoutMs);

        self.port.write(cmd, (err) => {
            if (err) {
                self.port.removeAllListeners('error');
                reject(err);
            }
        });

        self.parser.once('data', (data) => {
            const msg = data.toString('ascii').split(';');
            const checksum = msg[1].trim();
            const info = msg[0].split(',');
            if (info[0] === '!NACK') {
                clearTimeout(timer);
                self.port.removeAllListeners('error');
                reject("Command: " + cmd + " not properly Ack'd!");
                return;
            }
            if (!validate_checksum(msg[0], checksum)) {
                clearTimeout(timer);
                self.port.removeAllListeners('error');
                reject('Invalid checksum, Data corrupt');
                return;
            }
            clearTimeout(timer);
            self.port.removeAllListeners('error');
            resolve(info[2]);
        });
    } catch (err) {
        reject(err);
    }
}

export class myDevice {
    // USB descriptor for our device. DeviceManager reads these off the class
    // to filter SerialPort.list() results. STMicroelectronics Virtual COM Port,
    // common on STM32-based boards.
    static VID = '0483';
    static PID = '5740';

    /**
     * @param {string} id - OS path identifier (e.g. 'COM15' on Windows, '/dev/ttyS0' on Linux).
     * @param {typeof SerialPort} [SerialPortClass=SerialPort] - SerialPort class to use.
     *   Defaults to the production class. Pass `SerialPortMock` in tests and demos so
     *   the same code path can be exercised against a fake device.
     * @param {object} [options]
     * @param {() => void} [options.onDisconnect] - Called when the OS reports the device
     *   has gone away (`'close'` event with `err.disconnected`). Lets the caller (usually
     *   `DeviceManager`) react without reaching through to `this.port`. Not called when
     *   the caller closes the port intentionally via `close()`.
     */
    constructor(id, SerialPortClass = SerialPort, { onDisconnect } = {}) {
        this.path = id;
        // Sentinel that marks the end of a multi-line response. Compared
        // against the first segment of each incoming line in `multi_receive`.
        this.idle = '!STATUS,IDLE';
        this.parser = new ReadlineParser({ delimiter: '\r', encoding: 'ascii' });
        this.port = new SerialPortClass(
            { path: id, baudRate: 115200 },
            (err) => {
                if (err) throw new Error('Unable to initiate port: ' + err.message);
            }
        );
        this.queue = new PQueue({ concurrency: 1 });
        this.port.pipe(this.parser);
        this.port.on('close', (err) => {
            // Filter for the `disconnected` flag. 'close' also fires when the
            // caller invokes close() on purpose, and that's not what subscribers
            // are asking about.
            if (err?.disconnected && onDisconnect) onDisconnect();
        });
    }

    /**
     * Releases the underlying serial port. Resolves immediately if the port is
     * already closed, so it's safe to call at any time. Returning a promise lets
     * lifecycle managers await the close before reusing or replacing the path.
     */
    close() {
        return new Promise((resolve, reject) => {
            if (!this.port.isOpen) return resolve();
            this.port.close((err) => err ? reject(err) : resolve());
        });
    }

    ledOn() {
        const cmd = Buffer.from('!LED,1\r', 'ascii');
        return this.queue.add(() => new Promise((resolve, reject) => {
            ack_call(this, resolve, reject, cmd);
        }));
    }

    ledOff() {
        const cmd = Buffer.from('!LED,0\r', 'ascii');
        return this.queue.add(() => new Promise((resolve, reject) => {
            ack_call(this, resolve, reject, cmd);
        }));
    }

    getParam(param) {
        const cmd = Buffer.from('!GET,' + param + '\r', 'ascii');
        return this.queue.add(() => new Promise((resolve, reject) => {
            ack_call(this, resolve, reject, cmd);
        }));
    }

    // Sets a parameter temporarily. The value lives in volatile memory
    // until saveParams() commits it to non-volatile storage.
    setParam(param, value) {
        if (!Params.isValid(param, value)) {
            return Promise.reject('Invalid value for parameter: ' + param);
        }
        const cmd = Buffer.from('!SET,' + param + ',' + value + '\r', 'ascii');
        return this.queue.add(() => new Promise((resolve, reject) => {
            ack_call(this, resolve, reject, cmd);
        }));
    }

    // Commits all pending parameter changes to non-volatile memory.
    saveParams() {
        const cmd = Buffer.from('!CAL,1,1\r', 'ascii');
        return this.queue.add(() => new Promise((resolve, reject) => {
            ack_call(this, resolve, reject, cmd);
        }));
    }

    // Convenience: set a parameter AND save in one call.
    // Both commands go through the queue sequentially, so from the
    // caller's perspective this is a single awaitable operation.
    async updateParam(param, value) {
        await this.setParam(param, value);
        return this.saveParams();
    }

    // Cheap liveness check. Resolves to true if the device answers a
    // !GET,FW_VERSION within 1s, false otherwise. Goes through the queue
    // like any other command so it can't race with an in-flight request.
    ping() {
        const cmd = Buffer.from('!GET,FW_VERSION\r', 'ascii');
        return this.queue.add(() => new Promise((resolve, reject) => {
            ack_call(this, resolve, reject, cmd, 1000);
        })).then(() => true, () => false);
    }

    // Snapshot of the parameters worth surfacing to a UI. Each fetch goes
    // through the per-device queue, so the calls run sequentially against
    // this device but pollers for other devices run in parallel.
    async poll() {
        return {
            serialNumber: await this.getParam('SERIAL_NUMBER'),
            ledDrive: await this.getParam('LED_DRIVE'),
        };
    }
}
