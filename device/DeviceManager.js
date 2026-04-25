import { SerialPort } from 'serialport';

export class DeviceManager {
    /**
     * @param {Function} DeviceClass - Device class to manage. Must expose static `VID` and
     *   `PID` strings (used to filter `SerialPort.list()`) and accept `(path, SerialPortClass)`
     *   in its constructor. See `myDevice` for the expected shape.
     * @param {object} [options]
     * @param {typeof SerialPort} [options.SerialPortClass=SerialPort] - SerialPort class used
     *   for enumeration and device instantiation. Pass a mock-binding subclass in tests/demos.
     */
    constructor(DeviceClass, { SerialPortClass = SerialPort } = {}) {
        this.DeviceClass = DeviceClass;
        this.SerialPortClass = SerialPortClass;
        this.devices = new Map();
    }

    async update() {
        const allPorts = await this.SerialPortClass.list();
        const matchingPaths = new Set(
            allPorts
                .filter(p => p.vendorId === this.DeviceClass.VID && p.productId === this.DeviceClass.PID)
                .map(p => p.path)
        );

        for (const path of matchingPaths) {
            if (!this.devices.has(path)) {
                this.devices.set(path, new this.DeviceClass(path, this.SerialPortClass));
            }
        }

        for (const path of this.devices.keys()) {
            if (!matchingPaths.has(path)) {
                this.devices.get(path).port.close();
                this.devices.delete(path);
            }
        }
    }

    getDevices() {
        return [...this.devices.keys()];
    }

    getDevice(path) {
        return this.devices.get(path);
    }

    async resetPort(path) {
        const device = this.devices.get(path);
        if (!device) return;
        device.port.close();
        this.devices.delete(path);
    }

    async shutdown() {
        await Promise.allSettled(
            [...this.devices.values()].map(async (device) => {
                await device.queue.onIdle();
                device.port.close();
            })
        );
        this.devices.clear();
    }
}
