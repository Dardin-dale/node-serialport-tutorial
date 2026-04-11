export default {
    SERIAL_NUMBER: 0,
    isValid(param, value) {
        switch (param) {
            case 'SERIAL_NUMBER':
                return typeof value === 'string' && value.length < 32;
            default:
                return false;
        }
    }
};
