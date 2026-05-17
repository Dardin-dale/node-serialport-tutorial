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
 *      The path is just an opaque string. Real hardware would use e.g.
 *      `COM15` on Windows or `/dev/ttyUSB0` on Linux, but for the mock it's
 *      any unique identifier.
 *
 *   2. We instantiate the same `myDevice` class Part 1 builds, but pass
 *      `FakeFirmwarePort` (a SerialPortMock subclass) as the second
 *      constructor argument. `myDevice` opens its own port internally; the
 *      subclass's constructor attaches fake-firmware behaviour to that
 *      port as soon as it opens. This is why `myDevice` takes the
 *      `SerialPortClass` parameter: the same code path runs against real and
 *      fake hardware.
 *
 *   3. We call methods on the device and print what comes back.
 */

import { SerialPortMock } from 'serialport';
import { myDevice } from '../device/myDevice/index.js';
import { DeviceManager } from '../device/DeviceManager.js';
import { FakeFirmwarePort, setFakeDeviceState } from './fakeFirmware.js';

const DEVICE_PATH = 'DEMO';

const log = (label, value) => console.log(`  ${label.padEnd(36)} → ${value}`);
const waitOpen = (port) => new Promise((resolve, reject) => {
    if (port.isOpen) return resolve();
    port.once('open', resolve);
    port.once('error', reject);
});

// Register the fake path with the mock binding before anyone tries to open it.
SerialPortMock.binding.createPort(DEVICE_PATH);

// myDevice opens a FakeFirmwarePort internally; the subclass attaches the
// fake-firmware handler to the binding as soon as it opens.
const device = new myDevice(DEVICE_PATH, FakeFirmwarePort);

// Wait for the underlying port to open before writing.
await waitOpen(device.port);

console.log('\n=== node-serialport-tutorial demo ===');
console.log('--- Part 1: single device ---');
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
    console.log(`  (${results.length} commands in ${elapsed}ms, queue held concurrency=1)`);

    console.log('\n[3] set + save (non-volatile memory workflow)');
    log('setParam("LED_DRIVE", "200")', await device.setParam('LED_DRIVE', '200'));
    log('getParam("LED_DRIVE")', await device.getParam('LED_DRIVE'));
    log('saveParams()', await device.saveParams());
    log('updateParam("LED_DRIVE", "50")', await device.updateParam('LED_DRIVE', '50'));
    log('getParam("LED_DRIVE")', await device.getParam('LED_DRIVE'));

    console.log('\n[4] validation (bad param should reject locally)');
    try {
        await device.setParam('LED_DRIVE', '999');
        console.log('  expected rejection but got a value. validator bug?');
    } catch (err) {
        log('setParam rejected with', err);
    }

    console.log('\n[5] unknown parameter (device should !NACK)');
    try {
        await device.getParam('NOT_A_REAL_PARAM');
        console.log('  expected rejection but got a value. fake firmware bug?');
    } catch (err) {
        log('getParam rejected with', err);
    }

    console.log('\nPart 1 complete.');
} catch (err) {
    console.error('\nPart 1 failed:', err);
    process.exitCode = 1;
} finally {
    device.port.close();
}

// =============================================================================
// Part 2: DeviceManager with multiple devices
// =============================================================================

// Two matching fake devices + one with different VID/PID that the manager
// should filter out.
SerialPortMock.binding.createPort('/dev/mock-a', { vendorId: myDevice.VID, productId: myDevice.PID });
SerialPortMock.binding.createPort('/dev/mock-b', { vendorId: myDevice.VID, productId: myDevice.PID });
SerialPortMock.binding.createPort('/dev/mock-other', { vendorId: '1234', productId: '5678' });

setFakeDeviceState('/dev/mock-a', { params: { SERIAL_NUMBER: 'DEMO_A_0001', LED_DRIVE: '64' } });
setFakeDeviceState('/dev/mock-b', { params: { SERIAL_NUMBER: 'DEMO_B_0002', LED_DRIVE: '192' } });

const manager = new DeviceManager(myDevice, { SerialPortClass: FakeFirmwarePort });

console.log('\n--- Part 2: DeviceManager ---\n');

try {
    console.log('[6] enumeration (VID/PID filter)');
    await manager.update();
    log('manager.getDevices()', JSON.stringify(manager.getDevices()));

    // myDevice kicks off open() in its constructor but doesn't await it.
    // Wait for both ports before issuing commands.
    await Promise.all(manager.getDevices().map(path => waitOpen(manager.getDevice(path).port)));

    console.log('\n[7] look up each device and call methods on it directly');
    for (const path of manager.getDevices()) {
        const d = manager.getDevice(path);
        log(`getDevice(${path}).getParam("SERIAL_NUMBER")`, await d.getParam('SERIAL_NUMBER'));
    }

    console.log('\n[8] parallel across devices, serialized per device');
    const deviceA = manager.getDevice('/dev/mock-a');
    const deviceB = manager.getDevice('/dev/mock-b');
    const start = Date.now();
    const [readA, readB] = await Promise.all([
        deviceA.getParam('LED_DRIVE'),
        deviceB.getParam('LED_DRIVE'),
        deviceA.updateParam('LED_DRIVE', '10'),
        deviceB.updateParam('LED_DRIVE', '20'),
    ]);
    const elapsed = Date.now() - start;
    log('mock-a LED_DRIVE (before update)', readA);
    log('mock-b LED_DRIVE (before update)', readB);
    log('mock-a LED_DRIVE (after update)', await deviceA.getParam('LED_DRIVE'));
    log('mock-b LED_DRIVE (after update)', await deviceB.getParam('LED_DRIVE'));
    console.log(`  (fired 4 commands in parallel, finished in ${elapsed}ms)`);

    console.log('\n[9] disconnect + rediscovery');
    // The mock binding has no removePort; reset() and re-register to simulate
    // mock-a being unplugged while mock-b stays on.
    SerialPortMock.binding.reset();
    SerialPortMock.binding.createPort('/dev/mock-b', { vendorId: myDevice.VID, productId: myDevice.PID });
    await manager.update();
    log('after unplugging mock-a', JSON.stringify(manager.getDevices()));

    console.log('\n[10] graceful shutdown');
    await manager.shutdown();
    log('manager.getDevices() after shutdown', JSON.stringify(manager.getDevices()));

    console.log('\nall good. demo complete.\n');
} catch (err) {
    console.error('\nPart 2 failed:', err);
    process.exitCode = 1;
} finally {
    await manager.shutdown().catch(() => {});
}
