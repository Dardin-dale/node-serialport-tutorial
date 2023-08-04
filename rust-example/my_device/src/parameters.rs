use regex::Regex;


pub enum Parameter {
    SerNumber,
    LedDrive,
}

impl Parameter {

    pub fn as_str(&self) -> &str {
        match &self{
            Parameter::SerNumber => "SER_NUMBER",
            Parameter::LedDrive => "LED_DRIVE",
        }
    }

    pub fn as_string(&self) -> String {
        match &self{
            Parameter::SerNumber => String::from("SER_NUMBER"),
            Parameter::LedDrive => String::from("LED_DRIVE"),
        }
    }
    
    pub fn as_int(&self) -> u8 {
        match &self{
            Parameter::SerNumber => 0,
            Parameter::LedDrive => 9,
        }
    }

    ///validates a value for a given parameter value
    pub fn is_valid(&self, value: &str) -> bool {
        match &self{
            Parameter::SerNumber => {
                let re = Regex::new("[0-9a-zA-Z]{12}").unwrap();
                re.is_match(value)
            },
            Parameter::LedDrive => {
                let val = value.parse::<i32>().unwrap();
                0 <= val && val <= 255
            },
        }
    }
}
