/**
 * A minimal fake-firmware harness for the tutorial demo.
 *
 * Intercepts host writes on a SerialPortMock instance and emits device
 * responses that match the protocol described in Part 1:
 *
 *     Host:   !CMD,arg1,arg2,...\r
 *     Device: !ACK,CMD,VALUE;CHECKSUM\r
 *
 * The checksum is computed with the same IBM CRC-16 algorithm myDevice uses,
 * so the client's `validate_checksum` path actually runs end-to-end — this
 * demo exercises the real code, not a shortcut.
 *
 * Supported commands:
 *   !LED,0 / !LED,1          → acknowledged, toggles state.ledOn
 *   !GET,SERIAL_NUMBER       → returns state.serialNumber
 *   !GET,FW_VERSION          → returns state.firmwareVersion
 *   anything else            → !NACK
 *
 * Usage: pass `FakeFirmwarePort` as the SerialPortClass argument to
 * myDevice's constructor. The subclass auto-attaches the firmware handler
 * to its own binding during `open`, so the same code path that runs in
 * production runs in the demo — just against a fake port.
 */

import { SerialPortMock } from 'serialport';

// IBM CRC-16 — must match device/myDevice/index.js. In a real product,
// the microcontroller firmware has its own C implementation of the same
// algorithm; the host and device just agree on the bytes.
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

function checksumFor(body) {
    const withDelim = body + ';';
    let calc = 0;
    for (let i = 0; i < withDelim.length; i++) {
        calc = computeCRC16MSB(withDelim.charCodeAt(i), calc);
    }
    return calc.toString(16).toUpperCase().padStart(4, '0');
}

function buildResponse(body) {
    return `${body};${checksumFor(body)}\r`;
}

// Device state — as if this were firmware running on a microcontroller.
const state = {
    serialNumber: 'DEMO_SN_00001',
    firmwareVersion: '1.0.0',
    ledOn: false,
};

function handleCommand(cmdStr) {
    if (!cmdStr.startsWith('!')) {
        return buildResponse('!NACK');
    }
    const [head, ...args] = cmdStr.slice(1).split(',');

    switch (head) {
        case 'LED': {
            const arg = args[0];
            if (arg === '0' || arg === '1') {
                state.ledOn = arg === '1';
                return buildResponse(`!ACK,LED,${arg}`);
            }
            return buildResponse('!NACK');
        }
        case 'GET': {
            const param = args[0];
            if (param === 'SERIAL_NUMBER') {
                return buildResponse(`!ACK,GET,${state.serialNumber}`);
            }
            if (param === 'FW_VERSION') {
                return buildResponse(`!ACK,GET,${state.firmwareVersion}`);
            }
            return buildResponse('!NACK');
        }
        default:
            return buildResponse('!NACK');
    }
}

/**
 * Attach fake-firmware behaviour to an already-open SerialPortMock.
 * Monkey-patches the mock binding's `.write` so that every host write
 * triggers a matching device response after a short simulated latency.
 *
 * @param {import('serialport').SerialPortMock} port - An open SerialPortMock.
 * @param {object} [options]
 * @param {number} [options.latencyMs=5] - Simulated device response latency.
 */
export function attachFakeFirmware(port, options = {}) {
    const { latencyMs = 5 } = options;
    const mock = port.port;
    const originalWrite = mock.write.bind(mock);

    mock.write = async function patchedWrite(buffer) {
        const result = await originalWrite(buffer);
        const cmdStr = buffer.toString('ascii').replace(/\r$/, '').trim();
        if (cmdStr.length > 0) {
            const response = handleCommand(cmdStr);
            setTimeout(() => {
                mock.emitData(Buffer.from(response, 'ascii'));
            }, latencyMs);
        }
        return result;
    };
}

// Exposed for tests / introspection if a demo wants to peek at device state.
export function getFakeDeviceState() {
    return { ...state };
}

/**
 * A SerialPortMock subclass that auto-attaches fakeFirmware to its own
 * binding as soon as the port opens. Pass this class as the second
 * argument to `new myDevice(path, FakeFirmwarePort)` and the demo's
 * writes will be answered by fake-firmware responses.
 */
export class FakeFirmwarePort extends SerialPortMock {
    constructor(opts, openCallback) {
        super(opts, openCallback);
        // By the time the 'open' event fires, `this.port` (the underlying
        // mock binding) is populated. Attaching earlier would hit undefined.
        this.once('open', () => attachFakeFirmware(this));
    }
}
