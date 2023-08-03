This tutorial for anyone who: 

- Wants to use JavaScript to make a rich UI for their embedded device
- Wants to better understand serialport communication
- Needs a daily dose of [Atwood's Law](https://www.google.com/search?q=atwood%27s+law&oq=at&aqs=chrome.0.69i59j69i57j69i59j69i57l2j69i61l3.4980j0j1&sourceid=chrome&ie=UTF-8)

or 
- Anyone like myself who has inherited an embedded device project and needs a working understanding of how to build or maintain a project that uses serialport communication. 

We will go through the setup and usage of the node [serialport library](https://serialport.io/) and ways to integrate your embedded device into a JavaScript application. Many of the same principles apply in other languages. I'll break this into several parts: 

1. Defining your Device's Interface/retrieving data
2. Connecting to multiple devices using a Device Manager Class
3. Plug 'n Play with our Device Manager and setAsyncInterval

The data structures above will lend a serialport RS-232 style device to behave in a 'Plug 'n Play' manner and hopefully avoid the common pitfalls that you can run into with serialport communication. By 'Plug 'n Play' I mean that a device can be connected/disconnected at will by the end user without causing errors.

The JavaScript solution to device handling revolves around promise queueing singletons where other languages might use a threadpool. 

Note: I'll be using CommonJS syntax, this effects the version of some of the dependencies used.

## Background:
 
Advanced users skip to Method. Here I describe serialports in general and use cases for this tutorial.

![Serial Port Cable](https://dev-to-uploads.s3.amazonaws.com/uploads/articles/37l0djc4dz5d1v09jzzl.jpg)

Serialports are often used to link external hardware devices. Many of these devices are now USB connected devices. However, many companies and developers choose to use RS-232 emulation (Think those old 9-pin connectors that screw onto your PC). RS-232 is backwards compatible and enables you to connect to the device without having to maintain a driver for your embedded device.

If you are a web developer, Serialports are most analogous to a TCP/IP socket connection, you utilize a transform stream to connect and write/read data in a buffer.

A common issue with this RS-232 style communication is that your device does not emit a 'disconnection' event since RS-232 9-pin connectors were not designed to be fully Plug 'n Play. We'll cover this in more detail and mitigation strategies in a later tutorial.

## Method

We'll assume that you have a NodeJS project started. We'll make a directory for our device module in the terminal.

If you are using a framework like Electron, you will want to make sure that this module is called from the backend 'main' process and not the 'renderer' process since serialport relies on having direct access to the device via Node. 

```
mkdir device
cd device
```
from there we'll create the following:

```
touch DeviceManager.js
mkdir myDevice
cd myDevice
touch index.js parameters.js
```

This should give you the following Tree Structure:

![File Tree](https://dev-to-uploads.s3.amazonaws.com/uploads/articles/4e9diqhwlt7nz2s6j7b9.png)
 
We'll begin with parameters.js. This is where you should keep a record of all of the non-volatile parameters for your embedded device as well as a validator for the parameters that can be stored and saved to your device.

Non-Volatile parameters are settings/variables that are stored on your device that will persist between power cycles. The validator should ensure that any value passed from our node application is acceptable before we send it to the device. Below is a rough sketch of what your parameters should look like:

`parameters.js`

```javascript
module.exports = {
    'SerialNumber': 0,
    'Param1': 1,
    'Param2': 2,
    .
    .
    .
    validateParam: (value, param) => { //bool
        switch (param) {
            case 'SerialNumber':
               return typeof value === 'String'
               break;
            .
            .
            .
            default:
              throw param + " Is an invalid parameter!"
        }
    }

}
```

Next we'll move on to index.js in /myDevice to instantiate the serialport and define our communication strategy.

Add the following dependencies to our NodeJS project:

`yarn add serialport p-queue@6.6.2`

Note: we are using v6.x.x of p-queue for CommonJS, ESM will require transpilation which is beyond our scope. The Node Serialport library is a native library, historically transpiling native libraries was not well supported. It does appear that serialport v10.x.x+ supports ESM. You may need to add an exclusion to your rollup/webpack configuration if transpilation doesn't work.

We'll import these packages as well as the parameters that we listed earlier.

`index.js`

```javascript
const Params = require('./parameters')
const { default: PQueue } = require('p-queue')
const { Serialport } = require('serialport')
const { ReadlineParser } require('@serialport/parser-readline')
```

What are each of these doing? Serialport is going to be the connection to our device and represent the transform stream that we read/write. The ReadlineParser defines how we will get and send information in our buffer i.e. how messages will get parsed from our device. 

PQueue, the "P" stands for `Promise`. We won't know how long different requests to our device will take, and our serialport can only handle one request at a time. We'll need to queue each request to the device as a promise. This asynchronous workflow should also prevent our application from hanging while we wait for the device to respond.

### Defining our device interface

let's initiate our device class using the device identifier. This is the id used by our operating system to recognize the connection. This should be a path string, for example:

 - Windows: "COM15" 
 - Linux: "dev/ttyS0"

We want to open the port, pipe in the readline parser and instantiate our promise queue.

`index.js`

```javascript
class myDevice () {
    constructor(id) {
         this.path = id;
         this.parser = new ReadlineParser({delimiter: '\r', 
            encoding: 'ascii'});
         this.port = new Serialport({path: id, baudRate: 115200}, 
            function (err) {
               throw "Unable to initiate port: "+ err;
            });
         this.queue = new PQueue({concurrency: 1});

         this.port.pipe(this.parser);
    }
}
```
 
The Baud Rate is the agreed upon speed for communications with our device. The delimiter '\r' is a carriage return character often denoted \<CR>, and for our example only ASCII encoded characters will be passed to/from our device. Messages will be parsed from the device after the parser recognizes that carriage return. We also ensure that only one command can be processed at a time with our promise queue by specifying a concurrency of 1.

We'll assume our example device accepts and sends the following command structure:

`![CMD],param1,param2,...;<CR>`

and the device will respond:

`!ACK,[response];[checksum]<CR>` or if more data is needed
`![CMD],[response];[checksum]<CR>` ... `!STATUS,IDLE;`

!ACK is the device acknowledging the request, a !NACK response indicates that the device request was invalid.

To reiterate, there are multiple response types from our device that we can receive:

1. Acknowledgement of the request (no specific data returned)
2. Data retrieval (acknowledgement with data to parse)
3. Multiple data per request. (extra credit)

For testing and debugging, I would ensure that the device always at least sends an acknowledgement that a request was received.

Let's look at the following example command:

`!LED,1<CR>`  -- Turn the LED On

Let's send this command to our device. For this command we'll only want to send the data to the device and receive the acknowledgement that the command was sent. Ideally, we can ensure that this command works by lighting up a peripheral LED attached to our microcontroller.

Before we can send this to the device we need to convert this command to serialized bytes that we can pass to our serialport stream. example:

`index.js`
```javascript
class myDevice {
    .
    .
    .
  ledOn() {
      let self = this;
      let cmd = Buffer.from("!LED,1\r", 'ascii');
      return this.queue.add(
          new Promise((resolve, reject) => {
              ack_call(self, resolve, reject, cmd);
          })
      );
   }
}
``` 

This can look a bit confusing... or A lot confusing. Essentially, we are parsing the command into bytes, then we are adding a new promise to the queue. This method also returns a promise, so we'll need to be careful how we handle this call in the device manager in part 2. Also, we are explicitly creating a new promise instead of using async/await so that we can handle resolve/reject in a variety of ways in our `ack_call()` function.

Our ack_call can be a private function outside of our class since it will never be consumed outside of our class scope. This is where we will actually read/write to the serialport.

`index.js`
```javascript
async function ack_call(self, resolve, reject, cmd) {
    try {
        // write to the port, await write to complete
        self.port.write(cmd, function(err) {
             if(err) reject(err);
        });
        // Await response from the port
        self.parser.on('data', (data) => {
            let msg = data.toString('ascii');
            let info = msg.split(",");
            if (info[0] === "!NACK") {
                reject("Command: " + cmd + " not properly Ack'd!")
            }
            resolve(msg);
        }
    } catch (err) {
       reject(err);
    }
}
```

Great! If we call `myDevice.ledOn()` our LED lights up! 

As a bonus challenge try to add a `ledOff()` and a `flashNtimes` method to our device interface. Flashing will use the led on/off methods with a timed delay between the two.

Now we want to actually retrieve specific information and parse the data that comes back from the device. In our `ack_call` function we don't really care what the returned value is for ACK calls so we can just add to our existing function. A simple GET function might look as follows:

`index.js`
```javascript
class myDevice() {
    .
    .
    .
    getParam(param) {
        let self = this;
        let cmd = Buffer.from("!GET," + param + "\r", 'ascii');
        return this.queue.add(
             new Promise((resolve, reject) => {
                ack_call(self, resolve, reject, cmd);
            })
        );
    }
}
```

Now we parse the returning data:

`index.js`
```javascript
async function ack_call(self, resolve, reject, cmd) {
    try {
        self.port.write(cmd, function(err) {
             if(err) reject(err);
        });
        self.parser.on('data', (data) => {
            let msg = data.toString('ascii');
            //lets grab the checksum now
            let checksum = msg[1].trim();
            let info = msg[0].split(",");
            if (info[0] === "!NACK") {
                reject("Command: " + cmd + " not properly Ack'd!")
            }
            // validate our message
            if(!valid_checksum(msg[0], checksum)){
                reject("Invalid checksum, Data corrupt");
            }
            // data from device: !ACK,CMD,VALUE
            resolve(info[2]);
        }
    } catch (err) {
       reject(err);
    }
}
```

What is this checksum and how do we validate it?

Many serial devices will implement a checksum return in case the data gets malformed in either the device or the stream. The checksum is the message passed through a simple hashing function. We can verify the integrity of the data that is passed from the device by implementing the hash and then comparing the message hash to the checksum received. Your device's firmware should dictate which checksum formula is used. There are libraries available for the common CRC (Cyclic Redundancy Check) functions. The CRC algorithms are typically lighter than hash algorithms like SHA-256 and easier to implement on an embedded device. For this example, we'll assume we have a `computeCRC16MSB` function for an IBM CRC16 function. Its implementation will be provided in the linked source code.

`index.js`
```javascript
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
```

Now that we have ensured that our messages are complete and valid as confirmed by our firmware. But what if our device doesn't return any data at all? Oh no! Our entire function hangs until we resolve that our `on('data')` listener triggers. If no data returns we'll be stuck and none of our queued requests to the device will resolve. Let's mitigate this by adding a timeout to reject our promise in this situation.

`index.js`
```javascript
async function ack_call(self, resolve, reject, cmd) {
    try {
        //create our timeout
        let timer = setTimeout(() => {
          reject("Device Timed out.")
        }, 5000);
        self.port.write(cmd, function(err) {
             if(err) reject(err);
        });
        self.parser.on('data', (data) => {
            let msg = data.toString('ascii');
            let checksum = msg[1].trim();
            let info = msg[0].split(",");
            if (info[0] === "!NACK") {
                //clear timeout where we resolve/reject
                clearTimeout(timer)
                reject("Command: " + cmd + " not properly Ack'd!")
            }
            if(!valid_checksum(msg[0], checksum)){
                clearTimeout(timer)
                reject("Invalid checksum, Data corrupt");
            }
            clearTimeout(timer);
            resolve(info[2]);
        }
    } catch (err) {
       reject(err);
    }
}
```

We've given the data call a very generous 5 seconds to respond. Timeouts will depend on your device and the complexity of the request that is made. I would recommend clocking the response times for your device and adjusting for a 6 sigma or as low as 95% response times for your device in a probability distribution.

Now we've really taken a belt and suspenders to our device communication. Let's test and grab all 20 or so non volatile parameters from our device!

```
MaxListenersExceededWarning: Possible EventEmitter memory leak
detected. 11 exit listeners added. Use emitter.setMaxListeners()
to increase limit
```

![Image description](https://dev-to-uploads.s3.amazonaws.com/uploads/articles/xbg7dvyjqcezoclms263.png)

Whoops! Let's see, we could follow it's suggestion and increase the number of listeners; we only have 20 parameters to grab. But, every time we make an `ack_call` we are making a new event listener. The serialport docs only mention an "on" method for the parser. So what do we do? Well, we know that the parser is a transform stream and an EventEmitter. What other methods can we use? This is where the [Node docs](https://nodejs.org/api/events.html) are our friend.

What we want is a single use listener for the `'data'` event. We read the Node docs and find a `.once()` EventEmitter method. This returns a one time event listener. Great! This is exactly what our function needs. So, we'll just change `.on('data')` to `.once('data')` to create a one-time event listener.

With our data listener's handled we no longer have any stumbling blocks. We run our tests and are able to handle 1000+ requests from our devices without fail. We then set up a test to hammer the devices over the weekend....

![Image description](https://dev-to-uploads.s3.amazonaws.com/uploads/articles/z1h20rwbvcx6b97m0j34.png)

Alas, one last error to contend with. Digging through the [serialport documentation](https://serialport.io/docs/api-stream) we find that not all errors (particularly write errors) are passed in our error callbacks but can also be passed through an `'error'` event for the stream. Adding an error event handler in this case is necessary. However, we do not expect this error to trigger so we must be careful to remove the listener before we resolve our promise.

Our final `ack_call` function should look like this:

`index.js`
```javascript
async function ack_call(self, resolve, reject, cmd) {
    try {
        self.port.once('error', err => reject(err))
        let timer = setTimeout(() => {
          self.port.removeAllListeners('error')
          reject("Device Timed out.")
        }, 5000);
        self.port.write(cmd, function(err) {
             if(err) {
                 self.port.removeAllListeners('error')
                 reject(err)
             }
        });
        self.parser.once('data', (data) => {
            let msg = data.toString('ascii')
            let checksum = msg[1].trim()
            let info = msg[0].split(",")
            if (info[0] === "!NACK") {
                clearTimeout(timer)
                self.port.removeAllListeners('error')
                reject("Command: " + cmd + " not properly Ack'd!")
            }
            if(!valid_checksum(msg[0], checksum)){
                clearTimeout(timer)
                self.port.removeAllListeners('error')
                reject("Invalid checksum, Data corrupt");
            }
            clearTimeout(timer)
            self.port.removeAllListeners('error')
            resolve(info[2])
        }
    } catch (err) {
       reject(err)
    }
}
```

Finally, We can turn the LED on and off and retrieve data back from our device! 'Set' commands should be able to use our `ack_call` function. However, setting parameters on embedded devices does not necessarily save them in non-volatile memory. Non-volatile memory on embedded devices will typically require a separate call to save the changes made from a 'Set' command. I would add an `saveParam` method that uses our `ack_call` function. In the next part, I'll cover an `updateParam` method that chains our 'Set' and 'Save' methods.

As a bonus we can think about calls to our device that will return multiple values per request. In this case we can start with our `ack_call` function and collect our results in an array or pass the results directly to a database. To resolve the promise in our function we'd need to wait for the device to return a 'STOP' or 'IDLE' return value. The `removeAllListeners` event method might come in clutch since we'd want to use `.on('data')` instead of `.once('data')`.

Part 2 will cover creating a DeviceManager class to collect multiple devices and consuming the device interface that we've created.

Happy Coding!
