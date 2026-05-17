Once you have a `DeviceManager` and a polling loop, the next thing customers ask for is "can we push a firmware update from the app." DFU (Device Firmware Update) is the workflow that lets you replace what's running on the microcontroller without sending the device back to be reflashed in a jig.

The protocol details vary by firmware vendor (STM32 has its own bootloader, Nordic has another, plenty of teams roll their own), but the *shape* of a host-side DFU implementation is the same everywhere. This chapter walks through that shape and the surprises that come with it. The code samples are sketches against the Parts 1-3 primitives; there's no runnable DFU code in this repo.

## What DFU actually is

A microcontroller boots into one of two modes: application firmware (the normal one, where it runs your product) or bootloader firmware (a smaller, simpler image whose only job is to receive a new application image and write it to flash). The bootloader is usually burned in at the factory and never replaced.

A DFU sequence looks like:

1. The host tells the running application "enter DFU mode."
2. The application acknowledges, then jumps to the bootloader. The USB stack restarts.
3. The host re-enumerates the device. The bootloader almost always has a different USB VID/PID than the application: same physical port, different logical identity.
4. The host streams the new firmware image to the bootloader in chunks, with checksums per chunk. The bootloader writes each chunk to flash as it arrives.
5. The bootloader verifies the whole image, then jumps back to the application. USB stack restarts again.
6. The host re-enumerates. The application is back, ideally running the new code.

That's the happy path. The reason DFU has its own chapter is that every step has a way to go wrong, and the host code has to handle all of them gracefully. Losing power halfway through a flash write means the device boots into a broken application image, and the user blames you.

## Two-phase identity

The thing that makes DFU different from anything else in Parts 1–3 is that the device's identity changes mid-operation. Up to now, a path like `/dev/ttyUSB0` (or `COM15`) has been bound to one device the whole time the app is running. With DFU:

- Application VID/PID `0483:5740` shows up on `/dev/ttyUSB0`.
- After "enter DFU", the device disappears from the bus for a few seconds.
- Bootloader VID/PID `0483:DF11` shows up, possibly on a different path depending on the OS and how it assigns names.

Your DFU code has to sit above the `DeviceManager` and orchestrate this. Concretely:

1. Send the "enter DFU" command via the application device.
2. Close the serial port. The application is about to disappear from the bus and any open handle to it will go stale.
3. Wait for re-enumeration. Different OSes take different amounts of time. Linux is usually under 500 ms; Windows can be 2–4 seconds, especially on first connect when the OS is also installing a driver for the bootloader VID/PID.
4. Drive the firmware upload against the bootloader.
5. Wait for the bootloader to drop off and the application to come back.

The waiting is, fundamentally, the same enumeration polling we already built in Part 3, run on a tighter inner cadence and against different VID/PIDs.

## The right tool: dfu-util

You *could* write the chunk-by-chunk upload protocol yourself: open the device's USB DFU class endpoints, pack the image into chunks, parse per-chunk acks, handle every chip family's quirks. This would take weeks and you'd ship bugs.

Don't. Use [dfu-util](https://dfu-util.sourceforge.net/), the canonical command-line tool for DFU 1.0/1.1 devices including all STM32 parts. Bundle the binary with your app, shell out to it, parse its output. The orchestration around dfu-util is your job; the bytes-on-the-wire part is solved.

For STM32 the canonical invocation is:

```
dfu-util -d 0483:DF11 -s :leave -D firmware.bin
```

- `-d 0483:DF11`: match only devices in DFU mode (bootloader VID/PID).
- `-s :leave`: leave DFU mode after the upload completes (bootloader jumps to the new application).
- `-D firmware.bin`: download the file *to* the device. (Confusingly, "download" in DFU vocabulary means host-to-device. "Upload" is the reverse.)

For other chip families the orchestration shape stays the same; only the spawn target changes:

- **Nordic nRF5**: `nrfutil` over its own DFU protocol (Bluetooth or USB-CDC).
- **Espressif ESP32 / ESP8266**: `esptool.py` over UART. Not strictly USB-DFU, but the same "host shells out, polls for re-enumeration" shape applies.
- **Custom bootloaders**: whatever tool the firmware team gives you. If they didn't give you one, ask why before you start writing it yourself.

## What dfu-util is actually doing

If you've used dfu-util as a black box (most people do, including me for years), it's worth knowing roughly what it's doing before you trust it with a flash erase. You don't need to implement any of this. Knowing it just helps you read dfu-util's output and the failure modes you'll see.

DFU is a USB device class with a small set of class-specific control requests. dfu-util issues these in sequence:

1. **`DFU_GETSTATUS`**: confirm the device is in `dfuIDLE` state. The response includes `bwPollTimeout`, the milliseconds the host should wait before polling status again. dfu-util respects this; it's how the device says "I need a moment to write this chunk to flash."
2. **`DFU_DNLOAD`** of chunk N: host-to-device, payload size is `wTransferSize` from the device's DFU descriptor (typically 1024 or 2048 bytes for STM32).
3. **`DFU_GETSTATUS`** in a wait loop until state returns to `dfuDNLOAD-IDLE`. This is the per-chunk handshake.
4. Repeat for every chunk.
5. **`DFU_DNLOAD`** with zero length: signals "no more chunks."
6. **`DFU_GETSTATUS`** until `dfuMANIFEST-WAIT-RESET`, which is the device saying "I've verified the image and I'm about to reset."
7. With `-s :leave`, dfu-util issues a USB reset; the bootloader jumps to the new application.

So it's a chunked protocol with per-chunk acks and a device-controlled rate limit, not a single fire-and-forget stream. The bytes-on-the-wire part is solid. Bugs come from **what you hand it**.

For STM32 specifically, you have two file formats:

- **Plain `.bin`**: raw flash image. Works if the bootloader knows where to write (and STM32's built-in DFU does, starting at `0x08000000`).
- **`.dfu` (DfuSe extension)**: a `.bin` wrapped in a DFU header that includes the target memory addresses, a CRC over the image, and metadata. STM32CubeProgrammer and ST's bootloader use this. dfu-util recognizes it via the `-D file.dfu` argument and unpacks it for you.

If your firmware team hands you a `.dfu`, use it. The CRC catches corrupt downloads before flashing, and the addressing metadata matters once you have non-trivial memory layouts (multiple flash banks, embedded data sections). If they hand you a `.bin`, ask whether they verified it flashes cleanly with the default base address. Sometimes the build output skips the vector table or has a wrong offset and you only find out when the device bricks.

Chip-family quirks worth knowing:

- **STM32 bootloader VID/PID is `0483:DF11` across the family.** F4, G0, H7, L4 all show up the same. dfu-util's `-d` filter alone can't distinguish them. If you have multiple STM32 devices plugged in, use `--serial` to bind to a specific instance.
- **Some STM32 parts have errata where the bootloader doesn't cleanly leave DFU mode** and needs a physical reset or power cycle. STM32G0 had this for a while; check the chip's errata sheet if `:leave` reliably fails on your hardware.
- **dfu-util retries internally on transient errors** but gives up after a small number of attempts. Its exit codes are the only signal you get; capture them and surface stderr to your UI on failure.

## Could I write this myself?

A natural question once you understand what dfu-util is doing: do I need it at all? Could I just implement the protocol in my Node app and skip the bundled binary?

The honest answer is "yes, sometimes, but probably no for STM32." This space is poorly documented on the open web. Most of what exists is buried in EE-internal docs, vendor application notes, or scattered across chip-specific tutorials that don't generalize.

**For STM32 (USB-DFU class), don't.** Writing the upload yourself means:

- Bypassing node-serialport entirely. The bootloader is USB-DFU class, not USB-CDC, so you'd use a USB library like [`node-usb`](https://github.com/node-usb/node-usb) (libusb wrapper) or WebUSB.
- Implementing the DFU class control requests (`DFU_GETSTATUS`, `DFU_DNLOAD`, the `bwPollTimeout` wait loop, the manifestation phase). Maybe 1500–2000 lines of careful USB code.
- Parsing the device's DFU functional descriptor for `wTransferSize`. Not all STM32 parts agree.
- Handling DfuSe addressing if you want to write to non-default flash regions.

Reference implementations exist: [webdfu](https://github.com/devanlai/webdfu) (browser, WebUSB-based) and dfu-util itself as the gold standard. But the protocol isn't the hard part; the cross-platform USB packaging is. Windows needs a WinUSB driver bound to the bootloader VID/PID via [Zadig](https://zadig.akeo.ie/) or signed install hooks. Linux needs udev rules. macOS needs codesigning entitlements. dfu-util has internalized 15+ years of corner cases across the STM32 family that you'd otherwise discover one customer at a time.

**For other chip families, sometimes yes.** Rolling your own is more viable when the protocol runs on a transport you already own:

- **Espressif (ESP32, ESP8266)**: esptool's protocol runs over plain UART, not USB-DFU. The packet format is [documented](https://docs.espressif.com/projects/esptool/en/latest/esp32/advanced-topics/serial-protocol.html). [esptool-js](https://github.com/espressif/esptool-js) is a browser/Node port. Reasonable to write yourself if you want firmware update integrated into your existing serialport-based app without bundling Python.
- **Nordic nRF5**: Custom DFU protocol over BLE or USB-CDC, not USB-DFU class. [Documented packet format](https://infocenter.nordicsemi.com/topic/sdk_nrf5_v17.1.0/lib_dfu_transport_serial.html). Libraries like `nrf-dfu-js` exist; people have rewritten nrfutil because the protocol is text-y and tractable.
- **Custom bootloaders**: If your firmware team rolled their own, you have no tool. You write the host side. This is the case where the chunked-transfer pseudocode you might have imagined writing actually applies: sequence numbers, per-chunk CRCs, retry on NACK, manifestation acks. The pattern is uniform; only the on-the-wire format changes.

**Resources, since they're hard to find:**

- [USB DFU 1.1 specification](https://www.usb.org/sites/default/files/DFU_1.1.pdf): the canonical reference for what dfu-util is implementing. About 30 pages, surprisingly readable.
- [STMicro AN3156](https://www.st.com/resource/en/application_note/an3156-usb-dfu-protocol-used-in-the-stm32-bootloader-stmicroelectronics.pdf): STM32-specific application note covering the DfuSe extensions.
- [esptool serial protocol docs](https://docs.espressif.com/projects/esptool/en/latest/esp32/advanced-topics/serial-protocol.html).
- [Nordic DFU transport docs](https://infocenter.nordicsemi.com/topic/sdk_nrf5_v17.1.0/lib_dfu_transport_serial.html).

Write it yourself when no tool exists, when the protocol runs on a transport you already have open, or when distribution constraints rule out bundling (browser-only via WebUSB, etc.). Otherwise, shell out to dfu-util. The 60 KB of bundled binary is almost always cheaper than the corner cases you'd otherwise own.

## Wiring up dfu-util

Three pieces:

1. A wrapper around `dfu-util` itself.
2. An `enterDFUMode()` method on the device class to send the "jump to bootloader" command.
3. A coordinator on `DeviceManager` (or above) that sequences the two and waits for re-enumeration.

### The dfu-util wrapper

```js
// device/myDevice/firmwareUpdate.js
import { spawn } from 'node:child_process';
import path from 'node:path';

const DFU_UTIL = path.join(import.meta.dirname, '../../bin/dfu-util');

export function uploadFirmware(firmwarePath, { onProgress } = {}) {
    return new Promise((resolve, reject) => {
        const args = ['-d', '0483:DF11', '-s', ':leave', '-D', firmwarePath];
        const proc = spawn(DFU_UTIL, args);

        let stderr = '';
        proc.stdout.on('data', (chunk) => {
            // dfu-util emits lines like:
            // "Download    [=========================] 100%  20480 bytes"
            const match = chunk.toString().match(/(\d+)%/);
            if (match && onProgress) onProgress(parseInt(match[1], 10));
        });
        proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        proc.on('error', reject);
        proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`dfu-util exited ${code}: ${stderr}`));
        });
    });
}
```

Use `spawn`, not `execFileSync`. Sync exec blocks the event loop for the entire upload (tens of seconds), and you can't surface progress to the UI while it's running. Streaming stdout is what lets you parse the percentage and emit it as a `device-updating` SSE event in the same loop from Part 3.

### The "enter DFU" command

Add a method to `myDevice` that sends whatever command your firmware uses to jump to the bootloader. Names and formats vary by product. Yours is whatever your firmware engineer documented. Treat it like any other command: queued, ack'd, with a short timeout (the device is about to disappear, so don't wait long for a response).

```js
// myDevice
enterDFUMode() {
    const cmd = Buffer.from('!ENTER_DFU\r', 'ascii');
    return this.queue.add(() => new Promise((resolve, reject) => {
        ack_call(this, resolve, reject, cmd, 1000);
    }));
}
```

### The coordinator

```js
// DeviceManager
async updateFirmware(path, firmwarePath, { onProgress } = {}) {
    const device = this.devices.get(path);
    if (!device) throw new Error(`No device at ${path}`);

    await device.enterDFUMode();
    await device.close();
    this.devices.delete(path);

    // Wait for the bootloader to appear. Linux: usually under 500ms.
    // Windows on first connect: up to ~4s while the driver is installed.
    await waitForVidPid({ vendorId: '0483', productId: 'df11', timeoutMs: 10000 });

    await uploadFirmware(firmwarePath, { onProgress });

    // dfu-util's `:leave` told the bootloader to jump to the new application.
    // Now wait for the application VID/PID to come back on the bus.
    await waitForVidPid({ vendorId: '0483', productId: '5740', timeoutMs: 10000 });
    // The next enumeration tick on the polling loop will pick it up
    // and broadcast the new device.
}

async function waitForVidPid({ vendorId, productId, timeoutMs }) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const ports = await SerialPort.list();
        if (ports.some(p => p.vendorId === vendorId && p.productId === productId)) return;
        await new Promise(r => setTimeout(r, 200));
    }
    throw new Error(`No device with ${vendorId}:${productId} appeared within ${timeoutMs}ms`);
}
```

Note the lowercase `'df11'` and `'5740'` in the comparisons. `SerialPort.list()` returns IDs as lowercase hex, while dfu-util's CLI argument is conventionally uppercase. Same value, different format on each side of the boundary.

`waitForVidPid` is doing the same work as the enumeration loop in Part 3, just on a tight inner cadence. You could share the implementation if you wanted; for clarity I keep them separate.

## Project structure

```
device/
  myDevice/
    index.js              # myDevice (with enterDFUMode method added)
    firmwareUpdate.js     # uploadFirmware: dfu-util wrapper
  DeviceManager.js        # orchestrates the flow, owns updateFirmware()
bin/
  dfu-util                # bundled binary, platform-specific
  dfu-util.exe
firmware/
  app-1.4.0.dfu           # the file dfu-util ships to the bootloader
```

Bundle dfu-util with your app rather than asking users to install it. The binaries are small and the user experience of "click update, wait" beats "first install dfu-util via brew/apt/scoop." For Electron, [electron-builder](https://www.electron.build/) `extraResources` is the standard way to ship per-platform binaries; for a plain Node CLI, drop them in `bin/` and gate by `process.platform`.

The firmware file itself can be local (bundled with the app, picked via file dialog) or fetched from your update server. Either way, by the time `uploadFirmware` runs, the file is at a real path on disk.

## Why it's tricky

Things that bite you the first time you ship DFU:

- **Power loss mid-flash.** If the user yanks the cable while you're writing chunk 73 of 200, the device may now have a half-written application image. A well-designed bootloader handles this by refusing to jump to the application until the image-verify checksum matches. If your bootloader doesn't do this, you bricked the device. Test this case.
- **Re-enumeration timing varies.** This is the single biggest source of intermittent failures. Hardcoding `sleep(4000)` will work most of the time on Windows and waste 3.5 seconds on Linux. Hardcoding `sleep(500)` will fail on Windows when the OS is installing a driver. Poll for the VID/PID to actually appear, with a generous timeout, instead of guessing.
- **Two devices in DFU at once.** If the user starts a DFU on device A and then plugs in device B, your "wait for bootloader to appear" loop will see B's path and try to drive A's upload through it. dfu-util's `-d` filter only looks at VID/PID, not path or serial number. If you ship multi-device support, either lock out enumeration during DFU or use dfu-util's `--serial` flag to bind to the specific bootloader instance.
- **Antivirus and Windows driver signing.** First time the bootloader VID/PID shows up on a Windows machine, the OS may pop a UAC prompt, prompt for driver signing, or quietly fail. This is OS-level and not really something host code can paper over. But you can detect "we never saw the bootloader appear" and surface a clear "open Device Manager and check for an unsigned driver" message.
- **Firmware that lies about success.** A flash write can succeed at the physical level but corrupt due to a power glitch on the rail. The whole-image verify step at the end of step 5 is the only thing that catches this. Don't skip it.
- **Wrong file format.** A `.bin` flashed to the wrong base address will brick the device just as effectively as a power loss. If your firmware team hands you a `.dfu`, use it; the CRC and addressing metadata catch what a raw `.bin` won't.

## Beyond the basic implementation

The wiring above gets you a working firmware update. A few directions you might extend it once that's solid:

- **Retry on transient failure.** If dfu-util fails with a non-zero exit code, look at stderr. Some failures are transient (re-enumeration race, single chunk error) and a single retry will succeed. Others (CRC mismatch, write-protected sector) won't. Retry once on the transient categories before surfacing failure to the user.
- **Persisted state for crash recovery.** If the host process dies between "enter DFU" and the upload finishing, the device is sitting in bootloader mode and the next app launch has no idea. Persist the in-flight state (which device, which firmware file) and on launch, check for a bootloader VID/PID. If you find one, finish the upload or prompt the user to choose.
- **Web-hosted firmware.** Bundling the firmware file with the app means every update ships a new app build. A version-check endpoint plus a download step lets you push firmware updates without redeploying. Keep the bundled file as a fallback for offline installs.
- **Multi-device update.** If the user has five devices and one new image, do you update them in parallel or in series? Parallel is faster but USB-DFU on a single host has surprising contention; serial is slower but reliable. Series is the right default.
- **Rollback on verify failure.** If the new firmware boots but immediately reports a problem (the application sends a `!STATUS,DEGRADED` or simply doesn't ack pings), some bootloaders support keeping the previous image as a fallback and triggering a rollback. This is bootloader-side work, but the host can detect "post-update health check failed" and prompt the user.

The takeaway for the broader tutorial is that the primitives we built up (`myDevice` for protocol framing, `DeviceManager` for lifecycle, `setAsyncInterval` for polling) compose into DFU naturally. You aren't building a separate stack; you're orchestrating the same pieces with a different control flow on top, plus one external binary doing the part you should never write yourself.
