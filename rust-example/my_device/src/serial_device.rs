use std::sync::{Mutex};

pub trait SerialDevice: Send {
    type Device: Send;
    fn open(path: &str) -> Mutex<Self::Device>;
    const VID: u16;
    const PID: u16;
}
