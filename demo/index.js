/**
 * Runnable demo of the Part 1 `myDevice` interface against a fake device.
 *
 * This is the "clone and run" entry point: `npm run demo` walks through
 * the commands Part 1 introduces (LED on/off, GET, rapid-fire to show the
 * promise queue preventing cross-talk) without needing real hardware.
 *
 * How it works:
 *
 *   1. We register a fake path with `SerialPortMock.binding.createPort`.
 *      The path is just an opaque string — real hardware would use e.g.
 *      `COM15` on Windows or `/dev/ttyUSB0` on Linux, but for the mock it's
 *      any unique identifier.
 *
 *   2. We instantiate the same `myDevice` class Part 1 builds, but pass
 *      `FakeFirmwarePort` (a SerialPortMock subclass) as the second
 *      constructor argument. `myDevice` opens its own port internally; the
 *      subclass's constructor attaches fake-firmware behaviour to that
 *      port as soon as it opens. This is why `myDevice` takes the
 *      `SerialPortClass` parameter — same code path runs against real and
 *      fake hardware.
 *
 *   3. We call methods on the device and print what comes back.
 */

import { SerialPortMock } from 'serialport';
import { myDevice } from '../device/myDevice/index.js';
import { FakeFirmwarePort } from './fakeFirmware.js';

const DEVICE_PATH = 'DEMO';

const log = (label, value) => console.log(`  ${label.padEnd(28)} → ${value}`);

// Register the fake path with the mock binding before anyone tries to open it.
SerialPortMock.binding.createPort(DEVICE_PATH);

// myDevice opens a FakeFirmwarePort internally — the subclass attaches the
// fake-firmware handler to the binding as soon as it opens.
const device = new myDevice(DEVICE_PATH, FakeFirmwarePort);

// Wait for the underlying port to open before writing.
await new Promise((resolve, reject) => {
    device.port.once('open', resolve);
    device.port.once('error', reject);
});

console.log('\n=== node-serialport-tutorial demo ===');
console.log(`fake device at: ${DEVICE_PATH}\n`);

try {
    console.log('[1] single commands');
    log('ledOn()', await device.ledOn());
    log('ledOff()', await device.ledOff());
    log('getParam("SERIAL_NUMBER")', await device.getParam('SERIAL_NUMBER'));
    log('getParam("FW_VERSION")', await device.getParam('FW_VERSION'));

    console.log('\n[2] rapid-fire (promise queue should serialize these)');
    const start = Date.now();
    const results = await Promise.all([
        device.ledOn(),
        device.ledOff(),
        device.ledOn(),
        device.ledOff(),
        device.getParam('SERIAL_NUMBER'),
    ]);
    const elapsed = Date.now() - start;
    results.forEach((r, i) => log(`batch[${i}]`, r));
    console.log(`  (${results.length} commands in ${elapsed}ms — queue held concurrency=1)`);

    console.log('\n[3] unknown parameter (device should !NACK)');
    try {
        await device.getParam('NOT_A_REAL_PARAM');
        console.log('  expected rejection but got a value — fake firmware bug?');
    } catch (err) {
        log('getParam rejected with', err);
    }

    console.log('\nall good. demo complete.\n');
} catch (err) {
    console.error('\ndemo failed:', err);
    process.exitCode = 1;
} finally {
    device.port.close();
}
