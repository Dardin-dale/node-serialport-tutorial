# rust-example

A Rust reference implementation of the device-interface and device-manager patterns taught in the main tutorial. **Not a parallel tutorial** — this is here so you can see how the same problem gets solved in a language with different concurrency primitives.

Where the JavaScript version uses a per-device `PQueue` for mutual exclusion, the Rust version uses `Arc<Mutex<MyDevice>>` and a polling thread. The shape of the solution is the same; the primitive is different.

## Layout

- `my_device/` — defines `MyDevice`, the `SerialDevice` trait, and parameter validation.
- `device_manager/` — defines `SerialDeviceManager<T>`, generic over any `SerialDevice` implementor, with its own polling thread.

## Building

This crate depends on `serialport`, which on Linux requires `libudev` for USB device enumeration. Before building, install the development headers:

```
# Debian / Ubuntu / WSL
sudo apt install libudev-dev

# Fedora / RHEL
sudo dnf install systemd-devel
```

Windows and macOS don't need any extra system packages.

Once the system dep is in place:

```
cargo check      # fast typecheck, what CI would run
cargo build      # full build
```

## What to read first

1. `my_device/src/serial_device.rs` — the trait that any serial device must implement. Keeps `SerialDeviceManager` generic.
2. `my_device/src/my_device.rs` — the concrete device, including its CRC-16 implementation (matches the JS version byte-for-byte) and the `ack_call` / `data_call` methods.
3. `my_device/src/parameters.rs` — parameter enum + validator, same role as `parameters.js`.
4. `device_manager/src/device_manager.rs` — the manager. Note the single `BTreeMap<String, Arc<Mutex<T::Device>>>` keyed on port path. No parallel index by serial number — one source of truth.

