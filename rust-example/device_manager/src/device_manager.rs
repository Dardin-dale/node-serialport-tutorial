use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serialport::{available_ports, SerialPortInfo, SerialPortType};
use my_device::serial_device::SerialDevice;

///Used to keep track of multiple USB connected serial devices
pub struct SerialDeviceManager<T>
where
    T: SerialDevice + 'static,
{
    devices: Arc<Mutex<BTreeMap<String, Arc<Mutex<T::Device>>>>>,
    removed: BTreeMap<String, bool>,
}

impl<T> SerialDeviceManager<T>
where
    T: SerialDevice + 'static,
{
    ///Create new DeviceManager will start a polling thread. Device must implement
    pub fn new() -> Self {
        let devices = Arc::new(Mutex::new(BTreeMap::new()));
        let removed = BTreeMap::new();
        let manager = SerialDeviceManager { devices, removed };
        manager.start_polling_thread();
        manager
    }

    ///Continuously updates list of connected devices.
    fn start_polling_thread(&self) {
        let devices = self.devices.clone();
        let removed = self.removed.clone();
        thread::spawn(move || loop {
            let available_ports = available_ports().expect("Failed to enumerate serial ports");
            let mut devices = devices.lock().unwrap();
            let matching_ports = available_ports
                .into_iter()
                .filter(|info| match &info.port_type {
                    SerialPortType::UsbPort(val) => val.vid == T::VID && val.pid == T::PID,
                    _ => false,
                })
                .collect::<Vec<SerialPortInfo>>();

            let mut changed_devices = Vec::new();

            for (port_name, _) in &*devices {
                if !matching_ports
                    .iter()
                    .any(|info| info.port_name == *port_name)
                {
                    if !removed.contains_key(port_name) {
                        changed_devices.push(port_name.clone());
                    }
                }
            }

            for key in &changed_devices {
                devices.remove(&String::from(key));
            }

            for port_info in &matching_ports {
                if !devices.contains_key(&port_info.port_name)
                    && !removed.contains_key(&port_info.port_name)
                {
                    let device = Arc::new(T::open(&port_info.port_name));
                    devices.insert(port_info.port_name.clone(), device);
                    changed_devices.push(port_info.port_name.clone());
                }
            }

            thread::sleep(Duration::from_millis(100));
        });
    }

    ///Get a list of attached devices.
    pub fn get_devices(&self) -> Vec<String> {
        self.devices.lock().unwrap().keys().cloned().collect()
    }

    ///Get a single device by the port/path identifier.
    pub fn get_device(&self, port_name: &str) -> Option<Arc<Mutex<T::Device>>> {
        self.devices.lock().unwrap().get(port_name).cloned()
    }

    pub fn remove_device(&mut self, port_name: &str) -> bool {
        self.devices.lock().unwrap().remove(port_name);
        self.removed.insert(String::from(port_name), true);
        true
    }
}
