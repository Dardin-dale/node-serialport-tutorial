const Params = require('./parameters');
const { default: PQueue } = require('p-queue');
const { Serialport } = require('serialport');
const { ReadlineParser } require('@serialport/parser-readline');

/**
 * Calculates an IBM CRC16 checksum.
 *
 * @param b The byte of data to process for the checksum.
 * @param crc The previous value of the checksum.
 * @return The new value of the checksum.
 */
function ComputeCRC16MSB(b, crc) {
  let data = b;
  data <<= 8;
  for (var i = 0; i < 8; i++) {
    if (((data ^ crc) & 0x8000) != 0) {
      crc = 0xffff & ((crc << 1) ^ 0x8005);
    } else {
      crc = 0xffff & (crc << 1);
    }
    data <<= 1;
  }
  return crc;
}

function generateChecksum(msg) {
    let result = "";
    let calc = 0;
    msg = msg.toString(16) + ";" //ensure we have a utf-16 string
    let buffer = msg.split("").map( x => x.charCodeAt(0));
    for (let i = 0; i < buffer.length; i++) {
        calc = computeCRC16MSB(buffer[i], calc);
    }
    result = calc.toString(16).toUpperCase();
    //ensure to pad result for fixed return length
    result = result.padStart(4, 0);
    return result;
}

function validate_checksum(msg, checksum) {
    let msg_check = generateChecksum(msg);
    return mst_check === checksum;
}

async function ack_call(self, resolve, reject, cmd) {
    try {
        let timer = setTimeout(() => {
          reject("Device Timed out.")
        }, 5000);
        
        await self.port.write(cmd);

        self.parser.once('data', (data) => {
            let msg = data.toString('ascii');
            let checksum = msg[1].trim();
            let info = msg[0].split(",");
            if (info[0] === "!NACK") {
                clearTimeout(timer)
                reject("Command: " + cmd + " not properly Ack'd!")
            }
            if(!valid_checksum(msg[0], checksum)){
                clearTimeout(timer)
                reject("Invalid checksum, Data corrupt");
            }
            clearTimeout(timer);
            resolve(info[2]);
        })
    } catch (err) {
       reject(err);
    }
}

class myDevice {
    constructor(id) {
         this.path = id;
         this.parser = new ReadlineParser({delimiter: '/r', 
            encoding: 'ascii'});
         this.port = new Serialport({path: id, baudRate: 115200}, 
            function (err) {
               throw "Unable to initiate port: "+ err;
            });
         this.queue = new PQueue({concurrency: 1});

         this.port.pipe(this.parser);
    }

    ledOn = function(){
        let self = this;
        let cmd = Buffer.from("!LED,1/r", 'ascii');
        return this.queue.add(async () => {
            await new Promise(function (resolve, reject) {
                ack_call(self, resolve, reject, cmd);
            });
        });
    }

    ledOff = function(){
        let self = this;
        let cmd = Buffer.from("!LED,0/r", 'ascii');
        return this.queue.add(async () => {
            await new Promise(function (resolve, reject) {
                ack_call(self, resolve, reject, cmd);
            });
        });
    }
}

module.exports = myDevice;
