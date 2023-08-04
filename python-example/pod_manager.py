'''
This Module is to rapidly develop tkinter guis for the TrakPod

hopefully this extracts a lot of the core read/writes

'''
import sys
import time
import serial
import serial.tools.list_ports
from threading import Thread, Lock
from tkinter import *
from tkinter.messagebox import *
from tkinter import ttk
from tkinter.filedialog import askdirectory
from tkscrolledframe import ScrolledFrame


params = ['SERIAL NUMBER','LED POWER']

class MyDevice:
    def __init__(self, port, out = sys.stdout):
        self.path = port
        self.out = out
        self.lock = Lock()
        self.port = serial.Serial(port)
        self.port.baudrate = 115200
        self.port.bytesize = 8
        self.port.parity = 'N'
        self.port.stopbits = 1
        self.sn = self.get_param(0)
        self.fw = self.get_FW_version()

    #designed to be used with tkinter frame
    def _print(self, msg):
        self.out.configure(state=NORMAL)
        self.out.insert(END, str(chr(10)+chr(10)))
        self.out.insert(END, msg.split(';')[0])
        self.out.see(END)
        self.out.configure(state=DISABLED)

    def _ack_call(self, cmd):
        with self.lock:
            self.port.write(cmd)
            msgout = str(self.port.read_until(bytes("\r","ascii"))).strip("b'").replace("\\r",chr(10))
            self._print(msgout)
            ack = msgout.split(',')[0]
            return ack == "!ACK"

    def _data_call(self, cmd):
        with self.lock:
            self.port.write(cmd)
            msgout = str(self.port.read_until(bytes("\r","ascii"))).strip("b'").replace("\\r",chr(10))
            self._print(msgout)
            return msgout.split(";")[0].split(',')[3]

    def _multi_receive(self, cmd, expected):
        with self.lock:
            self.port.write(cmd)
            result = []
            msgout = str(self.port.read_until(bytes("\r","ascii"))).strip("b'").replace("\\r",chr(10))
            head = msgout.split(';')[0]
            while head != "!STATUS,IDLE":
                self._print(msgout)
                if head.split(',')[0] == expected:
                    result.append(head)
                msgout = str(self.port.read_until(bytes("\r","ascii"))).strip("b'").replace("\\r",chr(10))
                head = msgout.split(';')[0]
            return result

    def led_on(self): 
        cmd = bytearray(b'LED,1\r')
        return self._ack_call(cmd)
    
    def led_off(self):
        cmd = bytearray(b'LED,0\r')
        return self._ack_call(cmd)

    def get_param(self, param):
        cmd = bytearray(bytes("GET," + str(param) + "\r\n","ascii"))
        return self._data_call(cmd)

    def _set_param(self, param, value):
        cmd = bytearray(bytes("SET,", "ascii") + bytes(str(str(param) + "," + str(value)), "ascii") + bytes("\r\n", "ascii"))
        return self._data_call(cmd)

    def save_params(self):
        cmd = bytearray(b'CAL,1,1\r')
        return self._ack_call(cmd)

    def update_param(self, param, value):
        msg = self._set_param(param, value)
        saved = self.save_params()
        return [msg, saved]
        
    
class Device_Manager:
    def __init__(self, onChange, out = sys.stdout):
        self.pods = {"--No Pods Available--": dict(path="--No Pods Available--", sn="None")}
        self.out = out
        self.interval = 0.5 #0.5 second thread interval
        self.onChange = onChange
        thread = Thread(target=self._run)
        thread.daemon = True
        thread.start()
        

    def _isPod(self, portInfo):
        return portInfo.vid == 0x0483 and portInfo.pid == 0x5740

    def _run(self):
        while True:
            hasChanged = False
            ports = serial.tools.list_ports.comports()
            ports = filter(self._isPod, ports)
            pods = {}
            for port in ports:
                if not port.device in self.pods:
                    pod = MyDevice(port.device, self.out)
                    pods[port.device] = pod
                    hasChanged = True
                else:
                    pods[port.device] = self.pods[port.device]
            
            for port in list(self.pods):
                if not port in pods:
                    pod = self.pods.pop(port)
                    if isinstance(pod, MyDevice):
                        """ pod.port.close() """
                        hasChanged = True

            if len(pods) == 0 and "--No Pods Available--" not in self.pods:
                pods["--No Pods Available--"] = dict(path="--No Pods Available--", sn="None")
            if(hasChanged):
                self.pods = pods
                self.onChange(pods)
            time.sleep(self.interval)
    
    def _write(self, msg):
        self.out.configure(state=NORMAL)
        self.out.insert(END, str(chr(10)+chr(10)))
        self.out.insert(END, msg)
        self.out.see(END)
        self.out.configure(state=DISABLED)

    def getPod(self, port):
        return self.pods[port]