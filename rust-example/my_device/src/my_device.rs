use std::time::Duration;
use std::sync::Mutex;

use serialport::*;

use crate::parameters;
use crate::serial_device::SerialDevice;
use parameters::Parameter;

pub struct MyDevice {
    port: Box<dyn SerialPort>,
}

fn crc_16_msb(b: u8, crc: i32) -> i32 {
    let mut data: i32 = b.into();
    let mut crc: i32 = crc.into();
    data <<= 8;
    for _i in 0..8 {
        if ((data ^ crc) & 0x8000) != 0 {
            crc = (0xFFFF) & ((crc << 1) ^ 0x8005);
        } else {
            crc = (0xFFFF) & (crc << 1);
        }
        data <<= 1;
    }
    crc
}

fn compute_checksum(val: &str) -> i32 {
    let mut calc = 0;
    let tail: &str = ";";
    let mut msg = String::from(val);
    msg.push_str(tail);
    let buffer: Vec<u8> = msg.into_bytes();
    let b_iter = buffer.into_iter();
    for i in b_iter {
        calc = crc_16_msb(i, calc);
    }

    calc
}

fn checksum_is_valid(msg: &str, checksum: &str) -> bool {
    if checksum.len() != 4 {
        return false;
    }
    format!("{:04X}", compute_checksum(msg) as u16) == checksum
}

impl SerialDevice for MyDevice {
    type Device = MyDevice;
    fn open(path: &str) -> Mutex<Self::Device> {
        let port = serialport::new(path, 115_200)
            .flow_control(FlowControl::None)
            .timeout(Duration::from_millis(5000))
            .open()
            .expect("Unable to open port device");

        Mutex::new(MyDevice { port })
    }

    const VID: u16 = 0x0483;
    const PID: u16 = 0x5740;
}

impl MyDevice {
    //Just acknowledge that command was received
    fn ack_call(&mut self, cmd: &[u8]) -> String {
        let _ = &self.port.write(cmd).expect("Write Failed");
        let mut buff: Vec<u8> = vec![0; 32];
        let _ = &self.port.read(buff.as_mut_slice()).expect("Failed to Ack");
        String::from_utf8(buff).unwrap().trim().to_owned()
    }

    //Parses Data value returned from the command
    fn data_call(&mut self, cmd: &[u8]) -> String {
        let _ = &self.port.write(cmd).expect("Write Failed");
        let mut buff: Vec<u8> = vec![0; 32];
        let _ = &self.port.read(buff.as_mut_slice()).expect("Failed to Ack");

        let read_buffer = String::from_utf8(buff).unwrap();
        let msg: Vec<&str> = read_buffer.split(";").collect();
        let checksum = msg[1].trim();

        if !checksum_is_valid(msg[0], checksum) {
            return String::from("Invalid Checksum");
        }

        let info: Vec<&str> = msg[0].split(",").collect();

        // returns specific data
        String::from(info[3])
    }

    pub fn led_on(&mut self) -> String {
        let cmd = "LED,1".as_bytes();
        self.ack_call(cmd)
    }

    pub fn led_off(&mut self) -> String {
        let cmd = "LED,0".as_bytes();
        self.ack_call(cmd)
    }

    pub fn get_param(&mut self, param: Parameter) -> String {
        let cmd = String::from("GET,") + &param.as_string();
        let cmd_buff = cmd.as_bytes();
        self.data_call(cmd_buff)
    }

    //only sets param temporarily
    fn set_param(&mut self, param: Parameter, value: String) -> String {
        if param.is_valid(&value) {
            let cmd = String::from("SET,") + &param.as_string() + &value;
            let cmd_buff = cmd.as_bytes();
            self.data_call(cmd_buff)
        } else {
            String::from("Invalid Parameter")
        }
    }

    //Save all set NV parameters
    fn save_params(&mut self) -> String {
        let cmd = "CAL,1,1".as_bytes();
        self.ack_call(cmd)
    }

    //Sets and Saves new parameter value
    pub fn update_param(&mut self, param: Parameter, value: String) -> String {
        self.set_param(param, value);
        self.save_params()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checksum_is_deterministic() {
        assert_eq!(compute_checksum("LED,1"), compute_checksum("LED,1"));
    }

    #[test]
    fn checksum_roundtrip() {
        let msg = "LED,1";
        let hex = format!("{:04X}", compute_checksum(msg) as u16);
        assert!(checksum_is_valid(msg, &hex));
    }

    #[test]
    fn checksum_rejects_wrong_value() {
        assert!(!checksum_is_valid("LED,1", "0000"));
    }

    #[test]
    fn checksum_rejects_wrong_length() {
        assert!(!checksum_is_valid("LED,1", "ABC"));
        assert!(!checksum_is_valid("LED,1", "ABCDE"));
    }
}
