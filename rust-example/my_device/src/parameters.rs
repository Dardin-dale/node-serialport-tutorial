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
            Parameter::SerNumber => value.len() < 32,
            Parameter::LedDrive => {
                value.parse::<i32>().map_or(false, |v| (0..=255).contains(&v))
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ser_number_accepts_short_strings() {
        assert!(Parameter::SerNumber.is_valid("DEMO_1"));
        assert!(Parameter::SerNumber.is_valid(""));
    }

    #[test]
    fn ser_number_rejects_long_strings() {
        let too_long = "X".repeat(32);
        assert!(!Parameter::SerNumber.is_valid(&too_long));
    }

    #[test]
    fn led_drive_accepts_valid_range() {
        assert!(Parameter::LedDrive.is_valid("0"));
        assert!(Parameter::LedDrive.is_valid("128"));
        assert!(Parameter::LedDrive.is_valid("255"));
    }

    #[test]
    fn led_drive_rejects_out_of_range() {
        assert!(!Parameter::LedDrive.is_valid("-1"));
        assert!(!Parameter::LedDrive.is_valid("256"));
    }

    #[test]
    fn led_drive_does_not_panic_on_non_numeric() {
        assert!(!Parameter::LedDrive.is_valid("abc"));
        assert!(!Parameter::LedDrive.is_valid(""));
    }
}
